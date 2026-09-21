import { PAGINATION } from '@/config'
import {
  AUTH_ACTIVE_USER_ID,
  SETTINGS_CLOUD_SYNC_ENABLED,
  SYNC_CHAT_DELETION_REVISION,
} from '@/constants/storage-keys'
import { AuthTokenUnavailableError } from '@/services/auth'
import { chatEvents } from '@/services/storage/chat-events'
import { deletedChatsTracker } from '@/services/storage/deleted-chats-tracker'
import {
  chatContentFingerprint,
  indexedDBStorage,
  type StoredChat,
} from '@/services/storage/indexed-db'
import { decideRecovery } from '@/services/sync-enclave/enclave-error-recovery'
import { passkeyEvents } from '@/services/sync-enclave/passkey-events'
import {
  keyCurrent,
  newIdempotencyKey,
  PULL_ITEM_CODES,
} from '@/services/sync-enclave/sync-api'
import {
  abortSyncEnclaveRequests,
  resetSyncEnclaveRequestScope,
  SyncEnclaveError,
} from '@/services/sync-enclave/sync-enclave-client'
import {
  CLOUD_SYNC_SETTING_CHANGED_EVENT,
  isCloudSyncEnabled,
} from '@/utils/cloud-sync-settings'
import { logError, logWarning } from '@/utils/error-handling'
import type { AccountOperationGuard } from './account-operation'
import { hasPrimaryKey, primaryKeyIdHexOrNull } from './cek-encoding'
import { processRemoteChat } from './chat-codec'
import { ingestRemoteChats, type RemoteChatEntry } from './chat-ingestion'
import {
  BOOTSTRAP_RECENT_CONTENT_LIMIT,
  drainChatRevisionSync,
} from './chat-revision-sync'
import { canWriteToCloud } from './cloud-key-authorization'
import {
  cloudStorage,
  type ChatListResponse,
  type UploadChatOptions,
} from './cloud-storage'
import { adoptLocalKeyForMigration } from './ensure-current-key'
import {
  finalizeAlternativesIfMigrated,
  runLegacyBlobMigration,
} from './legacy-blob-migration'
import { runLegacyChatEvictionIfNeeded } from './legacy-chat-eviction'
import { streamingTracker } from './streaming-tracker'
import {
  reportChatSynced,
  reportChatSyncFailed,
  reportKeyActionRequired,
  reportSyncPaused,
} from './sync-health'
import {
  isUploadableChat,
  remoteWins,
  trustedChatClock,
} from './sync-predicates'
import { UploadCoalescer, type UploadAttempt } from './upload-coalescer'

export interface SyncResult {
  uploaded: number
  downloaded: number
  errors: string[]
}

export class SyncInProgressError extends Error {
  constructor() {
    super('Sync already in progress')
    this.name = 'SyncInProgressError'
  }
}

export class CloudSyncDisabledError extends Error {
  constructor() {
    super('Cloud synchronization is disabled')
    this.name = 'CloudSyncDisabledError'
  }
}

export class CloudSyncCoordinationUnavailableError extends Error {
  constructor() {
    super('Cross-tab cloud synchronization coordination is unavailable')
    this.name = 'CloudSyncCoordinationUnavailableError'
  }
}

export class CloudSyncLifecycleCanceledError extends Error {
  readonly code = 'CLOUD_SYNC_LIFECYCLE_CANCELED'

  constructor(public readonly reason: 'disabled' | 'account-reset') {
    super('Cloud synchronization was canceled')
    this.name = 'CloudSyncLifecycleCanceledError'
  }
}

export interface PaginatedChatsResult {
  chats: StoredChat[]
  hasMore: boolean
  nextToken?: string
}

type ChatListEntry = ChatListResponse['conversations'][number]

/** A listed chat whose content the enclave could not return. */
export interface UnavailableRemoteChat {
  id: string
  /** Enclave pull item code, one of PULL_ITEM_CODES. */
  code: string
}

interface ChatHydrationResult {
  saved: number
  unavailable: UnavailableRemoteChat[]
  skippedIds: string[]
}

export interface ChatPageResult {
  saved: number
  unavailable: UnavailableRemoteChat[]
  hasMore: boolean
  nextToken?: string
}

export class RemoteChatPageIncompleteError extends Error {
  readonly code = 'REMOTE_CHAT_PAGE_INCOMPLETE'

  constructor(
    public readonly chatId: string,
    public readonly stage:
      'boundary' | 'missing-content' | 'decode' | 'storage',
    cause?: unknown,
  ) {
    super(`Remote chat page is incomplete at ${chatId}`)
    this.name = 'RemoteChatPageIncompleteError'
    this.cause = cause
  }
}

const UPLOAD_BASE_DELAY_MS = 1000
const UPLOAD_MAX_DELAY_MS = 8000
const UPLOAD_MAX_RETRIES = 3
const DECRYPTION_RETRY_BATCH_SIZE = 5
export const CROSS_TAB_SYNC_LOCK = 'tinfoil-cloud-sync'
export const CROSS_TAB_SYNC_LOCK_OPTIONS = { mode: 'exclusive' } as const
const isStreaming = (id: string) => streamingTracker.isStreaming(id)

export class CloudSyncService {
  private syncLock: Promise<void> | null = null
  private uploadCoalescer: UploadCoalescer
  private streamingCallbacks = new Set<string>()
  private accountGeneration = 0
  private legacyMigrationKicked = false
  private lockAcquisitionController = new AbortController()
  private chatReloadFrame: number | null = null
  private cloudSyncEnabled = isCloudSyncEnabled()
  private projectUploadBarriers = new Map<string, Promise<void>>()
  private projectBarrierQueues = new Map<string, Promise<void>>()
  private activeProjectUploads = new Map<string, number>()
  private projectUploadDrainWaiters = new Map<string, Set<() => void>>()

  constructor() {
    this.uploadCoalescer = new UploadCoalescer(
      (chatId, idempotencyKey) => this.doBackupChat(chatId, idempotencyKey),
      {
        baseDelayMs: UPLOAD_BASE_DELAY_MS,
        maxDelayMs: UPLOAD_MAX_DELAY_MS,
        maxRetries: UPLOAD_MAX_RETRIES,
      },
    )
    if (typeof window !== 'undefined') {
      window.addEventListener(CLOUD_SYNC_SETTING_CHANGED_EVENT, () => {
        this.handleCloudSyncSettingChange()
      })
      window.addEventListener('storage', (event) => {
        if (event.key === SETTINGS_CLOUD_SYNC_ENABLED) {
          this.handleCloudSyncSettingChange()
        } else if (event.key === SYNC_CHAT_DELETION_REVISION) {
          this.queueChatReload()
        }
      })
    }
  }

  private handleCloudSyncSettingChange(): void {
    const enabled = isCloudSyncEnabled()
    if (this.cloudSyncEnabled && !enabled) {
      this.accountGeneration++
      this.uploadCoalescer.clear()
      this.streamingCallbacks.clear()
      this.legacyMigrationKicked = false
      this.cancelSyncLifecycle('disabled')
      if (this.chatReloadFrame !== null) {
        cancelAnimationFrame(this.chatReloadFrame)
        this.chatReloadFrame = null
      }
    } else if (!this.cloudSyncEnabled && enabled) {
      this.lockAcquisitionController = new AbortController()
      resetSyncEnclaveRequestScope('cloud-sync')
    }
    this.cloudSyncEnabled = enabled
  }

  private cancelSyncLifecycle(reason: 'disabled' | 'account-reset'): void {
    const cancellation = new CloudSyncLifecycleCanceledError(reason)
    this.lockAcquisitionController.abort(cancellation)
    abortSyncEnclaveRequests('cloud-sync')
  }

  private queueChatReload(): void {
    if (this.chatReloadFrame !== null) return
    this.chatReloadFrame = requestAnimationFrame(() => {
      this.chatReloadFrame = null
      chatEvents.emit({ reason: 'sync', ids: [] })
    })
  }

  private isCurrentGeneration(generation: number): boolean {
    return generation === this.accountGeneration
  }

  private ensureCurrentAccount(
    generation: number,
    userId: string | null,
  ): void {
    if (
      !this.isCurrentGeneration(generation) ||
      this.readActiveUserId() !== userId
    ) {
      throw new Error('Cloud account changed during synchronization')
    }
  }

  private readActiveUserId(): string | null {
    if (typeof window === 'undefined') return null
    try {
      return localStorage.getItem(AUTH_ACTIVE_USER_ID)
    } catch {
      return null
    }
  }

  createAccountOperationGuard(): AccountOperationGuard {
    const generation = this.accountGeneration
    const userId = this.readActiveUserId()
    const isCurrent = () =>
      this.isCurrentGeneration(generation) && this.readActiveUserId() === userId
    return {
      userId,
      isCurrent,
      assertCurrent: () => {
        if (!isCurrent()) {
          throw new Error('Cloud account changed during synchronization')
        }
      },
    }
  }

  private async acquireProjectUpload(
    projectId: string | undefined,
  ): Promise<{ release: () => void; waited: boolean }> {
    if (!projectId) return { release: () => {}, waited: false }
    let waited = false
    while (true) {
      const barrier = this.projectUploadBarriers.get(projectId)
      if (barrier) {
        waited = true
        await barrier
        continue
      }
      this.activeProjectUploads.set(
        projectId,
        (this.activeProjectUploads.get(projectId) ?? 0) + 1,
      )
      let released = false
      return {
        waited,
        release: () => {
          if (released) return
          released = true
          const remaining = (this.activeProjectUploads.get(projectId) ?? 1) - 1
          if (remaining > 0) {
            this.activeProjectUploads.set(projectId, remaining)
            return
          }
          this.activeProjectUploads.delete(projectId)
          const waiters = this.projectUploadDrainWaiters.get(projectId)
          this.projectUploadDrainWaiters.delete(projectId)
          for (const resolve of waiters ?? []) resolve()
        },
      }
    }
  }

  private async waitForProjectUploads(projectId: string): Promise<void> {
    if (!this.activeProjectUploads.has(projectId)) return
    await new Promise<void>((resolve) => {
      const waiters = this.projectUploadDrainWaiters.get(projectId) ?? new Set()
      waiters.add(resolve)
      this.projectUploadDrainWaiters.set(projectId, waiters)
    })
  }

  async withProjectUploadBarrier<T>(
    projectId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous =
      this.projectBarrierQueues.get(projectId) ?? Promise.resolve()
    let releaseQueue!: () => void
    const queued = new Promise<void>((resolve) => {
      releaseQueue = resolve
    })
    this.projectBarrierQueues.set(projectId, queued)
    await previous

    let releaseBarrier!: () => void
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve
    })
    this.projectUploadBarriers.set(projectId, barrier)
    try {
      await this.waitForProjectUploads(projectId)
      return await operation()
    } finally {
      this.projectUploadBarriers.delete(projectId)
      releaseBarrier()
      releaseQueue()
      if (this.projectBarrierQueues.get(projectId) === queued) {
        this.projectBarrierQueues.delete(projectId)
      }
    }
  }

  private async prepareChatForUpload(
    chatId: string,
    generation: number,
    userId: string | null,
  ): Promise<{ chat: StoredChat; release: () => void } | null> {
    while (true) {
      const chat = await indexedDBStorage.getChat(chatId)
      this.ensureCurrentAccount(generation, userId)
      if (
        !chat ||
        chat.syncUserId !== userId ||
        !isUploadableChat(chat, isStreaming)
      ) {
        return null
      }
      const admission = await this.acquireProjectUpload(chat.projectId)
      let retained = false
      try {
        this.ensureCurrentAccount(generation, userId)
        if (!admission.waited) {
          retained = true
          return { chat, release: admission.release }
        }

        const latest = await indexedDBStorage.getChat(chatId)
        this.ensureCurrentAccount(generation, userId)
        if (
          !latest ||
          latest.syncUserId !== userId ||
          !isUploadableChat(latest, isStreaming)
        ) {
          return null
        }
        if (latest.projectId === chat.projectId) {
          retained = true
          return { chat: latest, release: admission.release }
        }
      } finally {
        if (!retained) admission.release()
      }
    }
  }

  private isOwnedByActiveAccount(chat: StoredChat): boolean {
    const userId = this.readActiveUserId()
    return userId !== null && chat.syncUserId === userId
  }

  private async assertUploadFinalized(
    chatId: string,
    generation: number,
    userId: string,
  ): Promise<void> {
    const latest = await indexedDBStorage.getChat(chatId)
    this.ensureCurrentAccount(generation, userId)
    if (!latest || latest.syncUserId !== userId || latest.pendingUpload !== 0) {
      throw new Error('Chat upload did not finalize')
    }
  }

  resetForAccountChange(): void {
    this.accountGeneration++
    this.cancelSyncLifecycle('account-reset')
    this.lockAcquisitionController = new AbortController()
    resetSyncEnclaveRequestScope('cloud-sync')
    this.uploadCoalescer.clear()
    this.streamingCallbacks.clear()
    this.legacyMigrationKicked = false
    if (this.chatReloadFrame !== null) {
      cancelAnimationFrame(this.chatReloadFrame)
      this.chatReloadFrame = null
    }
    void indexedDBStorage.clearRevisionSyncState().catch((error) => {
      logError('Failed to clear account revision state', error, {
        component: 'CloudSync',
        action: 'resetForAccountChange',
      })
    })
  }

  async clearSyncStatus(): Promise<void> {
    this.accountGeneration++
    this.uploadCoalescer.clear()
    if (this.syncLock) await this.syncLock
    await indexedDBStorage.clearRevisionSyncState()
  }

  async clearSyncStatusAfterServerWipe(): Promise<void> {
    const userId = this.readActiveUserId()
    if (!userId) return this.clearSyncStatus()
    this.accountGeneration++
    this.uploadCoalescer.clear()
    if (this.syncLock) await this.syncLock
    await indexedDBStorage.clearRevisionSyncStateAfterServerWipe(userId)
  }

  private async withSyncLock<T>(operation: () => Promise<T>): Promise<T> {
    if (this.syncLock) throw new SyncInProgressError()
    const generation = this.accountGeneration
    const lockSignal = this.lockAcquisitionController.signal
    const runIfCurrent = () => {
      if (!isCloudSyncEnabled() || !this.isCurrentGeneration(generation)) {
        throw new CloudSyncDisabledError()
      }
      return operation()
    }

    if (typeof window === 'undefined') return this.trackSync(runIfCurrent)
    if (typeof navigator === 'undefined' || !navigator.locks) {
      throw new CloudSyncCoordinationUnavailableError()
    }
    return this.trackSync(async () => {
      try {
        return await navigator.locks.request(
          CROSS_TAB_SYNC_LOCK,
          { ...CROSS_TAB_SYNC_LOCK_OPTIONS, signal: lockSignal },
          runIfCurrent,
        )
      } catch (error) {
        if (lockSignal.aborted) {
          throw lockSignal.reason instanceof Error
            ? lockSignal.reason
            : new CloudSyncLifecycleCanceledError('disabled')
        }
        throw error
      }
    })
  }

  private async trackSync<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void
    this.syncLock = new Promise<void>((resolve) => {
      release = resolve
    })
    try {
      return await operation()
    } finally {
      release()
      this.syncLock = null
    }
  }

  private async doRevisionSync(): Promise<SyncResult> {
    const generation = this.accountGeneration
    if (!(await cloudStorage.isAuthenticated())) {
      return { uploaded: 0, downloaded: 0, errors: [] }
    }
    const userId = this.readActiveUserId()
    if (!userId) {
      throw new Error('Authenticated user ID is unavailable for cloud sync')
    }
    const result = await drainChatRevisionSync(
      {
        isStreaming,
        upload: async (chat) => {
          await this.uploadCoalescer.enqueueAndWait(chat.id)
          await this.assertUploadFinalized(chat.id, generation, userId)
        },
        waitForUpload: (id) => this.uploadCoalescer.waitForUpload(id),
      },
      userId,
      () => this.isCurrentGeneration(generation),
    )
    if (result.uploaded > 0 || result.downloaded > 0) {
      try {
        localStorage.setItem(SYNC_CHAT_DELETION_REVISION, crypto.randomUUID())
      } catch {
        // best-effort cross-tab refresh notification
      }
    }
    void this.kickLegacyBlobMigration(generation)
    return result
  }

  private async kickLegacyBlobMigration(generation: number): Promise<void> {
    if (this.legacyMigrationKicked || !hasPrimaryKey()) return
    try {
      const current = await keyCurrent()
      if (!this.isCurrentGeneration(generation)) return
      const localKeyId = await primaryKeyIdHexOrNull()
      if (!this.isCurrentGeneration(generation) || !localKeyId) return
      let currentKeyId = current.key_id
      if (!currentKeyId && current.has_data) {
        if (await adoptLocalKeyForMigration()) currentKeyId = localKeyId
      }
      if (currentKeyId !== localKeyId || this.legacyMigrationKicked) return
      this.legacyMigrationKicked = true
      const report = await runLegacyBlobMigration()
      if (!this.isCurrentGeneration(generation)) return
      await finalizeAlternativesIfMigrated(report)
      await runLegacyChatEvictionIfNeeded(() =>
        this.isCurrentGeneration(generation),
      )
      passkeyEvents.emit({ type: 'bundle-state-maybe-changed' })
    } catch (error) {
      if (!this.isCurrentGeneration(generation)) return
      this.legacyMigrationKicked = false
      logError('Legacy blob migration failed', error, {
        component: 'CloudSync',
        action: 'kickLegacyBlobMigration',
      })
    }
  }

  async smartSync(_projectId?: string): Promise<SyncResult> {
    return this.withSyncLock(() => this.doRevisionSync())
  }

  get syncing(): boolean {
    return this.syncLock !== null
  }

  async waitForCurrentSync(): Promise<void> {
    const currentSync = this.syncLock
    if (currentSync) await currentSync
  }

  /**
   * Whether an upload for this chat is queued or in flight. Used by
   * the delete path to decide if a delete intent must be queued even
   * for a never-synced chat (the racing create push may still commit).
   */
  hasPendingUpload(chatId: string): boolean {
    return this.uploadCoalescer.hasPendingUpload(chatId)
  }

  async backupChat(chatId: string): Promise<void> {
    const generation = this.accountGeneration
    if (!(await cloudStorage.isAuthenticated())) return
    if (!this.isCurrentGeneration(generation) || !(await canWriteToCloud())) {
      return
    }
    const chat = await indexedDBStorage.getChat(chatId)
    if (!this.isCurrentGeneration(generation)) return
    if (
      !chat ||
      !this.isOwnedByActiveAccount(chat) ||
      !isUploadableChat(chat, isStreaming)
    ) {
      return
    }
    this.uploadCoalescer.enqueue(chatId)
  }

  async backupChatAndWait(chatId: string): Promise<void> {
    const generation = this.accountGeneration
    if (!(await cloudStorage.isAuthenticated())) {
      throw new Error('Cloud authentication is unavailable')
    }
    if (!this.isCurrentGeneration(generation) || !(await canWriteToCloud())) {
      throw new Error('Cloud synchronization is unavailable')
    }
    const chat = await indexedDBStorage.getChat(chatId)
    if (
      !chat ||
      !this.isOwnedByActiveAccount(chat) ||
      !isUploadableChat(chat, isStreaming)
    ) {
      throw new Error('Chat is not eligible for cloud synchronization')
    }
    await this.uploadCoalescer.ensureUploadAndWait(chatId)
    const latest = await indexedDBStorage.getChat(chatId)
    if (!this.isCurrentGeneration(generation)) {
      throw new Error('Cloud account changed during synchronization')
    }
    if (!latest) {
      throw new Error('Chat changed during required cloud synchronization')
    }
    if (!latest.locallyModified) {
      if (latest.updatedAt !== chat.updatedAt) {
        throw new Error('Chat changed on another device before synchronization')
      }
      return
    }
    await this.backupChatNow(chatId)
  }

  async waitForUpload(chatId: string): Promise<void> {
    await this.uploadCoalescer.waitForUpload(chatId)
  }

  async waitForAllUploads(): Promise<void> {
    await this.uploadCoalescer.waitForAllUploads()
  }

  async backupChatNow(
    chatId: string,
    options: UploadChatOptions = {},
  ): Promise<void> {
    const generation = this.accountGeneration
    const userId = this.readActiveUserId()
    if (!(await cloudStorage.isAuthenticated())) {
      throw new Error('Authentication required for cloud sync')
    }
    this.ensureCurrentAccount(generation, userId)
    if (!(await canWriteToCloud())) {
      throw new Error('Cloud sync key is not authorized')
    }
    this.ensureCurrentAccount(generation, userId)
    if (streamingTracker.isStreaming(chatId)) {
      throw new Error('Cannot sync chat while it is streaming')
    }
    const prepared = await this.prepareChatForUpload(chatId, generation, userId)
    if (!prepared) {
      throw new Error('Chat is not eligible for cloud sync')
    }
    const { chat, release } = prepared
    try {
      const preUploadUpdatedAt = chat.updatedAt
      const preUploadFingerprint = chatContentFingerprint(chat)
      const preUploadVersion = chat.syncVersion ?? 0
      const { syncVersion, rewrites, projectIntentIncluded } =
        await cloudStorage.uploadChat(chat, {
          ...options,
          idempotencyKey: options.idempotencyKey ?? newIdempotencyKey(),
        })
      this.ensureCurrentAccount(generation, userId)
      await indexedDBStorage.finalizeUpload({
        chatId,
        rewrites,
        preUploadUpdatedAt,
        preUploadFingerprint,
        syncVersion: syncVersion ?? preUploadVersion + 1,
        uploadedProjectId: chat.projectId,
        projectIntentIncluded,
      })
      this.ensureCurrentAccount(generation, userId)
      this.queueChatReload()
    } finally {
      release()
    }
  }

  /**
   * Fork a synced chat server-side and bring the new row into local
   * storage. Pending local edits are flushed first so the enclave copies
   * exactly what the user sees; the fork is then pulled back through the
   * same path a chat created on another device takes, so its local sync
   * bookkeeping starts out correct.
   */
  async forkChat(request: {
    sourceId: string
    targetId: string
    messageCount: number
    title: string
  }): Promise<StoredChat> {
    const generation = this.accountGeneration
    const userId = this.readActiveUserId()
    await this.uploadCoalescer.waitForUpload(request.sourceId)
    const source = await indexedDBStorage.getChat(request.sourceId)
    this.ensureCurrentAccount(generation, userId)
    if (!source) {
      throw new Error('Chat not found')
    }
    if (source.locallyModified) {
      await this.backupChatNow(request.sourceId)
      this.ensureCurrentAccount(generation, userId)
    }

    await cloudStorage.forkChat({
      ...request,
      createdAt: new Date().toISOString(),
      idempotencyKey: newIdempotencyKey(),
    })
    this.ensureCurrentAccount(generation, userId)

    const fork = await cloudStorage.downloadChat(request.targetId)
    this.ensureCurrentAccount(generation, userId)
    if (!fork) {
      throw new Error('Forked chat was not found after creation')
    }
    const applied = await indexedDBStorage.applyRemoteChatIfFresh({
      chat: fork,
      syncVersion: fork.syncVersion ?? 0,
      expectedLocalUpdatedAt: null,
      isCurrent: () =>
        this.isCurrentGeneration(generation) &&
        this.readActiveUserId() === userId,
      userId: userId ?? undefined,
    })
    this.ensureCurrentAccount(generation, userId)
    if (!applied.applied) {
      throw new Error('Forked chat could not be stored locally')
    }
    chatEvents.emit({ reason: 'sync', ids: [request.targetId] })
    reportChatSynced(request.targetId)
    return fork
  }

  private async doBackupChat(
    chatId: string,
    idempotencyKey: string,
  ): Promise<UploadAttempt | null> {
    const generation = this.accountGeneration
    const userId = this.readActiveUserId()
    try {
      if (!(await canWriteToCloud())) return null
      this.ensureCurrentAccount(generation, userId)
      if (streamingTracker.isStreaming(chatId)) {
        if (this.streamingCallbacks.has(chatId)) return null
        this.streamingCallbacks.add(chatId)
        streamingTracker.onStreamEnd(chatId, () => {
          if (!this.isCurrentGeneration(generation)) return
          this.streamingCallbacks.delete(chatId)
          void this.backupChat(chatId)
        })
        return null
      }
      const prepared = await this.prepareChatForUpload(
        chatId,
        generation,
        userId,
      )
      if (!prepared) return null
      const { chat, release } = prepared
      const preUploadUpdatedAt = chat.updatedAt
      const preUploadFingerprint = chatContentFingerprint(chat)
      const preUploadVersion = chat.syncVersion ?? 0
      const attempt: UploadAttempt = async () => {
        try {
          this.ensureCurrentAccount(generation, userId)
          const { syncVersion, rewrites, projectIntentIncluded } =
            await cloudStorage.uploadChat(chat, { idempotencyKey })
          this.ensureCurrentAccount(generation, userId)
          await indexedDBStorage.finalizeUpload({
            chatId,
            rewrites,
            preUploadUpdatedAt,
            preUploadFingerprint,
            syncVersion: syncVersion ?? preUploadVersion + 1,
            uploadedProjectId: chat.projectId,
            projectIntentIncluded,
          })
          this.ensureCurrentAccount(generation, userId)
          if (!userId) {
            throw new Error('Authenticated user ID is unavailable')
          }
          await this.assertUploadFinalized(chatId, generation, userId)
          reportChatSynced(chatId)
          this.queueChatReload()
        } catch (error) {
          if (this.readActiveUserId() !== userId) throw error
          await this.recoverFromChatUploadError(chatId, generation, error)
        }
      }
      attempt.dispose = release
      return attempt
    } catch (error) {
      if (this.readActiveUserId() !== userId) throw error
      await this.recoverFromChatUploadError(chatId, generation, error)
      return null
    }
  }

  private async recoverFromChatUploadError(
    chatId: string,
    generation: number,
    error: unknown,
  ): Promise<void> {
    if (!this.isCurrentGeneration(generation)) throw error
    if (error instanceof AuthTokenUnavailableError) return
    const decision = decideRecovery(error)
    if (decision.action.type === 'surface-conflict') {
      await this.resolveConflictByPullingRemote(chatId, generation)
      return
    }
    if (decision.action.type === 'refresh-current-key-and-retry') {
      reportKeyActionRequired('key-mismatch')
    } else if (decision.action.type === 'trigger-recovery-wizard') {
      reportKeyActionRequired('key-recovery')
    } else if (decision.action.type === 'block-all-sync') {
      reportSyncPaused('attestation')
    } else if (
      decision.action.type === 'surface-existing-data-under-other-key'
    ) {
      reportKeyActionRequired('key-conflict')
    } else if (decision.action.type === 'surface-not-found') {
      reportChatSyncFailed(chatId, 'This chat no longer exists in the cloud')
    } else if (decision.action.type === 'abort') {
      if (decision.action.reason === 'FORBIDDEN') {
        reportKeyActionRequired('account-blocked')
      } else if (decision.action.reason !== 'AUTH_PERSISTENT') {
        reportChatSyncFailed(chatId, "This chat couldn't be synced")
      }
    }
    throw error
  }

  private async resolveConflictByPullingRemote(
    chatId: string,
    generation: number,
  ): Promise<void> {
    const userId = this.readActiveUserId()
    try {
      const [localChat, remoteChat] = await Promise.all([
        indexedDBStorage.getChat(chatId),
        cloudStorage.downloadChat(chatId),
      ])
      this.ensureCurrentAccount(generation, userId)
      if (!remoteChat) {
        if (!userId) throw new Error('Authenticated user ID is unavailable')
        const deleted = await indexedDBStorage.applyRemoteDeletion(
          chatId,
          userId,
          () =>
            this.isCurrentGeneration(generation) &&
            this.readActiveUserId() === userId,
        )
        this.ensureCurrentAccount(generation, userId)
        if (deleted) chatEvents.emit({ reason: 'sync', ids: [chatId] })
        return
      }
      const remoteIsWinner = remoteWins({
        localClock: trustedChatClock(localChat),
        remoteClock: trustedChatClock(remoteChat),
        localUpdatedAt: localChat?.updatedAt,
        remoteUpdatedAt: remoteChat.updatedAt,
      })
      if (!remoteIsWinner) {
        await indexedDBStorage.rebaseSyncVersion(
          chatId,
          remoteChat.syncVersion ?? 0,
        )
        this.ensureCurrentAccount(generation, userId)
        void this.backupChat(chatId)
        return
      }
      const applied = await indexedDBStorage.applyRemoteChatIfFresh({
        chat: remoteChat,
        syncVersion: remoteChat.syncVersion ?? 0,
        expectedLocalUpdatedAt: localChat ? localChat.updatedAt : null,
        allowLocallyModified: true,
        isCurrent: () =>
          this.isCurrentGeneration(generation) &&
          this.readActiveUserId() === userId,
        userId: userId ?? undefined,
      })
      this.ensureCurrentAccount(generation, userId)
      if (applied.applied) {
        chatEvents.emit({ reason: 'sync', ids: [chatId] })
        reportChatSynced(chatId)
      }
    } catch (error) {
      logError('Failed to resolve conflict by pulling remote', error, {
        component: 'CloudSync',
        action: 'resolveConflictByPullingRemote',
        metadata: { chatId },
      })
      if (error instanceof SyncEnclaveError) throw error
      const propagated = new SyncEnclaveError(
        error instanceof Error ? error.message : String(error),
      )
      propagated.cause = error
      throw propagated
    }
  }

  async backupUnsyncedChats(): Promise<SyncResult> {
    const result: SyncResult = { uploaded: 0, downloaded: 0, errors: [] }
    const generation = this.accountGeneration
    const userId = this.readActiveUserId()
    if (!userId) return result
    const chats = await indexedDBStorage.getPendingUploadChats(userId)
    this.ensureCurrentAccount(generation, userId)
    for (const chat of chats) {
      if (!isUploadableChat(chat, isStreaming)) continue
      try {
        await this.uploadCoalescer.enqueueAndWait(chat.id)
        await this.assertUploadFinalized(chat.id, generation, userId)
        result.uploaded++
      } catch (error) {
        if (
          !this.isCurrentGeneration(generation) ||
          this.readActiveUserId() !== userId
        ) {
          throw error
        }
        result.errors.push(
          `Failed to backup chat ${chat.id}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    return result
  }

  async deleteFromCloud(
    chatId: string,
    idempotencyKey?: string,
  ): Promise<void> {
    if (!(await cloudStorage.isAuthenticated())) return
    try {
      // Settle any in-flight upload first. Deleting while a create
      // push is in flight makes the enclave see "already gone" and
      // acknowledge the intent before the push commits, resurrecting
      // the chat on the next event replay. The local row is already
      // deleted at this point, so no NEW upload can start — only the
      // frozen in-flight attempt needs to drain.
      await this.uploadCoalescer.waitForUpload(chatId)
      await cloudStorage.deleteChat(chatId, idempotencyKey)
      const userId = this.readActiveUserId()
      if (userId) {
        await indexedDBStorage.acknowledgePendingDelete(chatId, userId)
      }
      deletedChatsTracker.removeLocalDeletion(chatId)
      reportChatSynced(chatId)
    } catch (error) {
      if (error instanceof AuthTokenUnavailableError) return
      throw error
    }
  }

  async updateChatProject(
    chatId: string,
    projectId: string | null,
  ): Promise<void> {
    if (!(await cloudStorage.isAuthenticated())) return
    if (!(await canWriteToCloud())) return
    await cloudStorage.updateChatProject(chatId, projectId)
    await this.backupChat(chatId)
  }

  private async paginateLocalChats(
    limit: number,
    continuationToken?: string,
  ): Promise<PaginatedChatsResult> {
    const chats = await indexedDBStorage.getAllChats()
    chats.sort(
      (left, right) =>
        new Date(right.createdAt).getTime() -
        new Date(left.createdAt).getTime(),
    )
    const start = continuationToken ? Number.parseInt(continuationToken, 10) : 0
    return {
      chats: chats.slice(start, start + limit),
      hasMore: start + limit < chats.length,
      nextToken:
        start + limit < chats.length ? String(start + limit) : undefined,
    }
  }

  private isLocalChatCurrent(
    local: StoredChat | null | undefined,
    remote: ChatListEntry,
    userId: string,
  ): boolean {
    return (
      !!local &&
      local.syncUserId === userId &&
      !local.decryptionFailed &&
      local.syncVersion === remote.syncVersion
    )
  }

  /**
   * Pull and store content for the listed chats. Rows the enclave could
   * not return are reported rather than thrown: a chat sealed under a
   * key this device does not hold must not block access to the rest of
   * the history, and the caller decides whether to surface it.
   */
  private async hydrateChats(
    entries: readonly ChatListEntry[],
    generation: number,
    userId: string,
  ): Promise<ChatHydrationResult> {
    if (entries.length === 0)
      return { saved: 0, unavailable: [], skippedIds: [] }
    const pulled = await cloudStorage.downloadChats(
      entries.map((entry) => entry.id),
    )
    this.ensureCurrentAccount(generation, userId)
    const metadata = new Map(entries.map((entry) => [entry.id, entry]))
    const unavailable: UnavailableRemoteChat[] = []
    const remoteChats: RemoteChatEntry[] = []
    for (const result of pulled) {
      if (result.status === 'unavailable') {
        unavailable.push({ id: result.id, code: result.code })
        continue
      }
      const entry = metadata.get(result.id)!
      remoteChats.push({
        id: result.id,
        content: result.content,
        syncVersion: result.syncVersion,
        updatedAt: entry.updatedAt,
        projectId: entry.projectId,
      })
    }
    const ingest = await ingestRemoteChats(remoteChats, {
      setLoadedAt: true,
      eventReason: 'pagination',
      isCurrent: () =>
        this.isCurrentGeneration(generation) &&
        this.readActiveUserId() === userId,
      userId,
    })
    this.ensureCurrentAccount(generation, userId)
    const storageFailure = ingest.errors.find(
      (failure) => failure.stage === 'storage',
    )
    if (storageFailure) {
      throw new RemoteChatPageIncompleteError(
        storageFailure.chatId,
        'storage',
        storageFailure.error,
      )
    }
    const skippedIds = ingest.errors.map((failure) => failure.chatId)
    for (const chatId of skippedIds) {
      reportChatSyncFailed(chatId, "This chat couldn't be read")
    }
    if (skippedIds.length > 0) {
      logWarning('Skipped invalid chats while loading cloud history', {
        component: 'CloudSync',
        action: 'hydrateChats',
        metadata: { chatIds: skippedIds },
      })
    }
    if (unavailable.length > 0) this.reportUnavailableChats(unavailable)
    return { saved: ingest.downloaded, unavailable, skippedIds }
  }

  /**
   * Route unreadable rows into the sync health store the UI already
   * renders from. A row sealed under a key this device does not hold
   * needs the user to recover that key; a row that vanished between
   * list and pull is a benign race and stays quiet.
   */
  private reportUnavailableChats(
    unavailable: readonly UnavailableRemoteChat[],
  ): void {
    for (const row of unavailable) {
      switch (row.code) {
        case PULL_ITEM_CODES.NotFound:
          break
        case PULL_ITEM_CODES.UnknownKey:
          reportKeyActionRequired('key-recovery')
          break
        default:
          reportChatSyncFailed(row.id, "This chat couldn't be downloaded")
      }
    }
    logWarning('Sync enclave could not return some chats', {
      component: 'CloudSync',
      action: 'hydrateChats',
      metadata: { unavailable },
    })
  }

  async loadChatsWithPagination(options: {
    limit: number
    continuationToken?: string
    loadLocal?: boolean
  }): Promise<PaginatedChatsResult> {
    const { limit, continuationToken, loadLocal = true } = options
    if (!(await cloudStorage.isAuthenticated())) {
      return loadLocal
        ? this.paginateLocalChats(limit, continuationToken)
        : { chats: [], hasMore: false }
    }
    try {
      const remote = await cloudStorage.listChats({ limit, continuationToken })
      const entries = remote.conversations.filter(
        (entry) => !deletedChatsTracker.isDeleted(entry.id),
      )
      const metadata = new Map(entries.map((entry) => [entry.id, entry]))
      const pulled = await cloudStorage.downloadChats(
        entries.map((entry) => entry.id),
      )
      const chats: StoredChat[] = []
      for (const result of pulled) {
        if (result.status === 'unavailable') {
          if (result.code === PULL_ITEM_CODES.NotFound) continue
          throw new RemoteChatPageIncompleteError(
            result.id,
            'missing-content',
            result.code,
          )
        }
        try {
          const entry = metadata.get(result.id)!
          const decoded = await processRemoteChat(
            {
              id: result.id,
              plaintext: result.content,
              syncVersion: result.syncVersion,
              formatVersion: 2,
              updatedAt: entry.updatedAt,
            },
            {
              projectId: entry.projectId,
            },
          )
          chats.push(decoded.chat)
        } catch (error) {
          logError('Failed to decode paginated remote chat', error, {
            component: 'CloudSync',
            action: 'loadChatsWithPagination',
            metadata: { chatId: result.id },
          })
          throw new RemoteChatPageIncompleteError(result.id, 'decode', error)
        }
      }
      return {
        chats,
        hasMore: remote.hasMore,
        nextToken: remote.nextContinuationToken,
      }
    } catch (error) {
      if (error instanceof RemoteChatPageIncompleteError) throw error
      logError('Failed to load remote chats with pagination', error, {
        component: 'CloudSync',
        action: 'loadChatsWithPagination',
      })
      if (loadLocal) return this.paginateLocalChats(limit, continuationToken)
      throw error
    }
  }

  /**
   * Fetch the next metadata page that carries at least one chat. The
   * server pages chat updates and chat deletions under one cursor, so
   * a page may legitimately hold only deletions with a cursor that still
   * advances; those pages are skipped here so callers only ever see a
   * page with conversations or the end of history.
   */
  private async listNextChatPage(
    options: {
      limit: number
      continuationToken?: string
    },
    visitedTokens = new Set<string>(),
  ): Promise<ChatListResponse> {
    let continuationToken = options.continuationToken
    for (;;) {
      if (continuationToken !== undefined) {
        if (visitedTokens.has(continuationToken)) {
          throw new Error('Cloud pagination cursor did not advance')
        }
        visitedTokens.add(continuationToken)
      }
      const page = await cloudStorage.listChats({
        limit: options.limit,
        continuationToken,
      })
      if (page.conversations.length > 0 || !page.hasMore) return page
      continuationToken = page.nextContinuationToken
    }
  }

  async initializeChatPaginationCursor(): Promise<{
    hasMore: boolean
    nextToken?: string
  }> {
    const generation = this.accountGeneration
    const userId = this.readActiveUserId()
    if (!(await cloudStorage.isAuthenticated())) {
      this.ensureCurrentAccount(generation, userId)
      return { hasMore: false }
    }
    this.ensureCurrentAccount(generation, userId)
    if (!userId) throw new Error('Authenticated user ID is unavailable')
    const remote = await this.listNextChatPage({
      limit: BOOTSTRAP_RECENT_CONTENT_LIMIT,
    })
    this.ensureCurrentAccount(generation, userId)
    const prefix = remote.conversations.filter(
      (entry) => !deletedChatsTracker.isDeleted(entry.id),
    )
    const missingOrStale: ChatListEntry[] = []
    for (const entry of prefix) {
      const local = await indexedDBStorage.getChat(entry.id)
      this.ensureCurrentAccount(generation, userId)
      if (!this.isLocalChatCurrent(local, entry, userId)) {
        missingOrStale.push(entry)
      }
    }
    const hydrated = await this.hydrateChats(missingOrStale, generation, userId)
    const unavailableIds = new Set([
      ...hydrated.unavailable.map((row) => row.id),
      ...hydrated.skippedIds,
    ])
    for (const entry of prefix) {
      if (unavailableIds.has(entry.id)) continue
      const local = await indexedDBStorage.getChat(entry.id)
      this.ensureCurrentAccount(generation, userId)
      if (!this.isLocalChatCurrent(local, entry, userId)) {
        throw new RemoteChatPageIncompleteError(entry.id, 'boundary')
      }
    }

    const visitedTokens = new Set<string>()
    let nextToken = remote.nextContinuationToken
    while (nextToken) {
      const pageStartToken = nextToken
      const page = await this.listNextChatPage(
        {
          limit: PAGINATION.CURSOR_SCAN_PAGE_SIZE,
          continuationToken: pageStartToken,
        },
        visitedTokens,
      )
      this.ensureCurrentAccount(generation, userId)
      for (const entry of page.conversations) {
        if (deletedChatsTracker.isDeleted(entry.id)) continue
        const local = await indexedDBStorage.getChat(entry.id)
        this.ensureCurrentAccount(generation, userId)
        if (!this.isLocalChatCurrent(local, entry, userId)) {
          return { hasMore: true, nextToken: pageStartToken }
        }
      }
      nextToken = page.nextContinuationToken
    }
    return { hasMore: false }
  }

  async fetchAndStorePage(options: {
    limit: number
    continuationToken?: string
  }): Promise<ChatPageResult> {
    const generation = this.accountGeneration
    const userId = this.readActiveUserId()
    if (!(await cloudStorage.isAuthenticated())) {
      this.ensureCurrentAccount(generation, userId)
      return { hasMore: false, saved: 0, unavailable: [] }
    }
    this.ensureCurrentAccount(generation, userId)
    if (!userId) throw new Error('Authenticated user ID is unavailable')
    const remote = await this.listNextChatPage(options)
    this.ensureCurrentAccount(generation, userId)
    const entries = remote.conversations.filter(
      (entry) => !deletedChatsTracker.isDeleted(entry.id),
    )
    const hydrated = await this.hydrateChats(entries, generation, userId)
    return {
      hasMore: remote.hasMore,
      nextToken: remote.nextContinuationToken,
      saved: hydrated.saved,
      unavailable: hydrated.unavailable,
    }
  }

  async retryDecryptionWithNewKey(
    options: {
      onProgress?: (current: number, total: number) => void
      batchSize?: number
    } = {},
  ): Promise<number> {
    const batchSize = Math.max(
      1,
      Math.floor(options.batchSize ?? DECRYPTION_RETRY_BATCH_SIZE),
    )
    const failed = (await indexedDBStorage.getAllChats()).filter(
      (chat) => chat.decryptionFailed,
    )
    for (let index = 0; index < failed.length; index++) {
      try {
        await indexedDBStorage.deleteChat(failed[index].id)
      } catch (error) {
        logError('Failed to evict chat before decryption retry', error, {
          component: 'CloudSync',
          action: 'retryDecryptionWithNewKey',
          metadata: { chatId: failed[index].id },
        })
      }
      if ((index + 1) % batchSize === 0 || index === failed.length - 1) {
        options.onProgress?.(index + 1, failed.length)
      }
    }
    if (failed.length === 0) return 0
    await indexedDBStorage.clearRevisionCheckpoint()
    await this.smartSync()
    const remaining = (await indexedDBStorage.getAllChats()).filter(
      (chat) => chat.decryptionFailed,
    ).length
    return Math.max(0, failed.length - remaining)
  }
}

export const cloudSync = new CloudSyncService()
