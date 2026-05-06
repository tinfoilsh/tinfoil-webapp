import type { Chat } from '@/components/chat/types'
import { isCloudSyncEnabled } from '@/utils/cloud-sync-settings'
import { logError, logInfo } from '@/utils/error-handling'
import { cloudStorage } from '../cloud/cloud-storage'
import { cloudSync } from '../cloud/cloud-sync'
import { streamingTracker } from '../cloud/streaming-tracker'
import { chatEvents } from './chat-events'
import { deletedChatsTracker } from './deleted-chats-tracker'
import { indexedDBStorage, type Chat as StorageChat } from './indexed-db'

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
    await this.initialize()

    // Never save blank chats to storage
    if (chat.isBlankChat) {
      return chat
    }

    const chatToSave = chat

    // Check if this is a new chat (first time saving) and mark as local if intended or sync is disabled
    const existingChat = await indexedDBStorage.getChat(chatToSave.id)

    // Check if chat should be local-only
    // 1. If it's already marked as local
    // 2. If cloud sync is disabled globally
    // 3. If the existing chat is already local
    const shouldMarkAsLocal =
      chatToSave.isLocalOnly ||
      !isCloudSyncEnabled() ||
      existingChat?.isLocalOnly

    // Save the chat
    const storageChat: StorageChat = {
      ...chatToSave,
      createdAt:
        chatToSave.createdAt instanceof Date
          ? chatToSave.createdAt.toISOString()
          : chatToSave.createdAt,
      updatedAt: new Date().toISOString(),
      isLocalOnly: shouldMarkAsLocal || (existingChat?.isLocalOnly ?? false),
    }

    await indexedDBStorage.saveChat(storageChat)

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
      !storageChat.isLocalOnly
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
      isLocalOnly: storageChat.isLocalOnly,
      createdAt:
        chatToSave.createdAt instanceof Date
          ? chatToSave.createdAt
          : new Date(chatToSave.createdAt),
    }
  }

  async saveChatAndSync(chat: Chat): Promise<Chat> {
    // Just use the regular saveChat method with sync enabled
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
      syncVersion,
      decryptionFailed,
      encryptedData,
      updatedAt,
      model,
      version,
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

    await indexedDBStorage.deleteChat(id)
    chatEvents.emit({ reason: 'delete', ids: [id] })

    // Also delete from cloud storage (non-blocking)
    cloudSync.deleteFromCloud(id).catch((error: unknown) => {
      logError('Failed to delete chat from cloud', error, {
        component: 'ChatStorageService',
        action: 'deleteChat',
        metadata: { chatId: id },
      })
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
  }> {
    await this.initialize()

    // Snapshot local IDs up front so we know what to mark as deleted in the
    // tracker after a successful wipe, but don't mark anything yet — if the
    // cloud delete fails we must leave sync state untouched, otherwise we'd
    // tombstone chats that still exist on the server and lose them on the
    // next pull.
    const localIds = await indexedDBStorage.getAllChatIds()

    // Attempt the cloud bulk-delete first. If it fails, surface the error
    // and skip both the tracker update and the local wipe so the user can
    // retry without partial-deletion side effects.
    let cloudDeleted = 0
    if (await cloudStorage.isAuthenticated()) {
      try {
        const result = await cloudStorage.deleteAllChats()
        cloudDeleted = result.deleted
      } catch (error) {
        logError('Failed to bulk-delete cloud chats', error, {
          component: 'ChatStorageService',
          action: 'deleteAllChats',
        })
        throw error
      }
    }

    // Cloud delete succeeded (or user is anonymous); now it's safe to
    // tombstone the IDs locally and wipe IndexedDB.
    for (const id of localIds) {
      if (id) deletedChatsTracker.markAsDeleted(id)
    }

    const localDeleted = await indexedDBStorage.deleteAllChats()
    chatEvents.emit({ reason: 'delete', ids: [] })

    logInfo('Deleted all chats', {
      component: 'ChatStorageService',
      action: 'deleteAllChats',
      metadata: { localDeleted, cloudDeleted },
    })

    return { localDeleted, cloudDeleted }
  }

  async getAllChats(): Promise<Chat[]> {
    await this.initialize()

    const storedChats = await indexedDBStorage.getAllChats()
    // Convert StoredChat[] to Chat[], keeping syncedAt for UI display
    return storedChats.map(
      ({
        lastAccessedAt,
        locallyModified,
        syncVersion,
        decryptionFailed,
        encryptedData,
        updatedAt,
        model,
        version,
        ...baseChat
      }) => ({
        ...baseChat,
        createdAt: new Date(baseChat.createdAt),
        syncedAt: baseChat.syncedAt,
      }),
    )
  }

  async getAllChatsWithSyncStatus(): Promise<Chat[]> {
    await this.initialize()

    const storedChats = await indexedDBStorage.getAllChats()
    // Convert StoredChat[] to Chat[] but preserve sync metadata
    return storedChats.map(
      ({
        lastAccessedAt,
        syncVersion,
        encryptedData,
        updatedAt,
        model,
        version,
        ...chatWithSyncData
      }) => ({
        ...chatWithSyncData,
        createdAt: new Date(chatWithSyncData.createdAt),
      }),
    )
  }

  async convertChatToCloud(chatId: string): Promise<void> {
    await this.initialize()

    await indexedDBStorage.resetChatTimestamps(chatId)
    await indexedDBStorage.updateChatLocalOnly(chatId, false)

    chatEvents.emit({ reason: 'save', ids: [chatId] })

    await cloudSync.backupChat(chatId)
  }

  async convertChatToLocal(chatId: string): Promise<void> {
    await this.initialize()

    await indexedDBStorage.resetChatTimestamps(chatId)
    await indexedDBStorage.updateChatLocalOnly(chatId, true)
    await indexedDBStorage.updateChatProject(chatId, null)

    chatEvents.emit({ reason: 'save', ids: [chatId] })

    cloudSync.deleteFromCloud(chatId).catch((error) => {
      logError(
        'Failed to delete chat from cloud during local conversion',
        error,
        {
          component: 'ChatStorageService',
          action: 'convertChatToLocal',
          metadata: { chatId },
        },
      )
    })
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
