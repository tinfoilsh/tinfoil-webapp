import type { Chat } from '@/components/chat/types'
import { forkChatTitle } from '@/constants/chat'
import { AUTH_ACTIVE_USER_ID } from '@/constants/storage-keys'
import { isCloudSyncEnabled } from '@/utils/cloud-sync-settings'
import { logError, logInfo } from '@/utils/error-handling'
import { generateReverseId } from '@/utils/reverse-id'
import { cloudStorage } from '../cloud/cloud-storage'
import { cloudSync } from '../cloud/cloud-sync'
import { streamingTracker } from '../cloud/streaming-tracker'
import { newIdempotencyKey } from '../sync-enclave/sync-api'
import { chatEvents } from './chat-events'
import { buildForkedChat } from './chat-fork'
import { deletedChatsTracker } from './deleted-chats-tracker'
import { indexedDBStorage, type Chat as StorageChat } from './indexed-db'

/**
 * Thrown when a chat cannot leave the cloud because some of its images
 * could not be fetched for local retention.
 */
export class ChatImagesUnavailableError extends Error {
  constructor(readonly attachmentIds: string[]) {
    super('Some chat images could not be retrieved')
    this.name = 'ChatImagesUnavailableError'
  }
}

// Images whose bytes live on the server: bucket attachments carry
// `encryptionKey`, legacy inline attachments carry `key`.
function isServerKeyedImage(
  attachment: NonNullable<
    StorageChat['messages'][number]['attachments']
  >[number],
): boolean {
  return (
    attachment.type === 'image' &&
    Boolean(attachment.encryptionKey || (attachment as { key?: string }).key)
  )
}

export class ChatStorageService {
  private initialized = false
  private initializePromise: Promise<void> | null = null

  async initialize(): Promise<void> {
    if (this.initialized) return

    // If initialization is already in progress, wait for it
    if (this.initializePromise) {
      return this.initializePromise
    }

    // Start initialization and store the promise
    this.initializePromise = this.doInitialize()

    try {
      await this.initializePromise
      this.initialized = true
    } catch (error) {
      // Reset on failure so initialization can be retried
      this.initializePromise = null
      throw error
    }
  }

  private async doInitialize(): Promise<void> {
    try {
      await indexedDBStorage.initialize()
    } catch (error) {
      logError('Failed to initialize chat storage', error, {
        component: 'ChatStorageService',
        action: 'initialize',
      })
      throw error
    }
  }

  async saveChat(chat: Chat, skipCloudSync = false): Promise<Chat> {
    return (await this.saveChatInternal(chat, skipCloudSync, false)) ?? chat
  }

  async saveChatIfAllowed(
    chat: Chat,
    skipCloudSync = false,
  ): Promise<Chat | null> {
    return this.saveChatInternal(chat, skipCloudSync, false)
  }

  async saveExistingChat(
    chat: Chat,
    skipCloudSync = false,
  ): Promise<Chat | null> {
    return this.saveChatInternal(chat, skipCloudSync, true)
  }

  private async saveChatInternal(
    chat: Chat,
    skipCloudSync: boolean,
    requireExisting: boolean,
  ): Promise<Chat | null> {
    if (deletedChatsTracker.isDeleted(chat.id)) return null
    await this.initialize()
    if (deletedChatsTracker.isDeleted(chat.id)) return null

    // Never save blank chats to storage
    if (chat.isBlankChat) {
      return chat
    }

    const chatToSave = chat

    // Save the chat. pendingSave is a transient UI flag that drives the
    // "Syncing with cloud" badge; persisting it makes the badge resurface
    // on every reload, so strip it before writing to storage.
    const { pendingSave, ...persistableChat } = chatToSave
    const storageChat: StorageChat = {
      ...persistableChat,
      createdAt:
        chatToSave.createdAt instanceof Date
          ? chatToSave.createdAt.toISOString()
          : chatToSave.createdAt,
      updatedAt: new Date().toISOString(),
      // The user's global opt-out is invariant (§9.6 R6): while cloud
      // sync is disabled, every save classifies as local-only so the
      // chat never enters the cloud write path.
      isLocalOnly: chatToSave.isLocalOnly === true || !isCloudSyncEnabled(),
    }

    const saveResult = requireExisting
      ? await indexedDBStorage.saveExistingChat(storageChat)
      : await indexedDBStorage.saveChat(storageChat)
    if (!saveResult.saved) return null
    const isLocalOnly = saveResult.isLocalOnly

    // Emit change event after local save
    chatEvents.emit({ reason: 'save', ids: [chatToSave.id] })

    // Auto-backup to cloud (non-blocking)
    // only if:
    // - not skipped
    // - not streaming
    // - not local-only
    if (
      !skipCloudSync &&
      !streamingTracker.isStreaming(chatToSave.id) &&
      !isLocalOnly
    ) {
      cloudSync.backupChat(chatToSave.id).catch((error) => {
        logError('Failed to backup chat to cloud', error, {
          component: 'ChatStorageService',
          action: 'saveChat',
          metadata: { chatId: chatToSave.id },
        })
      })
    }

    return {
      ...chatToSave,
      isLocalOnly,
      updatedAt: storageChat.updatedAt,
      createdAt:
        chatToSave.createdAt instanceof Date
          ? chatToSave.createdAt
          : new Date(chatToSave.createdAt),
    }
  }

  async saveChatAndSync(chat: Chat): Promise<Chat> {
    return await this.saveChat(chat, false)
  }

  async getChat(id: string): Promise<Chat | null> {
    await this.initialize()

    const storedChat = await indexedDBStorage.getChat(id)
    if (!storedChat) return null

    // Convert StoredChat back to Chat, keeping syncedAt for UI display
    const {
      lastAccessedAt,
      locallyModified,
      syncPending,
      syncVersion,
      decryptionFailed,
      version,
      pendingSave,
      ...baseChat
    } = storedChat
    return {
      ...baseChat,
      createdAt: new Date(storedChat.createdAt),
      syncedAt: storedChat.syncedAt,
    }
  }

  async deleteChat(id: string): Promise<void> {
    await this.initialize()

    // Mark as deleted to prevent re-sync
    deletedChatsTracker.markAsDeleted(id)

    const existingChat = await indexedDBStorage.getChat(id)
    const userId = localStorage.getItem(AUTH_ACTIVE_USER_ID)
    let idempotencyKey =
      existingChat?.isLocalOnly || !userId ? null : newIdempotencyKey()
    const queued =
      idempotencyKey && userId
        ? await indexedDBStorage.deleteChatWithPendingIntent(
            id,
            idempotencyKey,
            userId,
            // Memory-only remote chats have no local row, while a create
            // push can outlive its row. Both need a durable delete intent
            // so event replay cannot resurrect them.
            {
              forceQueue: !existingChat || cloudSync.hasPendingUpload(id),
            },
          )
        : false
    if (!idempotencyKey) {
      await indexedDBStorage.deleteChat(id)
    } else if (!queued) {
      idempotencyKey = null
    }
    chatEvents.emit({ reason: 'delete', ids: [id] })

    // Also delete from cloud storage (non-blocking)
    if (!idempotencyKey) return
    cloudSync.deleteFromCloud(id, idempotencyKey).catch((error: unknown) => {
      logError('Failed to delete chat from cloud', error, {
        component: 'ChatStorageService',
        action: 'deleteChat',
        metadata: { chatId: id },
      })
    })
  }

  async deleteChatsByProject(projectId: string): Promise<number> {
    return (await this.deleteChatsByProjectWithIds(projectId)).length
  }

  async deleteChatsByProjectWithIds(projectId: string): Promise<string[]> {
    const guard = cloudSync.createAccountOperationGuard()
    const userId = guard.userId
    if (!userId) {
      throw new Error('Authenticated user ID is unavailable')
    }
    await this.initialize()
    guard.assertCurrent()

    return cloudSync.withProjectUploadBarrier(projectId, async () => {
      guard.assertCurrent()
      const remoteIds = await cloudStorage.listChatIdsByProject(
        projectId,
        guard,
      )
      guard.assertCurrent()

      const deletedIds = await indexedDBStorage.deleteChatsByProject(
        projectId,
        remoteIds,
        userId,
        newIdempotencyKey,
        guard.isCurrent,
      )
      guard.assertCurrent()

      for (const id of deletedIds) deletedChatsTracker.markAsDeleted(id)

      if (deletedIds.length > 0) {
        chatEvents.emit({ reason: 'delete', ids: deletedIds })
      }

      try {
        guard.assertCurrent()
        await cloudStorage.deleteChatsByProject(projectId, guard)
        guard.assertCurrent()
        await indexedDBStorage.acknowledgePendingDeletes(
          deletedIds,
          userId,
          guard.isCurrent,
        )
        guard.assertCurrent()
      } catch (error) {
        logError('Failed to delete every remote project chat', error, {
          component: 'ChatStorageService',
          action: 'deleteChatsByProject.remoteDelete',
          metadata: { projectId },
        })
        throw error
      }

      logInfo(`Deleted ${deletedIds.length} chats for project`, {
        component: 'ChatStorageService',
        action: 'deleteChatsByProject',
        metadata: { projectId, count: deletedIds.length },
      })

      return deletedIds
    })
  }

  async deleteAllNonLocalChats(): Promise<number> {
    await this.initialize()

    const deletedCount = await indexedDBStorage.deleteAllNonLocalChats()

    if (deletedCount > 0) {
      chatEvents.emit({ reason: 'delete', ids: [] })
      logInfo(`Deleted ${deletedCount} non-local chats`, {
        component: 'ChatStorageService',
        action: 'deleteAllNonLocalChats',
      })
    }

    return deletedCount
  }

  async deleteAllChats(): Promise<{
    localDeleted: number
    cloudDeleted: number
    cloudDeletionCompleted: boolean
  }> {
    // Capture the guard before any await so the whole operation —
    // ID snapshot, cloud delete, and local wipe — is pinned to the
    // account that initiated it.
    const guard = cloudSync.createAccountOperationGuard()
    await this.initialize()
    guard.assertCurrent()

    // Snapshot local IDs up front so we know what to mark as deleted in the
    // tracker after a successful wipe, but don't mark anything yet — if the
    // cloud delete fails we must leave sync state untouched, otherwise we'd
    // tombstone chats that still exist on the server and lose them on the
    // next pull.
    const localIds = await indexedDBStorage.getAllChatIds()
    guard.assertCurrent()

    // Attempt the cloud bulk-delete first. If it fails, surface the error
    // and skip both the tracker update and the local wipe so the user can
    // retry without partial-deletion side effects.
    let cloudDeleted = 0
    let cloudDeletionCompleted = false
    if (await cloudStorage.isAuthenticated()) {
      try {
        guard.assertCurrent()
        const result = await cloudStorage.deleteAllChats(guard)
        cloudDeleted = result.deleted
        cloudDeletionCompleted = true
      } catch (error) {
        logError('Failed to bulk-delete cloud chats', error, {
          component: 'ChatStorageService',
          action: 'deleteAllChats',
        })
        throw error
      }
    }

    // Cloud delete succeeded (or user is anonymous); now it's safe to
    // tombstone the IDs locally and wipe IndexedDB — but only for the
    // same account: the local wipe clears the whole store without
    // account scoping.
    guard.assertCurrent()
    for (const id of localIds) {
      if (id) deletedChatsTracker.markAsDeleted(id)
    }

    const localDeleted = await indexedDBStorage.deleteAllChats()
    chatEvents.emit({ reason: 'delete-all' })

    logInfo('Deleted all chats', {
      component: 'ChatStorageService',
      action: 'deleteAllChats',
      metadata: { localDeleted, cloudDeleted },
    })

    return { localDeleted, cloudDeleted, cloudDeletionCompleted }
  }

  async getAllChats(): Promise<Chat[]> {
    await this.initialize()

    const storedChats = await indexedDBStorage.getAllChats()
    // Convert StoredChat[] to Chat[], keeping syncedAt for UI display
    return storedChats.map(
      ({
        lastAccessedAt,
        locallyModified,
        syncPending,
        syncVersion,
        decryptionFailed,
        version,
        pendingSave,
        ...baseChat
      }) => ({
        ...baseChat,
        createdAt: new Date(baseChat.createdAt),
        syncedAt: baseChat.syncedAt,
      }),
    )
  }

  async getChatCount(): Promise<number> {
    await this.initialize()
    return indexedDBStorage.getChatCount()
  }

  async getAllChatsWithSyncStatus(): Promise<Chat[]> {
    await this.initialize()

    const storedChats = await indexedDBStorage.getAllChats()
    // Convert StoredChat[] to Chat[] but preserve sync metadata
    return storedChats.map(
      ({
        lastAccessedAt,
        syncPending,
        syncVersion,
        version,
        pendingSave,
        ...chatWithSyncData
      }) => ({
        ...chatWithSyncData,
        createdAt: new Date(chatWithSyncData.createdAt),
      }),
    )
  }

  async getChatSummariesWithSyncStatus(): Promise<Chat[]> {
    await this.initialize()

    const storedChats = await indexedDBStorage.getChatSummaries()
    return storedChats.map(
      ({
        lastAccessedAt,
        syncPending,
        syncVersion,
        version,
        pendingSave,
        ...chatWithSyncData
      }) => ({
        ...chatWithSyncData,
        createdAt: new Date(chatWithSyncData.createdAt),
      }),
    )
  }

  async convertChatToCloud(chatId: string): Promise<void> {
    await this.initialize()

    const existingChat = await indexedDBStorage.getChat(chatId)
    if (!existingChat) {
      throw new Error('Chat not found')
    }

    await indexedDBStorage.resetChatTimestamps(chatId)
    await indexedDBStorage.updateChatLocalOnly(chatId, false)

    try {
      await cloudSync.backupChatNow(chatId, { restoreDeleted: true })
    } catch (error) {
      await indexedDBStorage.saveChat(existingChat)
      throw error
    }

    chatEvents.emit({ reason: 'save', ids: [chatId] })
  }

  // Deleting the cloud row cascades to its attachment blobs (both bucket
  // images keyed by `encryptionKey` and legacy inline ones keyed by
  // `key`), so every synced image must be held locally and detached from
  // its server key before the delete. Dropping the key also lets a later
  // conversion back to cloud upload the image afresh instead of pointing
  // at a dead id.
  private async detachSyncedImages(chatId: string): Promise<void> {
    const stored = await indexedDBStorage.getChat(chatId)
    if (!stored) return
    const guard = cloudSync.createAccountOperationGuard()
    const fetched = await cloudStorage.loadChatImages(chatId, stored.messages)
    guard.assertCurrent()
    const unfetchedIds = (messages: StorageChat['messages']) =>
      messages.flatMap(
        (message) =>
          message.attachments
            ?.filter(
              (attachment) =>
                isServerKeyedImage(attachment) &&
                !attachment.base64 &&
                !fetched[attachment.id],
            )
            .map((attachment) => attachment.id) ?? [],
      )
    const unfetched = unfetchedIds(stored.messages)
    if (unfetched.length > 0) {
      throw new ChatImagesUnavailableError(unfetched)
    }
    await indexedDBStorage.mutateChat(chatId, (chat) => {
      // The chat may have gained images since the fetch; those have no
      // bytes to retain, so the conversion must not proceed.
      const stale = unfetchedIds(chat.messages)
      if (stale.length > 0) {
        throw new ChatImagesUnavailableError(stale)
      }
      let changed = false
      const messages = chat.messages.map((message) => ({
        ...message,
        attachments: message.attachments?.map((attachment) => {
          if (!isServerKeyedImage(attachment)) {
            return attachment
          }
          changed = true
          const {
            encryptionKey: _encryptionKey,
            key: _key,
            ...detached
          } = attachment as typeof attachment & { key?: string }
          return {
            ...detached,
            base64: attachment.base64 ?? fetched[attachment.id],
          }
        }),
      }))
      return { chat: changed ? { ...chat, messages } : chat, changed }
    })
  }

  async convertChatToLocal(chatId: string): Promise<void> {
    await this.initialize()

    const existingChat = await indexedDBStorage.getChat(chatId)
    if (!existingChat) {
      throw new Error('Chat not found')
    }

    await this.detachSyncedImages(chatId)
    await indexedDBStorage.resetChatTimestamps(chatId)
    await indexedDBStorage.updateChatLocalOnly(chatId, true)
    await indexedDBStorage.updateChatProject(chatId, null)

    const userId = localStorage.getItem(AUTH_ACTIVE_USER_ID)
    const idempotencyKey = newIdempotencyKey()
    if (userId) {
      await indexedDBStorage.enqueuePendingDelete(
        chatId,
        idempotencyKey,
        userId,
      )
    }
    try {
      await cloudSync.deleteFromCloud(chatId, idempotencyKey)
    } catch (error) {
      // Plain saves treat local-only as sticky, so restore the original
      // classification explicitly before rewriting the pre-conversion row.
      await indexedDBStorage.updateChatLocalOnly(
        chatId,
        existingChat.isLocalOnly === true,
      )
      await indexedDBStorage.saveChat(existingChat)
      logError(
        'Failed to delete chat from cloud during local conversion',
        error,
        {
          component: 'ChatStorageService',
          action: 'convertChatToLocal',
          metadata: { chatId },
        },
      )
      throw error
    }

    chatEvents.emit({ reason: 'save', ids: [chatId] })
  }

  /**
   * Create a new chat holding the first `messageCount` messages of an
   * existing one. Local-only chats are copied on this device; synced
   * chats are forked by the enclave so their image bytes stay
   * server-side and each chat ends up owning its own copies. Callers
   * may pre-mint `forkId` so they can show the fork before it lands.
   */
  async forkChat(
    sourceId: string,
    messageCount: number,
    forkId: string = generateReverseId().id,
  ): Promise<Chat> {
    await this.initialize()

    const source = await this.getChat(sourceId)
    if (!source) {
      throw new Error('Chat not found')
    }
    if (messageCount < 1 || messageCount > source.messages.length) {
      throw new RangeError('Fork point is outside the conversation')
    }

    // The user's global opt-out is invariant (§9.6 R6): while cloud sync
    // is disabled nothing may reach the enclave, so even a chat that was
    // synced before the opt-out is copied on this device.
    if (source.isLocalOnly || !isCloudSyncEnabled()) {
      const fork = buildForkedChat(source, messageCount, forkId)
      const saved = await this.saveChat(fork, true)
      const stored = await this.getChat(forkId)
      return stored ?? saved
    }

    await cloudSync.forkChat({
      sourceId,
      targetId: forkId,
      messageCount,
      title: forkChatTitle(source.title),
    })
    const fork = await this.getChat(forkId)
    if (!fork) {
      throw new Error('Forked chat was not stored')
    }
    return fork
  }

  async moveChatToProject(chatId: string, projectId: string): Promise<void> {
    await this.initialize()

    const originalChat = await indexedDBStorage.getChat(chatId)
    if (!originalChat) {
      throw new Error('Chat not found')
    }

    let convertedToCloud = false
    try {
      if (originalChat.isLocalOnly) {
        await this.convertChatToCloud(chatId)
        convertedToCloud = true
      }

      await indexedDBStorage.updateChatProject(chatId, projectId)
      await cloudSync.updateChatProject(chatId, projectId)
      await cloudSync.backupChatAndWait(chatId)
      chatEvents.emit({ reason: 'save', ids: [chatId] })
    } catch (error) {
      if (convertedToCloud) {
        try {
          await this.convertChatToLocal(chatId)
          await indexedDBStorage.saveChat(originalChat)
          chatEvents.emit({ reason: 'save', ids: [chatId] })
        } catch (rollbackError) {
          logError(
            'Failed to restore local chat after project move',
            rollbackError,
            {
              component: 'ChatStorageService',
              action: 'moveChatToProject.rollback',
              metadata: { chatId, projectId },
            },
          )
        }
      }
      throw error
    }
  }

  async removeChatFromProject(chatId: string): Promise<void> {
    await this.initialize()

    await indexedDBStorage.resetChatTimestamps(chatId)
    await indexedDBStorage.updateChatProject(chatId, null)

    chatEvents.emit({ reason: 'save', ids: [chatId] })

    // Update server-side project association, then re-upload the full encrypted blob
    await cloudSync.updateChatProject(chatId, null)
    await cloudSync.backupChat(chatId)
  }
}

export const chatStorage = new ChatStorageService()
