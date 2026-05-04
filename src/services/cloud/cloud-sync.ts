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
import { processRemoteChat } from './chat-codec'
import { ingestRemoteChats, syncRemoteDeletions } from './chat-ingestion'
import { canWriteToCloud } from './cloud-key-authorization'
import { cloudStorage, type ChatSyncStatus } from './cloud-storage'
import {
  reencryptAndUploadChats as doReencryptAndUpload,
  retryDecryptionWithNewKey as doRetryDecryption,
} from './encryption-recovery'
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

const isStreaming = (id: string) => streamingTracker.isStreaming(id)

export class CloudSyncService {
  private syncLock: Promise<void> | null = null
  private syncLockResolve: (() => void) | null = null
  private uploadCoalescer: UploadCoalescer
  private streamingCallbacks: Set<string> = new Set()
  private chatSyncCache = new SyncStatusCache<ChatSyncStatus>(SYNC_CHAT_STATUS)
  private allChatsSyncCache = new SyncStatusCache<ChatSyncStatus>(
    SYNC_ALL_CHATS_STATUS,
  )
  private projectSyncCaches = new Map<string, SyncStatusCache<ChatSyncStatus>>()

  constructor() {
    // Initialize upload coalescer with doBackupChat as the upload function
    this.uploadCoalescer = new UploadCoalescer(
      (chatId) => this.doBackupChat(chatId),
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

      logInfo('[CloudSync] checkSyncStatus comparing statuses', {
        component: 'CloudSync',
        action: 'checkSyncStatus.compare',
        metadata: {
          projectId,
          remoteCount: remoteStatus.count,
          cachedCount: cachedStatus.count,
          remoteLastUpdated: remoteStatus.lastUpdated,
          cachedLastUpdated: cachedStatus.lastUpdated,
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
            await indexedDBStorage.updateChatProject(
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
    const result: SyncResult = {
      uploaded: 0,
      downloaded: 0,
      errors: [],
    }

    try {
      // Get cached sync status to determine what changed
      const cachedStatus = this.chatSyncCache.load()

      if (!cachedStatus?.lastUpdated) {
        // No cached status, fall back to full sync (first page only)
        return await this.doSyncAllChats()
      }

      // Delete local chats that were deleted on another device
      await syncRemoteDeletions(cachedStatus.lastUpdated, 'syncChangedChats')

      // First, backup any unsynced local changes
      const backupResult = await this.backupUnsyncedChats()
      result.uploaded = backupResult.uploaded
      result.errors.push(...backupResult.errors)

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

  private async doBackupChat(chatId: string): Promise<void> {
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
            hasEncryptedData: !!chat.encryptedData,
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

      await cloudStorage.uploadChat(chat)

      // Mark as synced with incremented version
      const newVersion = (chat.syncVersion ?? 0) + 1
      await indexedDBStorage.markAsSynced(chatId, newVersion)
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

      // Route each chat through doBackupChat for consistent streaming checks,
      // upload logic, and markAsSynced handling
      const uploadPromises = chatsToSync.map(async (chat) => {
        try {
          await this.doBackupChat(chat.id)
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
  async syncAllChats(): Promise<SyncResult> {
    return this.withSyncLock(() => this.doSyncAllChats())
  }

  private async listChatsWithRetry(options: {
    includeContent: boolean
    limit: number
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
    options: { includeContent: boolean; continuationToken?: string },
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

  private async doSyncAllChats(): Promise<SyncResult> {
    const result: SyncResult = {
      uploaded: 0,
      downloaded: 0,
      errors: [],
    }

    try {
      const cachedStatus = this.chatSyncCache.load()
      if (cachedStatus?.lastUpdated) {
        // Delete local chats that were deleted on another device
        await syncRemoteDeletions(cachedStatus.lastUpdated, 'syncAllChats')
      }

      // First, backup any unsynced local changes
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

      // Update cached sync status after successful sync
      try {
        const newStatus = await cloudStorage.getChatSyncStatus()
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
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error))
    }

    return result
  }

  /**
   * Smart sync: check status first and only sync if needed.
   * @param projectId - Optional project ID. If provided, syncs project chats.
   */
  async smartSync(projectId?: string): Promise<SyncResult> {
    // Note: smartSync doesn't need its own lock because it delegates to
    // syncChangedChats/syncAllChats/syncProjectChats which have their own locks
    if (this.syncLock) {
      throw new Error('Sync already in progress')
    }

    const status = await this.checkSyncStatus(projectId)

    if (!status.needsSync) {
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
      throw new Error('Authentication token not set')
    }

    deletedChatsTracker.markAsDeleted(chatId)

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
      deletedChatsTracker.removeFromDeleted(chatId)
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
          // Use centralized chat codec for decryption/placeholder logic
          const result = await processRemoteChat(remoteChat)
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

  // Retry decryption for chats that failed to decrypt
  async retryDecryptionWithNewKey(
    options: {
      onProgress?: (current: number, total: number) => void
      batchSize?: number
    } = {},
  ): Promise<number> {
    return doRetryDecryption(options)
  }

  // Re-encrypt all local chats with new key and upload to cloud
  async reencryptAndUploadChats(): Promise<{
    reencrypted: number
    uploaded: number
    errors: string[]
  }> {
    return doReencryptAndUpload()
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

  /**
   * Sync chats for a specific project from the cloud.
   * This fetches project-specific chats using the /api/projects/{projectId}/chats endpoint.
   */
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
      const cachedStatus = this.getProjectSyncCache(projectId).load()
      if (cachedStatus?.lastUpdated) {
        await syncRemoteDeletions(cachedStatus.lastUpdated, 'syncProjectChats')
      }

      const localChats = await indexedDBStorage.getAllChats()
      const localChatMap = new Map(localChats.map((c) => [c.id, c]))

      let hasMore = true
      let continuationToken: string | undefined
      let isFirstPage = true

      while (hasMore) {
        // Fetch project chats with content for decryption
        const projectChatsResponse = await this.listProjectChatsWithRetry(
          projectId,
          { includeContent: true, continuationToken },
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
      // Get cached sync status to determine what changed
      const cachedStatus = this.getProjectSyncCache(projectId).load()

      if (!cachedStatus?.lastUpdated) {
        // No cached status, fall back to full sync
        return await this.doSyncProjectChats(projectId)
      }

      await syncRemoteDeletions(
        cachedStatus.lastUpdated,
        'syncProjectChatsChanged',
      )

      // First, backup any unsynced local project chats
      const unsyncedChats = await indexedDBStorage.getUnsyncedChats()
      const projectChatsToSync = unsyncedChats.filter(
        (chat) =>
          chat.projectId === projectId && isUploadableChat(chat, isStreaming),
      )

      for (const chat of projectChatsToSync) {
        try {
          // Call doBackupChat directly (not via coalescer) so we can
          // await completion and accurately track upload results
          await this.doBackupChat(chat.id)
          result.uploaded++
        } catch (error) {
          result.errors.push(
            `Failed to backup project chat ${chat.id}: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
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
