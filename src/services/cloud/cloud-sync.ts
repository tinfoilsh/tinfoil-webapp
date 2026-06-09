import { PAGINATION } from '@/config'
import {
  SYNC_ALL_CHATS_STATUS,
  SYNC_CHAT_STATUS,
  SYNC_PROJECT_CHAT_STATUS_PREFIX,
} from '@/constants/storage-keys'
import { logError, logInfo, logWarning } from '@/utils/error-handling'
import { chatEvents } from '../storage/chat-events'
import { deletedChatsTracker } from '../storage/deleted-chats-tracker'
import { indexedDBStorage, type StoredChat } from '../storage/indexed-db'
import { decideRecovery } from '../sync-enclave/enclave-error-recovery'
import { passkeyEvents } from '../sync-enclave/passkey-events'
import {
  keyCurrent,
  newIdempotencyKey,
  pull,
  registerKey,
  type PullItem,
} from '../sync-enclave/sync-api'
import { IF_MATCH_SENTINELS } from '../sync-enclave/wire-contract'
import {
  hasPrimaryKey,
  migrationKeys,
  primaryKeyIdHexOrNull,
  requirePrimaryKeyB64,
} from './cek-encoding'
import { processRemoteChat } from './chat-codec'
import { ingestRemoteChats, syncRemoteDeletions } from './chat-ingestion'
import { canWriteToCloud } from './cloud-key-authorization'
import {
  cloudStorage,
  type ChatSyncStatus,
  type UploadChatOptions,
} from './cloud-storage'
import { runLegacyBlobMigrationAndFinalize } from './legacy-blob-migration'
import { runLegacyChatEvictionIfNeeded } from './legacy-chat-eviction'
import { projectStorage } from './project-storage'
import { streamingTracker } from './streaming-tracker'
import { isUploadableChat } from './sync-predicates'
import { SyncStatusCache } from './sync-status-cache'
import { UploadCoalescer } from './upload-coalescer'

export interface SyncResult {
  uploaded: number
  downloaded: number
  errors: string[]
}

export interface PaginatedChatsResult {
  chats: StoredChat[]
  hasMore: boolean
  nextToken?: string
}

export interface SyncStatusResult {
  needsSync: boolean
  reason: 'no_changes' | 'count_changed' | 'updated' | 'local_changes' | 'error'
  remoteCount?: number
  remoteLastUpdated?: string | null
}

const UPLOAD_BASE_DELAY_MS = 1000
const UPLOAD_MAX_DELAY_MS = 8000
const UPLOAD_MAX_RETRIES = 3
const REMOTE_LIST_MAX_ATTEMPTS = 2
const KEY_ADOPTION_PROBE_LIMIT = 5

const isStreaming = (id: string) => streamingTracker.isStreaming(id)

export class CloudSyncService {
  private syncLock: Promise<void> | null = null
  private syncLockResolve: (() => void) | null = null
  private uploadCoalescer: UploadCoalescer
  private streamingCallbacks: Set<string> = new Set()
  /**
   * Set once per session after the first successful syncAllChats so
   * the enclave-driven legacy-blob migration (§8.7.2 trigger 1) runs
   * exactly once per app load. Re-running on every sync would cost a
   * round trip per scope with nothing left to do; the migration is
   * idempotent on the enclave side but the chatter is wasteful.
   */
  private legacyMigrationKicked = false
  private chatSyncCache = new SyncStatusCache<ChatSyncStatus>(SYNC_CHAT_STATUS)
  private allChatsSyncCache = new SyncStatusCache<ChatSyncStatus>(
    SYNC_ALL_CHATS_STATUS,
  )
  private projectSyncCaches = new Map<string, SyncStatusCache<ChatSyncStatus>>()

  constructor() {
    // Initialize upload coalescer with doBackupChat as the upload function
    this.uploadCoalescer = new UploadCoalescer(
      (chatId, idempotencyKey) => this.doBackupChat(chatId, idempotencyKey),
      {
        baseDelayMs: UPLOAD_BASE_DELAY_MS,
        maxDelayMs: UPLOAD_MAX_DELAY_MS,
        maxRetries: UPLOAD_MAX_RETRIES,
      },
    )
    // Listen for storage changes from other tabs to invalidate sync status cache
    if (typeof window !== 'undefined') {
      window.addEventListener('storage', (e) => {
        if (e.key === SYNC_CHAT_STATUS) {
          // Another tab updated sync status, invalidate our cache
          this.chatSyncCache.invalidate()
        } else if (e.key === SYNC_ALL_CHATS_STATUS) {
          this.allChatsSyncCache.invalidate()
        } else if (e.key?.startsWith(SYNC_PROJECT_CHAT_STATUS_PREFIX)) {
          // Another tab updated project sync status, invalidate that project's cache
          const projectId = e.key.slice(SYNC_PROJECT_CHAT_STATUS_PREFIX.length)
          const existingCache = this.projectSyncCaches.get(projectId)
          if (existingCache) {
            existingCache.invalidate()
          }
        }
      })
    }
  }

  private getProjectSyncCache(
    projectId: string,
  ): SyncStatusCache<ChatSyncStatus> {
    let cache = this.projectSyncCaches.get(projectId)
    if (!cache) {
      cache = new SyncStatusCache(SYNC_PROJECT_CHAT_STATUS_PREFIX + projectId)
      this.projectSyncCaches.set(projectId, cache)
    }
    return cache
  }

  /**
   * Execute a function with sync lock protection.
   * Only one sync operation can run at a time.
   * Throws if a sync is already in progress.
   */
  private async withSyncLock<T>(fn: () => Promise<T>): Promise<T> {
    // Check if sync is already in progress (atomic check)
    if (this.syncLock) {
      logInfo('[CloudSync] Sync already in progress, skipping', {
        component: 'CloudSync',
        action: 'withSyncLock',
      })
      throw new Error('Sync already in progress')
    }

    // Acquire lock
    let resolve: () => void
    this.syncLock = new Promise<void>((r) => {
      resolve = r
    })
    this.syncLockResolve = resolve!

    try {
      return await fn()
    } finally {
      // Release lock
      this.syncLock = null
      if (this.syncLockResolve) {
        this.syncLockResolve()
        this.syncLockResolve = null
      }
    }
  }

  /**
   * Check if sync is needed by comparing local and remote sync status.
   * @param projectId - Optional project ID. If provided, checks project chat sync status.
   */
  async checkSyncStatus(projectId?: string): Promise<SyncStatusResult> {
    if (!(await cloudStorage.isAuthenticated())) {
      return { needsSync: false, reason: 'no_changes' }
    }

    try {
      // First check if we have local unsynced changes
      const unsyncedChats = await indexedDBStorage.getUnsyncedChats()
      const chatsNeedingUpload = unsyncedChats.filter((chat) => {
        // Filter by project if specified
        if (projectId) {
          if (chat.projectId !== projectId) return false
        } else {
          // For regular chats, exclude project chats
          if (chat.projectId) return false
        }
        // Use centralized predicate for upload eligibility
        return isUploadableChat(chat, isStreaming)
      })

      if (chatsNeedingUpload.length > 0) {
        return {
          needsSync: true,
          reason: 'local_changes',
        }
      }

      // Fetch remote sync status
      const remoteStatus = projectId
        ? await projectStorage.getProjectChatsSyncStatus(projectId)
        : await cloudStorage.getChatSyncStatus()

      // Get cached status
      const cachedStatus = projectId
        ? this.getProjectSyncCache(projectId).load()
        : this.chatSyncCache.load()

      // If no cached status, we need a full sync
      if (!cachedStatus) {
        return {
          needsSync: true,
          reason: 'count_changed',
          remoteCount: remoteStatus.count,
          remoteLastUpdated: remoteStatus.lastUpdated,
        }
      }

      // Take a live snapshot of how many cloud-eligible chats are
      // actually on disk. The cached `count` records remote totals,
      // which is not a faithful view of what the user has locally —
      // a chat that 404s during decrypt, an eviction sweep, or even
      // an IndexedDB corruption can silently empty rows that the
      // remote tally still counts. When the live local count drops
      // below the snapshot we last persisted, the disk lost rows the
      // cache still believes are present and only a full pull can
      // bring them back.
      let localCount: number | null = null
      if (!projectId) {
        try {
          localCount = await indexedDBStorage.getCloudChatCount()
        } catch (countError) {
          // Best-effort: if the count read fails we fall back to the
          // pre-existing remote-only checks rather than turning every
          // sync into an unbounded full pull.
          logError(
            'Failed to read local chat count during sync status check',
            countError,
            {
              component: 'CloudSync',
              action: 'checkSyncStatus.localCount',
            },
          )
        }
      }

      logInfo('[CloudSync] checkSyncStatus comparing statuses', {
        component: 'CloudSync',
        action: 'checkSyncStatus.compare',
        metadata: {
          projectId,
          remoteCount: remoteStatus.count,
          cachedCount: cachedStatus.count,
          remoteLastUpdated: remoteStatus.lastUpdated,
          cachedLastUpdated: cachedStatus.lastUpdated,
          localCount,
          cachedLocalCount: cachedStatus.localCount ?? null,
        },
      })

      // Compare count
      if (remoteStatus.count !== cachedStatus.count) {
        return {
          needsSync: true,
          reason: 'count_changed',
          remoteCount: remoteStatus.count,
          remoteLastUpdated: remoteStatus.lastUpdated,
        }
      }

      // Compare lastUpdated timestamps
      if (remoteStatus.lastUpdated !== cachedStatus.lastUpdated) {
        return {
          needsSync: true,
          reason: 'updated',
          remoteCount: remoteStatus.count,
          remoteLastUpdated: remoteStatus.lastUpdated,
        }
      }

      // Detect the disk-lost-rows case last so the more precise
      // remote-side signals above win when both fire on the same
      // tick. Only meaningful once a prior sync has captured the
      // baseline `localCount`; older cached entries (no field) keep
      // the legacy behaviour.
      if (
        localCount !== null &&
        cachedStatus.localCount !== undefined &&
        localCount < cachedStatus.localCount
      ) {
        return {
          needsSync: true,
          reason: 'count_changed',
          remoteCount: remoteStatus.count,
          remoteLastUpdated: remoteStatus.lastUpdated,
        }
      }

      // No changes detected
      return {
        needsSync: false,
        reason: 'no_changes',
        remoteCount: remoteStatus.count,
        remoteLastUpdated: remoteStatus.lastUpdated,
      }
    } catch (error) {
      logError('Failed to check sync status', error, {
        component: 'CloudSync',
        action: 'checkSyncStatus',
        metadata: { projectId },
      })
      return { needsSync: true, reason: 'error' }
    }
  }

  /**
   * Detect and apply cross-scope changes (chats moving between projects or becoming unassigned).
   * Uses the unscoped all-updated-since endpoint to find chats whose projectId changed.
   */
  private async syncCrossScope(result: SyncResult): Promise<void> {
    try {
      const cachedAllStatus = this.allChatsSyncCache.load()

      const remoteAllStatus = await cloudStorage.getAllChatsSyncStatus()

      // If nothing changed globally, skip
      if (
        cachedAllStatus &&
        remoteAllStatus.count === cachedAllStatus.count &&
        remoteAllStatus.lastUpdated === cachedAllStatus.lastUpdated
      ) {
        this.allChatsSyncCache.save(remoteAllStatus)
        return
      }

      // If we have no cached status, save current and return (first run baseline)
      if (!cachedAllStatus?.lastUpdated) {
        this.allChatsSyncCache.save(remoteAllStatus)
        return
      }

      const changedIds: string[] = []
      let continuationToken: string | undefined
      let totalProcessed = 0

      do {
        const allUpdated = await cloudStorage.getAllChatsUpdatedSince({
          since: cachedAllStatus.lastUpdated,
          continuationToken,
        })

        const remoteChats = allUpdated.conversations || []
        if (remoteChats.length === 0) break

        totalProcessed += remoteChats.length

        for (const remoteChat of remoteChats) {
          const localChat = await indexedDBStorage.getChat(remoteChat.id)

          const remoteProjectId = remoteChat.projectId ?? undefined
          const localProjectId = localChat?.projectId ?? undefined

          if (localChat && remoteProjectId !== localProjectId) {
            // Project assignment changed — update local state
            await indexedDBStorage.applyRemoteChatProject(
              remoteChat.id,
              remoteChat.projectId ?? null,
            )
            changedIds.push(remoteChat.id)
          } else if (!localChat && remoteChat.content) {
            // New chat we don't have locally — ingest it
            const ingestResult = await ingestRemoteChats([remoteChat], {
              fetchMissingContent: true,
              projectId: remoteChat.projectId ?? undefined,
            })
            result.downloaded += ingestResult.downloaded
            result.errors.push(...ingestResult.errors)
            changedIds.push(...ingestResult.savedIds)
          }
        }

        continuationToken = allUpdated.hasMore
          ? allUpdated.nextContinuationToken
          : undefined
      } while (continuationToken)

      if (totalProcessed > 0) {
        logInfo(`Cross-scope sync: processed ${totalProcessed} changed chats`, {
          component: 'CloudSync',
          action: 'syncCrossScope',
        })
      }

      if (changedIds.length > 0) {
        chatEvents.emit({ reason: 'sync', ids: changedIds })
      }

      this.allChatsSyncCache.save(remoteAllStatus)
    } catch (error) {
      logError('Failed to sync cross-scope changes', error, {
        component: 'CloudSync',
        action: 'syncCrossScope',
      })
    }
  }

  // Perform a delta sync - only fetch chats that changed since last sync
  async syncChangedChats(): Promise<SyncResult> {
    return this.withSyncLock(() => this.doSyncChangedChats())
  }

  private async doSyncChangedChats(): Promise<SyncResult> {
    const startedAt = Date.now()
    const result: SyncResult = {
      uploaded: 0,
      downloaded: 0,
      errors: [],
    }

    try {
      // Get cached sync status to determine what changed
      const cachedStatus = this.chatSyncCache.load()

      // Apply remote deletions BEFORE uploading local changes. If another
      // device deleted a chat, we must drop it locally first; otherwise
      // backupUnsyncedChats can re-upload a chat with pending edits and
      // resurrect it server-side.
      if (cachedStatus?.lastUpdated) {
        await syncRemoteDeletions(cachedStatus.lastUpdated, 'syncChangedChats')
      }

      // Backup any unsynced local changes
      const backupResult = await this.backupUnsyncedChats()
      result.uploaded = backupResult.uploaded
      result.errors.push(...backupResult.errors)

      if (!cachedStatus?.lastUpdated) {
        // No cached status, fall back to full sync (first page only)
        return await this.doSyncAllChats()
      }

      // Fetch chats updated since our last sync, paginating through all results
      let continuationToken: string | undefined
      let hasMore = true
      let isFirstPage = true

      while (hasMore) {
        let updatedChats
        try {
          updatedChats = await cloudStorage.getChatsUpdatedSince({
            since: cachedStatus.lastUpdated,
            includeContent: true,
            continuationToken,
          })
        } catch (error) {
          logError(
            'Failed to get updated chats, falling back to full sync',
            error,
            {
              component: 'CloudSync',
              action: 'syncChangedChats',
            },
          )
          return await this.doSyncAllChats()
        }

        const remoteConversations = updatedChats.conversations || []

        if (isFirstPage && remoteConversations.length === 0) {
          logInfo('No chats updated since last sync', {
            component: 'CloudSync',
            action: 'syncChangedChats',
            metadata: { since: cachedStatus.lastUpdated },
          })
          break
        }

        if (isFirstPage) {
          logInfo(`Syncing changed chats`, {
            component: 'CloudSync',
            action: 'syncChangedChats',
            metadata: {
              since: cachedStatus.lastUpdated,
              firstPageCount: remoteConversations.length,
              hasMore: updatedChats.hasMore,
            },
          })
        }
        isFirstPage = false

        const ingestResult = await ingestRemoteChats(remoteConversations, {
          fetchMissingContent: true,
        })
        result.downloaded += ingestResult.downloaded
        result.errors.push(...ingestResult.errors)

        hasMore =
          updatedChats.hasMore === true && !!updatedChats.nextContinuationToken
        continuationToken = updatedChats.nextContinuationToken
      }

      // Update cached sync status
      try {
        const newStatus = await cloudStorage.getChatSyncStatus()
        const localCount = await this.safeReadLocalChatCount()
        if (localCount !== null) {
          newStatus.localCount = localCount
        }
        this.chatSyncCache.save(newStatus)
      } catch (statusError) {
        logError('Failed to update sync status', statusError, {
          component: 'CloudSync',
          action: 'syncChangedChats',
        })
      }

      // Detect cross-scope moves (chats moving between projects)
      await this.syncCrossScope(result)
    } catch (error) {
      result.errors.push(
        `Sync failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }

    return result
  }

  // Clear cached sync status (useful when logging out or resetting)
  clearSyncStatus(): void {
    this.chatSyncCache.clear()
    this.allChatsSyncCache.clear()
    for (const cache of this.projectSyncCaches.values()) {
      cache.clear()
    }
    this.projectSyncCaches.clear()
    // `cloudSync` is a module-level singleton so this flag survives
    // logout → login on the same page load. Without the reset, the
    // second user's first syncAllChats would skip the legacy-blob
    // migration kickoff and their unsealed v0/v1 rows would never
    // migrate until the next page reload.
    this.legacyMigrationKicked = false
  }

  /**
   * Wipe every chat-scope sync-status cache (regular + per-project).
   * Used after a local eviction sweep so the next `smartSync` cannot
   * short-circuit on a stale `(count, lastUpdated)` snapshot and
   * leave the just-evicted rows missing on disk.
   */
  private invalidateChatSyncCaches(): void {
    this.chatSyncCache.clear()
    this.allChatsSyncCache.clear()
    for (const cache of this.projectSyncCaches.values()) {
      cache.clear()
    }
  }

  // Best-effort wrapper around the IndexedDB count so save sites can
  // record a localCount alongside the remote snapshot without turning
  // a count-read failure into a sync failure. Returns null when the
  // count is unavailable; callers omit the field in that case so the
  // next checkSyncStatus falls back to the remote-only comparison
  // rather than misreporting "disk is empty".
  private async safeReadLocalChatCount(): Promise<number | null> {
    try {
      return await indexedDBStorage.getCloudChatCount()
    } catch (error) {
      logError('Failed to read local chat count for sync cache', error, {
        component: 'CloudSync',
        action: 'safeReadLocalChatCount',
      })
      return null
    }
  }

  // Backup a single chat to the cloud with coalescing and retry
  async backupChat(chatId: string): Promise<void> {
    // Don't attempt backup if not authenticated
    if (!(await cloudStorage.isAuthenticated())) {
      return
    }

    if (!(await canWriteToCloud())) {
      return
    }

    // §9.6 R6 — local-only chats MUST NEVER enter the enclave write
    // path. Refuse the enqueue here so the user's opt-out is honored
    // even if a caller passes a local-only chat id by mistake.
    const chat = await indexedDBStorage.getChat(chatId)
    if (chat?.isLocalOnly) {
      logInfo('Skipping enqueue for local-only chat', {
        component: 'CloudSync',
        action: 'backupChat',
        metadata: { chatId },
      })
      return
    }

    // Use the upload coalescer - it handles:
    // - Coalescing rapid edits into a single upload
    // - Exponential backoff retry on failure
    // - Proper concurrency control per chat
    this.uploadCoalescer.enqueue(chatId)
  }

  /**
   * Wait for a specific chat's upload to complete.
   * Useful for testing and ensuring uploads complete before proceeding.
   */
  async waitForUpload(chatId: string): Promise<void> {
    await this.uploadCoalescer.waitForUpload(chatId)
  }

  /**
   * Wait for all pending uploads to complete.
   * Useful for testing and cleanup.
   */
  async waitForAllUploads(): Promise<void> {
    await this.uploadCoalescer.waitForAllUploads()
  }

  async backupChatNow(
    chatId: string,
    options: UploadChatOptions = {},
  ): Promise<void> {
    if (!(await cloudStorage.isAuthenticated())) {
      throw new Error('Authentication required for cloud sync')
    }

    if (!(await canWriteToCloud())) {
      throw new Error('Cloud sync key is not authorized')
    }

    if (streamingTracker.isStreaming(chatId)) {
      throw new Error('Cannot sync chat while it is streaming')
    }

    const chat = await indexedDBStorage.getChat(chatId)
    if (!chat) {
      throw new Error('Chat not found')
    }

    if (!isUploadableChat(chat, isStreaming)) {
      throw new Error('Chat is not eligible for cloud sync')
    }

    if (streamingTracker.isStreaming(chatId)) {
      throw new Error('Cannot sync chat while it is streaming')
    }

    const preUploadUpdatedAt = chat.updatedAt
    const preUploadVersion = chat.syncVersion ?? 0
    const { syncVersion, rewrites } = await cloudStorage.uploadChat(chat, {
      ...options,
      idempotencyKey: options.idempotencyKey ?? newIdempotencyKey(),
    })

    await indexedDBStorage.finalizeUpload({
      chatId,
      rewrites,
      preUploadUpdatedAt,
      syncVersion: syncVersion ?? preUploadVersion + 1,
    })
  }

  private async doBackupChat(
    chatId: string,
    idempotencyKey: string,
  ): Promise<void> {
    const startedAt = Date.now()
    try {
      if (!(await canWriteToCloud())) {
        return
      }

      // Check if chat is currently streaming
      if (streamingTracker.isStreaming(chatId)) {
        // Check if we already have a callback registered for this chat
        if (this.streamingCallbacks.has(chatId)) {
          logInfo('Streaming callback already registered for chat', {
            component: 'CloudSync',
            action: 'backupChat',
            metadata: { chatId },
          })
          return
        }

        logInfo('Chat is streaming, registering for sync after stream ends', {
          component: 'CloudSync',
          action: 'backupChat',
          metadata: { chatId },
        })

        // Mark that we have a callback registered
        this.streamingCallbacks.add(chatId)

        // Register to sync once streaming ends
        streamingTracker.onStreamEnd(chatId, () => {
          // Remove from tracking set
          this.streamingCallbacks.delete(chatId)

          logInfo('Streaming ended, triggering delayed sync', {
            component: 'CloudSync',
            action: 'backupChat',
            metadata: { chatId },
          })
          // Re-trigger the backup after streaming ends.
          // Errors are handled internally by the upload coalescer.
          this.backupChat(chatId)
        })

        return
      }

      const chat = await indexedDBStorage.getChat(chatId)
      if (!chat) {
        return // Chat might have been deleted
      }

      // Use centralized predicate for upload eligibility
      // Note: streaming is checked here AND after potential delay
      if (!isUploadableChat(chat, isStreaming)) {
        logInfo('Skipping sync for ineligible chat', {
          component: 'CloudSync',
          action: 'backupChat',
          metadata: {
            chatId,
            isBlankChat: chat.isBlankChat,
            isLocalOnly: chat.isLocalOnly,
            decryptionFailed: chat.decryptionFailed,
          },
        })
        return
      }

      // Double-check streaming status right before upload (in case it started during async ops)
      if (streamingTracker.isStreaming(chatId)) {
        logInfo('Chat started streaming during backup process, aborting sync', {
          component: 'CloudSync',
          action: 'backupChat',
          metadata: { chatId },
        })
        return
      }

      const preUploadUpdatedAt = chat.updatedAt
      const preUploadVersion = chat.syncVersion ?? 0
      const { syncVersion, rewrites } = await cloudStorage.uploadChat(chat, {
        idempotencyKey,
      })

      await indexedDBStorage.finalizeUpload({
        chatId,
        rewrites,
        preUploadUpdatedAt,
        syncVersion: syncVersion ?? preUploadVersion + 1,
      })
    } catch (error) {
      // Silently fail if no auth token set
      if (
        error instanceof Error &&
        error.message.includes('Authentication token not set')
      ) {
        return
      }
      // §9.6 R4 — surface the typed decision and ACT on the codes
      // that have a defined client-side recovery (§C5). For STALE_BLOB
      // / SYNC_CONFLICT, last-write-wins by pulling the remote and
      // replacing the local row so the chat exits `locallyModified`
      // and stops re-attempting. For STALE_KEY / UNKNOWN_KEY, fire
      // the rotation-check signal and abort without retrying. Other
      // codes still bubble up so the coalescer can retry where the
      // recovery table says transient.
      const decision = decideRecovery(error)
      logInfo('upload-chat recovery decision', {
        component: 'CloudSync',
        action: 'backupChat',
        metadata: {
          chatId,
          action: decision.action.type,
          code: decision.classification.code ?? null,
          kind: decision.classification.kind,
        },
      })
      if (decision.action.type === 'surface-conflict') {
        await this.resolveConflictByPullingRemote(chatId)
        return
      }
      if (decision.action.type === 'refresh-current-key-and-retry') {
        this.notifyKeyRefreshNeeded()
        return
      }
      if (decision.action.type === 'trigger-recovery-wizard') {
        this.notifyRecoveryNeeded()
        return
      }
      if (decision.action.type === 'block-all-sync') {
        this.notifyAttestationFailure()
        return
      }
      if (decision.action.type === 'surface-existing-data-under-other-key') {
        this.notifyExistingDataUnderOtherKey()
        return
      }
      if (decision.action.type === 'surface-not-found') {
        this.notifyChatNotFound(chatId)
        return
      }
      if (decision.action.type === 'migrate-legacy-and-retry') {
        this.notifyLegacyMigrationNeeded(decision.action.scope)
        return
      }
      if (decision.action.type === 'abort') {
        this.notifyUploadAborted(chatId, decision.action.reason)
        return
      }
      throw error
    }
  }

  /**
   * Last-write-wins conflict resolution (§C5). Pulls the remote chat
   * fresh from the enclave and overwrites the local copy, clearing
   * `locallyModified` so the chat exits the stuck-row retry loop. If
   * the pull itself fails, the chat stays `locallyModified` and the
   * next sync cycle will retry — but at least we are no longer
   * burning enclave calls in a tight retry storm.
   */
  private async resolveConflictByPullingRemote(chatId: string): Promise<void> {
    try {
      const result = await ingestRemoteChats([{ id: chatId }], {
        fetchMissingContent: true,
        eventReason: 'sync',
        forceOverwriteLocal: true,
      })
      logInfo('Conflict resolved by pulling remote', {
        component: 'CloudSync',
        action: 'resolveConflictByPullingRemote',
        metadata: { chatId, applied: result.savedIds.length > 0 },
      })
    } catch (err) {
      logError('Failed to resolve conflict by pulling remote', err, {
        component: 'CloudSync',
        action: 'resolveConflictByPullingRemote',
        metadata: { chatId },
      })
    }
  }

  private notifyKeyRefreshNeeded(): void {
    if (typeof window === 'undefined') return
    window.dispatchEvent(new CustomEvent('tinfoil:sync-key-refresh-needed'))
  }

  private notifyRecoveryNeeded(): void {
    if (typeof window === 'undefined') return
    window.dispatchEvent(new CustomEvent('tinfoil:sync-recovery-needed'))
  }

  private notifyAttestationFailure(): void {
    if (typeof window === 'undefined') return
    window.dispatchEvent(new CustomEvent('tinfoil:sync-attestation-failed'))
  }

  private notifyExistingDataUnderOtherKey(): void {
    if (typeof window === 'undefined') return
    window.dispatchEvent(
      new CustomEvent('tinfoil:sync-existing-data-under-other-key'),
    )
  }

  private notifyChatNotFound(chatId: string): void {
    if (typeof window === 'undefined') return
    window.dispatchEvent(
      new CustomEvent('tinfoil:sync-chat-not-found', { detail: { chatId } }),
    )
  }

  private notifyLegacyMigrationNeeded(scope?: string): void {
    if (typeof window === 'undefined') return
    window.dispatchEvent(
      new CustomEvent('tinfoil:sync-legacy-migration-needed', {
        detail: { scope },
      }),
    )
  }

  private notifyUploadAborted(
    chatId: string,
    reason: 'IDEMPOTENCY_CONFLICT' | 'FORBIDDEN' | 'UNKNOWN',
  ): void {
    if (typeof window === 'undefined') return
    window.dispatchEvent(
      new CustomEvent('tinfoil:sync-upload-aborted', {
        detail: { chatId, reason },
      }),
    )
  }

  // Backup all unsynced chats
  async backupUnsyncedChats(): Promise<SyncResult> {
    const result: SyncResult = {
      uploaded: 0,
      downloaded: 0,
      errors: [],
    }

    if (!(await canWriteToCloud())) {
      return result
    }

    try {
      const unsyncedChats = await indexedDBStorage.getUnsyncedChats()

      // Debug logging
      logInfo(`Found unsynced chats: ${unsyncedChats.length}`, {
        component: 'CloudSync',
        action: 'backupUnsyncedChats',
      })

      // Use centralized predicate for upload eligibility
      // Note: temp ID chats are allowed - uploadChat will generate server IDs for them
      // IMPORTANT: Never upload chats that failed to decrypt - they are placeholders with empty
      // messages that would overwrite real encrypted data on the server
      const chatsToSync = unsyncedChats.filter((chat) =>
        isUploadableChat(chat, isStreaming),
      )

      logInfo(`Chats with messages to sync: ${chatsToSync.length}`, {
        component: 'CloudSync',
        action: 'backupUnsyncedChats',
      })

      // Route each chat through the coalescer so periodic syncs share the
      // same per-chat serialization as save-triggered uploads.
      const uploadPromises = chatsToSync.map(async (chat) => {
        try {
          await this.uploadCoalescer.enqueueAndWait(chat.id)
          result.uploaded++
        } catch (error) {
          result.errors.push(
            `Failed to backup chat ${chat.id}: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      })

      await Promise.all(uploadPromises)
    } catch (error) {
      result.errors.push(
        `Failed to get unsynced chats: ${error instanceof Error ? error.message : String(error)}`,
      )
    }

    return result
  }

  // Sync all chats (upload local changes, download remote changes)
  async syncAllChats(options?: { deep?: boolean }): Promise<SyncResult> {
    return this.withSyncLock(() => this.doSyncAllChats(options))
  }

  private async listChatsWithRetry(options: {
    includeContent: boolean
    limit: number
    continuationToken?: string
  }) {
    let lastError: unknown

    for (let attempt = 1; attempt <= REMOTE_LIST_MAX_ATTEMPTS; attempt++) {
      try {
        return await cloudStorage.listChats(options)
      } catch (error) {
        lastError = error

        if (attempt < REMOTE_LIST_MAX_ATTEMPTS) {
          logWarning('Failed to list remote chats, retrying', {
            component: 'CloudSync',
            action: 'listChatsWithRetry',
            metadata: {
              attempt,
              maxAttempts: REMOTE_LIST_MAX_ATTEMPTS,
              error: error instanceof Error ? error.message : String(error),
            },
          })
        }
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }

  private async listProjectChatsWithRetry(
    projectId: string,
    options: { continuationToken?: string },
  ) {
    let lastError: unknown

    for (let attempt = 1; attempt <= REMOTE_LIST_MAX_ATTEMPTS; attempt++) {
      try {
        return await projectStorage.listProjectChats(projectId, options)
      } catch (error) {
        lastError = error

        if (attempt < REMOTE_LIST_MAX_ATTEMPTS) {
          logWarning('Failed to list project chats, retrying', {
            component: 'CloudSync',
            action: 'listProjectChatsWithRetry',
            metadata: {
              attempt,
              maxAttempts: REMOTE_LIST_MAX_ATTEMPTS,
              projectId,
              error: error instanceof Error ? error.message : String(error),
            },
          })
        }
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }

  private async doSyncAllChats(options?: {
    deep?: boolean
  }): Promise<SyncResult> {
    const deep = options?.deep ?? false
    const startedAt = Date.now()
    const result: SyncResult = {
      uploaded: 0,
      downloaded: 0,
      errors: [],
    }

    try {
      const cachedStatus = this.chatSyncCache.load()

      // Apply remote deletions BEFORE uploading local changes so a chat
      // deleted on another device is dropped locally first, instead of
      // getting re-uploaded by backupUnsyncedChats.
      if (cachedStatus?.lastUpdated) {
        await syncRemoteDeletions(cachedStatus.lastUpdated, 'syncAllChats')
      }

      // Backup any unsynced local changes
      const backupResult = await this.backupUnsyncedChats()
      result.uploaded = backupResult.uploaded
      result.errors.push(...backupResult.errors)

      // Then, get list of remote chats with content
      const remoteList = await this.listChatsWithRetry({
        includeContent: true,
        limit: PAGINATION.CHATS_PER_PAGE,
      })

      const remoteConversations = [...(remoteList.conversations || [])]

      // Only sync the first page - new chats always appear at the top
      // No need to fetch older chats every 15 seconds
      logInfo(`Syncing first page only (${remoteConversations.length} chats)`, {
        component: 'CloudSync',
        action: 'syncAllChats',
        metadata: {
          remoteIds: remoteConversations.map((c) => c.id).slice(0, 10),
          firstChatUpdatedAt: remoteConversations[0]?.updatedAt,
        },
      })

      const localChats = await indexedDBStorage.getAllChats()

      const localChatMap = new Map(localChats.map((c) => [c.id, c]))

      const ingestResult = await ingestRemoteChats(remoteConversations, {
        localChatMap,
        checkShouldIngest: true,
        fetchMissingContent: true,
      })
      result.downloaded += ingestResult.downloaded
      result.errors.push(...ingestResult.errors)

      // A deep sync (manual "Sync" action) keeps paging through the rest
      // of the remote history so older chats that predate this device's
      // local copy are pulled down too. Periodic and page-load syncs stay
      // first-page-only for bandwidth. Each page reuses the same
      // checkShouldIngest guard so locally-modified chats are never
      // clobbered.
      if (deep) {
        let continuationToken = remoteList.nextContinuationToken || undefined
        while (continuationToken) {
          const nextPage = await this.listChatsWithRetry({
            includeContent: true,
            limit: PAGINATION.CHATS_PER_PAGE,
            continuationToken,
          })
          const nextIngest = await ingestRemoteChats(
            [...(nextPage.conversations || [])],
            {
              localChatMap,
              checkShouldIngest: true,
              fetchMissingContent: true,
            },
          )
          result.downloaded += nextIngest.downloaded
          result.errors.push(...nextIngest.errors)
          continuationToken = nextPage.nextContinuationToken || undefined
        }
      }

      // Update cached sync status after successful sync
      try {
        const newStatus = await cloudStorage.getChatSyncStatus()
        const localCount = await this.safeReadLocalChatCount()
        if (localCount !== null) {
          newStatus.localCount = localCount
        }
        this.chatSyncCache.save(newStatus)
      } catch (statusError) {
        // Non-fatal: continue even if we can't update status
        logError('Failed to update sync status after full sync', statusError, {
          component: 'CloudSync',
          action: 'syncAllChats',
        })
      }

      // Detect cross-scope moves (chats moving between projects)
      await this.syncCrossScope(result)
      void this.kickLegacyBlobMigration()
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error))
    }

    return result
  }

  /**
   * Fire-and-forget the enclave-driven legacy-blob migration loop
   * (§8.7.2 trigger 1). The enclave does all unsealing + re-sealing
   * inside the TEE; the client only paginates and surfaces blocked
   * rows. Runs at most once per session — any subsequent foreground
   * trigger is a no-op on the enclave side anyway.
   */
  private async kickLegacyBlobMigration(): Promise<void> {
    if (this.legacyMigrationKicked) {
      return
    }
    // Don't consume the once-per-session latch until a primary CEK is
    // loaded. A keyless device can trigger a sync — and thus this
    // kick — before the key arrives (e.g. a v1→v2 user whose chats are
    // still locked behind passkey recovery). The migration throws
    // immediately without a key, so the enclave is never contacted;
    // latching here would permanently skip the real migration that
    // must run once the key is recovered, leaving the legacy rows
    // unsealed and the user's key unregistered on the controlplane.
    if (!hasPrimaryKey()) {
      return
    }
    // Only migrate once the local primary CEK is the controlplane's
    // registered current key. migrate-all re-seals every legacy row
    // under that CEK via Rewrap, which the controlplane rejects with
    // 409 stale key unless it is already the current key. A v1→v2 user
    // can hold a primary CEK locally (cached/recovered) before it has
    // been registered/recovered on the controlplane; kicking the
    // migration then drives a doomed rewrap loop against every row.
    // Don't latch on a mismatch or transient lookup failure so a later
    // sync retries once the recovery flow registers the key.
    let current: Awaited<ReturnType<typeof keyCurrent>>
    try {
      current = await keyCurrent()
    } catch (err) {
      logError('Legacy migration gate: current key lookup failed', err, {
        component: 'CloudSync',
        action: 'kickLegacyBlobMigration',
      })
      return
    }
    const localKeyId = await primaryKeyIdHexOrNull()
    let currentKeyId = current.key_id
    // A v1→v2 user can hold legacy data and a local CEK without ever
    // registering it as the current key — e.g. they have no passkey, or
    // only an un-promoted legacy passkey, so none of the passkey/recovery
    // flows that normally register the key ever run, and nothing else
    // would migrate them. Adopt the local CEK as the current key here so
    // the rewrap gate below passes. Safe because we already hold the CEK
    // and a legacy passkey wrapping it stays promotable afterwards.
    if (!currentKeyId && current.has_data && localKeyId) {
      if (
        (await this.localKeysCanDecryptRemoteData()) &&
        (await this.adoptLocalKeyForMigration())
      ) {
        currentKeyId = localKeyId
      }
    }
    if (!currentKeyId || !localKeyId || currentKeyId !== localKeyId) {
      return
    }
    if (this.legacyMigrationKicked) {
      return
    }
    this.legacyMigrationKicked = true
    const kickStartedAt = Date.now()
    void runLegacyBlobMigrationAndFinalize()
      .then(async (report) => {
        logInfo('Legacy blob migration completed', {
          component: 'CloudSync',
          action: 'kickLegacyBlobMigration',
          metadata: {
            fullyMigrated: report.fullyMigrated,
            totalMigrated: report.totalMigrated,
            totalRemaining: report.totalRemaining,
            totalBlocked: report.totalBlocked,
          },
        })
        await runLegacyChatEvictionIfNeeded()
        // Eviction deletes local rows but the server still has them,
        // so the cached `(count, lastUpdated)` snapshot now lies. Drop
        // it so the next `smartSync` falls back to a full pull and
        // repopulates the evicted chats from the enclave.
        this.invalidateChatSyncCaches()
        // Migration may have promoted a legacy CEK into the enclave,
        // which means a brand-new bundle now exists for this device's
        // credential. Nudge the passkey hook so the sidebar/setting
        // surfaces "passkey active" instead of "set up passkey".
        passkeyEvents.emit({ type: 'bundle-state-maybe-changed' })
      })
      .catch((err) => {
        logError('Legacy blob migration kickoff failed', err, {
          component: 'CloudSync',
          action: 'kickLegacyBlobMigration',
        })
      })
  }

  /**
   * Probe whether the local key set can actually unseal the user's
   * existing remote data before adopting the local CEK as the registered
   * current key. Adoption permanently binds the registry to this key, so
   * registering a stale local CEK over data sealed under a different key
   * would strand the data and block the correct key from ever being
   * promoted. Pulls a few rows per scope with the full candidate set:
   * any successful decrypt proves the keys match; rows that all fail
   * with UNKNOWN_KEY prove they don't. When no row can be sampled at
   * all, adoption proceeds (nothing observable contradicts the key, and
   * a wrong adoption only blocks rewraps, which recovery can later fix).
   */
  private async localKeysCanDecryptRemoteData(): Promise<boolean> {
    const keys = migrationKeys()
    if (keys.length === 0) {
      return false
    }
    let sawUndecryptableRow = false
    for (const scope of ['chat', 'profile', 'project'] as const) {
      let items: PullItem[]
      try {
        const resp = await pull(
          scope === 'profile'
            ? { scope, ids: ['profile'], keys }
            : { scope, all: true, limit: KEY_ADOPTION_PROBE_LIMIT, keys },
        )
        items = resp.items
      } catch (err) {
        // Transient probe failure: don't adopt on this pass; the next
        // sync retries with the gate still closed.
        logError('Legacy migration adoption probe failed', err, {
          component: 'CloudSync',
          action: 'localKeysCanDecryptRemoteData',
          metadata: { scope },
        })
        return false
      }
      for (const item of items) {
        if (item.ok) {
          return true
        }
        if (item.code === 'UNKNOWN_KEY') {
          sawUndecryptableRow = true
        }
      }
    }
    if (sawUndecryptableRow) {
      logWarning(
        'Legacy migration adoption skipped: local keys cannot unseal existing remote data',
        {
          component: 'CloudSync',
          action: 'localKeysCanDecryptRemoteData',
        },
      )
      return false
    }
    return true
  }

  /**
   * Register the local primary CEK as the controlplane's current key for
   * a user who has legacy data but no registered key. Without this a
   * v1→v2 user who never registered their key — they have no passkey, or
   * only an un-promoted legacy passkey — could never migrate: nothing
   * registers their CEK, so every rewrap is gated out.
   *
   * Registered bundleless with created_via='recovery', which the
   * controlplane accepts non-destructively over legacy (key_id NULL)
   * rows. The caller only invokes this with a local CEK, legacy data, and
   * no registered key, so no enclave bundle can exist; a legacy passkey
   * wrapping this same CEK stays promotable afterwards (its bundle is
   * added on the next recovery), so adopting never strands a backup.
   * register-key's if_match='*' fails safely on a concurrent register.
   * Returns true when the key was adopted.
   */
  private async adoptLocalKeyForMigration(): Promise<boolean> {
    let keyB64: string
    try {
      keyB64 = requirePrimaryKeyB64()
    } catch {
      return false
    }
    try {
      await registerKey({
        keyB64,
        ifMatch: IF_MATCH_SENTINELS.AnyKey,
        createdVia: 'recovery',
        idempotencyKey: newIdempotencyKey(),
      })
    } catch (err) {
      logError('Failed to adopt local key for migration', err, {
        component: 'CloudSync',
        action: 'adoptLocalKeyForMigration',
      })
      return false
    }
    logInfo('Adopted local key as current to enable migration', {
      component: 'CloudSync',
      action: 'adoptLocalKeyForMigration',
    })
    passkeyEvents.emit({ type: 'bundle-state-maybe-changed' })
    return true
  }

  /**
   * Smart sync: check status first and only sync if needed.
   * @param projectId - Optional project ID. If provided, syncs project chats.
   */
  async smartSync(projectId?: string): Promise<SyncResult> {
    // Kick the legacy-blob migration before any sync work runs.
    // Previously this only fired at the end of a successful
    // doSyncAllChats, which deadlocked first-time v2 users: their
    // sync couldn't complete until legacy rows were migrated, but
    // migration was gated behind a successful sync. The kick is
    // session-idempotent and fire-and-forget, so calling it on
    // every smartSync entry is safe.
    void this.kickLegacyBlobMigration()

    // Note: smartSync doesn't need its own lock because it delegates to
    // syncChangedChats/syncAllChats/syncProjectChats which have their own locks
    if (this.syncLock) {
      throw new Error('Sync already in progress')
    }

    const status = await this.checkSyncStatus(projectId)

    if (!status.needsSync) {
      // A deletion from another device can be absorbed into the status
      // cache (the count matches again) on the same tick its tombstone
      // was missed locally, after which the count gate never reopens and
      // the orphan lingers until a full page refresh. Re-run the
      // tombstone reconciliation here so a missed deletion self-heals on
      // the next tick. The pass is idempotent and only emits when a chat
      // is actually removed locally.
      if (!projectId) {
        const cachedStatus = this.chatSyncCache.load()
        if (cachedStatus?.lastUpdated) {
          await syncRemoteDeletions(cachedStatus.lastUpdated, 'smartSync')
        }
      }

      logInfo('Smart sync: no changes detected, skipping sync', {
        component: 'CloudSync',
        action: 'smartSync',
        metadata: {
          projectId,
          reason: status.reason,
          remoteCount: status.remoteCount,
        },
      })
      return { uploaded: 0, downloaded: 0, errors: [] }
    }

    logInfo('Smart sync: changes detected, syncing', {
      component: 'CloudSync',
      action: 'smartSync',
      metadata: {
        projectId,
        reason: status.reason,
        remoteCount: status.remoteCount,
        remoteLastUpdated: status.remoteLastUpdated,
      },
    })

    // If we have a cached lastUpdated, use delta sync; otherwise fall back to full sync
    const cachedStatus = projectId
      ? this.getProjectSyncCache(projectId).load()
      : this.chatSyncCache.load()

    if (cachedStatus?.lastUpdated && status.reason !== 'count_changed') {
      return projectId
        ? this.syncProjectChatsChanged(projectId)
        : this.syncChangedChats()
    }

    return projectId ? this.syncProjectChats(projectId) : this.syncAllChats()
  }

  // Check if currently syncing
  get syncing(): boolean {
    return this.syncLock !== null
  }

  // Delete a chat from cloud storage
  async deleteFromCloud(chatId: string): Promise<void> {
    // Don't attempt deletion if not authenticated
    if (!(await cloudStorage.isAuthenticated())) {
      return
    }

    try {
      await cloudStorage.deleteChat(chatId)

      // Successfully deleted from cloud, can remove from tracker
      // This allows the chat to be re-created with the same ID if needed
      deletedChatsTracker.removeFromDeleted(chatId)

      logInfo('Chat successfully deleted from cloud', {
        component: 'CloudSync',
        action: 'deleteFromCloud',
        metadata: { chatId },
      })
    } catch (error) {
      // Silently fail if no auth token set
      if (
        error instanceof Error &&
        error.message.includes('Authentication token not set')
      ) {
        return
      }
      throw error
    }
  }

  // Update a chat's project association on the server
  async updateChatProject(
    chatId: string,
    projectId: string | null,
  ): Promise<void> {
    if (!(await cloudStorage.isAuthenticated())) {
      return
    }

    if (!(await canWriteToCloud())) {
      return
    }

    await cloudStorage.updateChatProject(chatId, projectId)
    await this.backupChat(chatId)
  }

  private async paginateLocalChats(
    limit: number,
    continuationToken?: string,
  ): Promise<PaginatedChatsResult> {
    const localChats = await indexedDBStorage.getAllChats()
    const sortedChats = localChats.sort((a, b) => {
      const timeA = new Date(a.createdAt).getTime()
      const timeB = new Date(b.createdAt).getTime()
      return timeB - timeA
    })

    const start = continuationToken ? parseInt(continuationToken, 10) : 0
    const paginatedChats = sortedChats.slice(start, start + limit)

    return {
      chats: paginatedChats,
      hasMore: start + limit < sortedChats.length,
      nextToken:
        start + limit < sortedChats.length
          ? (start + limit).toString()
          : undefined,
    }
  }

  // Load chats with pagination - combines local and remote chats
  async loadChatsWithPagination(options: {
    limit: number
    continuationToken?: string
    loadLocal?: boolean
  }): Promise<PaginatedChatsResult> {
    const { limit, continuationToken, loadLocal = true } = options

    // If no authentication, just return local chats
    if (!(await cloudStorage.isAuthenticated())) {
      if (loadLocal) {
        return this.paginateLocalChats(limit, continuationToken)
      }
      return { chats: [], hasMore: false }
    }

    try {
      // For authenticated users, load from R2 with content
      const remoteList = await cloudStorage.listChats({
        limit,
        continuationToken,
        includeContent: true,
      })

      // Process the chat data from each remote chat in parallel
      const downloadedChats: StoredChat[] = []
      const chatsToProcess = remoteList.conversations || []

      // Process all chats in parallel for better performance
      const processPromises = chatsToProcess.map(async (remoteChat) => {
        // Skip if this chat was recently deleted
        if (deletedChatsTracker.isDeleted(remoteChat.id)) {
          logInfo('Skipping load for recently deleted chat', {
            component: 'CloudSync',
            action: 'loadChatsWithPagination',
            metadata: { chatId: remoteChat.id },
          })
          return null
        }

        if (!remoteChat.content) return null

        try {
          const result = await processRemoteChat({
            id: remoteChat.id,
            plaintext: remoteChat.content,
            syncVersion: remoteChat.syncVersion,
            formatVersion: 2,
          })
          return result.chat
        } catch (error) {
          logError(`Failed to process chat ${remoteChat.id}`, error, {
            component: 'CloudSync',
            action: 'loadChatsWithPagination',
          })
          return null
        }
      })

      // Wait for all decryptions to complete
      const results = await Promise.all(processPromises)

      // Filter out nulls and add to downloadedChats
      for (const chat of results) {
        if (chat) {
          downloadedChats.push(chat)
        }
      }

      return {
        chats: downloadedChats,
        hasMore: !!remoteList.nextContinuationToken,
        nextToken: remoteList.nextContinuationToken,
      }
    } catch (error) {
      logError('Failed to load remote chats with pagination', error, {
        component: 'CloudSync',
        action: 'loadChatsWithPagination',
      })

      // Fall back to local chats if remote loading fails
      if (loadLocal) {
        return this.paginateLocalChats(limit, continuationToken)
      }

      throw error
    }
  }

  /**
   * Drop locally-cached placeholders for chats that previously failed
   * to decrypt and re-pull them from the enclave. The legacy-blob
   * migration runner is expected to have already rewrapped any
   * server-side rows that were stuck on a key the client no longer
   * has, so the next sync repopulates clean plaintext.
   */
  async retryDecryptionWithNewKey(
    options: {
      onProgress?: (current: number, total: number) => void
      batchSize?: number
    } = {},
  ): Promise<number> {
    const { onProgress } = options
    const batchSize = Math.max(1, Math.floor(options.batchSize || 5))

    const allChats = await indexedDBStorage.getAllChats()
    const failed = allChats.filter((chat) => chat.decryptionFailed)
    if (failed.length === 0) return 0

    for (let i = 0; i < failed.length; i++) {
      try {
        await indexedDBStorage.deleteChat(failed[i].id)
      } catch (error) {
        logError(`Failed to evict placeholder chat ${failed[i].id}`, error, {
          component: 'CloudSync',
          action: 'retryDecryptionWithNewKey',
        })
      }
      if ((i + 1) % batchSize === 0 || i === failed.length - 1) {
        onProgress?.(i + 1, failed.length)
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
    }

    // The just-evicted chats still exist on the server, so the cached
    // sync-status snapshot would match remote and `smartSync` would
    // no-op. Drop the cache before resyncing so the next pass takes
    // the full-sync path and repopulates them.
    this.invalidateChatSyncCaches()

    try {
      await this.smartSync()
    } catch (error) {
      logError('Resync after eviction failed', error, {
        component: 'CloudSync',
        action: 'retryDecryptionWithNewKey',
      })
      return 0
    }

    const remaining = (await indexedDBStorage.getAllChats()).filter(
      (chat) => chat.decryptionFailed,
    ).length

    return Math.max(0, failed.length - remaining)
  }

  // Fetch a page of remote chats, decrypt, persist to IndexedDB, and return pagination info
  async fetchAndStorePage(options: {
    limit: number
    continuationToken?: string
  }): Promise<{ hasMore: boolean; nextToken?: string; saved: number }> {
    const { limit, continuationToken } = options

    // Only operate when authenticated
    if (!(await cloudStorage.isAuthenticated())) {
      return { hasMore: false, saved: 0 }
    }

    try {
      // Request a page with content for decryption
      const remoteList = await cloudStorage.listChats({
        limit,
        continuationToken,
        includeContent: true,
      })

      const conversations = remoteList.conversations || []

      const ingestResult = await ingestRemoteChats(conversations, {
        fetchMissingContent: true,
        setLoadedAt: true,
        skipDeleted: false,
        eventReason: 'pagination',
      })

      return {
        hasMore: !!remoteList.nextContinuationToken,
        nextToken: remoteList.nextContinuationToken,
        saved: ingestResult.downloaded,
      }
    } catch (error) {
      logError('Failed to fetch and store chat page', error, {
        component: 'CloudSync',
        action: 'fetchAndStorePage',
      })
      throw error
    }
  }

  async syncProjectChats(projectId: string): Promise<SyncResult> {
    return this.withSyncLock(() => this.doSyncProjectChats(projectId))
  }

  private async doSyncProjectChats(projectId: string): Promise<SyncResult> {
    const result: SyncResult = {
      uploaded: 0,
      downloaded: 0,
      errors: [],
    }

    if (!(await cloudStorage.isAuthenticated())) {
      return result
    }

    try {
      const localChats = await indexedDBStorage.getAllChats()
      const localChatMap = new Map(localChats.map((c) => [c.id, c]))

      let hasMore = true
      let continuationToken: string | undefined
      let isFirstPage = true

      while (hasMore) {
        // Fetch metadata only; content is pulled through the enclave by ingestRemoteChats.
        const projectChatsResponse = await this.listProjectChatsWithRetry(
          projectId,
          { continuationToken },
        )

        const remoteChats = projectChatsResponse.chats || []

        if (isFirstPage && remoteChats.length === 0) {
          logInfo('No project chats to sync', {
            component: 'CloudSync',
            action: 'syncProjectChats',
            metadata: { projectId },
          })
          return result
        }

        if (isFirstPage) {
          logInfo(`Syncing project chats`, {
            component: 'CloudSync',
            action: 'syncProjectChats',
            metadata: {
              projectId,
              firstPageCount: remoteChats.length,
              hasMore: projectChatsResponse.hasMore,
            },
          })
        }
        isFirstPage = false

        const ingestResult = await ingestRemoteChats(remoteChats, {
          localChatMap,
          projectId,
          checkShouldIngest: true,
          fetchMissingContent: true,
        })
        result.downloaded += ingestResult.downloaded
        result.errors.push(...ingestResult.errors)

        hasMore =
          projectChatsResponse.hasMore === true &&
          !!projectChatsResponse.nextContinuationToken
        continuationToken = projectChatsResponse.nextContinuationToken
      }

      logInfo('Project chat sync complete', {
        component: 'CloudSync',
        action: 'syncProjectChats',
        metadata: {
          projectId,
          downloaded: result.downloaded,
          errors: result.errors.length,
        },
      })

      // Update cached sync status after successful sync
      try {
        const newStatus =
          await projectStorage.getProjectChatsSyncStatus(projectId)
        this.getProjectSyncCache(projectId).save(newStatus)
      } catch (statusError) {
        logError(
          'Failed to update project sync status after full sync',
          statusError,
          {
            component: 'CloudSync',
            action: 'syncProjectChats',
            metadata: { projectId },
          },
        )
      }
    } catch (error) {
      logError('Failed to sync project chats', error, {
        component: 'CloudSync',
        action: 'syncProjectChats',
        metadata: { projectId },
      })
      throw error instanceof Error ? error : new Error(String(error))
    }

    return result
  }

  /**
   * Perform a delta sync for project chats - only fetch chats that changed since last sync.
   */
  async syncProjectChatsChanged(projectId: string): Promise<SyncResult> {
    return this.withSyncLock(() => this.doSyncProjectChatsChanged(projectId))
  }

  private async doSyncProjectChatsChanged(
    projectId: string,
  ): Promise<SyncResult> {
    const result: SyncResult = {
      uploaded: 0,
      downloaded: 0,
      errors: [],
    }

    if (!(await cloudStorage.isAuthenticated())) {
      return result
    }

    try {
      // First, backup any unsynced local project chats
      const unsyncedChats = await indexedDBStorage.getUnsyncedChats()
      const projectChatsToSync = unsyncedChats.filter(
        (chat) =>
          chat.projectId === projectId && isUploadableChat(chat, isStreaming),
      )

      for (const chat of projectChatsToSync) {
        try {
          await this.uploadCoalescer.enqueueAndWait(chat.id)
          result.uploaded++
        } catch (error) {
          result.errors.push(
            `Failed to backup project chat ${chat.id}: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }

      // Get cached sync status to determine what changed
      const cachedStatus = this.getProjectSyncCache(projectId).load()

      if (!cachedStatus?.lastUpdated) {
        // No cached status, fall back to full sync
        return await this.doSyncProjectChats(projectId)
      }

      // Fetch and process chats updated since our last sync, with pagination
      let cursorId: string | undefined
      let hasMore = true
      let isFirstPage = true

      while (hasMore) {
        let updatedChats
        try {
          updatedChats = await projectStorage.getProjectChatsUpdatedSince(
            projectId,
            { since: cachedStatus.lastUpdated, cursorId },
          )
        } catch (error) {
          logError(
            'Failed to get updated project chats, falling back to full sync',
            error,
            {
              component: 'CloudSync',
              action: 'syncProjectChatsChanged',
              metadata: { projectId },
            },
          )
          return await this.doSyncProjectChats(projectId)
        }

        const remoteChats = updatedChats.chats || []

        if (isFirstPage && remoteChats.length === 0) {
          logInfo('No project chats updated since last sync', {
            component: 'CloudSync',
            action: 'syncProjectChatsChanged',
            metadata: { projectId, since: cachedStatus.lastUpdated },
          })
          // Update the cached status
          try {
            const newStatus =
              await projectStorage.getProjectChatsSyncStatus(projectId)
            this.getProjectSyncCache(projectId).save(newStatus)
          } catch (statusError) {
            logError('Failed to update project sync status', statusError, {
              component: 'CloudSync',
              action: 'syncProjectChatsChanged',
              metadata: { projectId },
            })
          }
          return result
        }

        if (isFirstPage) {
          logInfo(`Syncing changed project chats`, {
            component: 'CloudSync',
            action: 'syncProjectChatsChanged',
            metadata: {
              projectId,
              since: cachedStatus.lastUpdated,
              firstPageCount: remoteChats.length,
              hasMore: updatedChats.hasMore,
            },
          })
        }
        isFirstPage = false

        const ingestResult = await ingestRemoteChats(remoteChats, {
          projectId,
          fetchMissingContent: true,
        })
        result.downloaded += ingestResult.downloaded
        result.errors.push(...ingestResult.errors)

        // Check if there are more pages
        hasMore =
          updatedChats.hasMore === true && !!updatedChats.nextContinuationToken
        cursorId = updatedChats.nextContinuationToken
      }

      // Update cached sync status
      try {
        const newStatus =
          await projectStorage.getProjectChatsSyncStatus(projectId)
        this.getProjectSyncCache(projectId).save(newStatus)
      } catch (statusError) {
        logError('Failed to update project sync status', statusError, {
          component: 'CloudSync',
          action: 'syncProjectChatsChanged',
          metadata: { projectId },
        })
      }
    } catch (error) {
      result.errors.push(
        `Project chat sync failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }

    return result
  }
}

export const cloudSync = new CloudSyncService()
