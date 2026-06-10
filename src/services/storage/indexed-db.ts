import type { Chat as ChatType } from '@/components/chat/types'
import { logError, logWarning } from '@/utils/error-handling'

export interface Chat extends Omit<ChatType, 'createdAt'> {
  createdAt: string
  updatedAt: string
  model?: string
}

export interface StoredChat extends Chat {
  lastAccessedAt: number
  syncedAt?: number
  locallyModified?: boolean
  syncVersion?: number
  formatVersion?: number // 0=legacy JSON, 1=gzip+binary
  decryptionFailed?: boolean
  dataCorrupted?: boolean // True if data appears to be corrupted (e.g., compressed with wrong key)
  encryptedData?: string
  version?: number // Storage format version
  loadedAt?: number // Timestamp when chat was loaded from pagination
  isLocalOnly?: boolean // True if chat should never be synced to cloud (created when sync was disabled)
  isBlankChat?: boolean // True for new chats that haven't been used yet (empty placeholders)
}

const DB_NAME = 'tinfoil-chat'
export const DB_VERSION = 1
const CHATS_STORE = 'chats'

function hashString(input: string): string {
  // Small, deterministic 32-bit hash for change detection
  let hash = 5381
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 33) ^ input.charCodeAt(i)
  }
  // Unsigned hex string
  return (hash >>> 0).toString(16)
}

/**
 * Computes a stable fingerprint for a chat's meaningful content.
 * Used to decide if a chat is "locally modified" (and should be re-uploaded).
 *
 * Intentionally ignores `updatedAt` so we don't treat "save time changed" as a content change.
 * Avoids hashing huge blobs (documentContent/image base64) by hashing or summarizing those fields.
 */
export function chatContentFingerprint(chat: {
  title?: string
  projectId?: string
  messages?: any[]
}): string {
  const messages = (chat.messages || []).map((m) => ({
    role: m.role,
    content: m.content,
    thoughts: m.thoughts,
    isThinking: m.isThinking,
    thinkingDuration: m.thinkingDuration,
    isError: m.isError,
    timestamp: m.timestamp,
    timeline: m.timeline,
    // New format: hash attachment data to avoid huge fingerprints
    attachments:
      Array.isArray(m.attachments) && m.attachments.length > 0
        ? m.attachments.map((a: any) => ({
            id: a.id,
            type: a.type,
            fileName: a.fileName,
          }))
        : [],
    // Legacy fields — still included for old messages that haven't been migrated
    documents: m.documents,
    documentContentHash:
      typeof m.documentContent === 'string'
        ? hashString(m.documentContent)
        : null,
    documentContentLength:
      typeof m.documentContent === 'string' ? m.documentContent.length : 0,
    imageData:
      Array.isArray(m.imageData) && m.imageData.length > 0
        ? m.imageData.map((img: any) => ({
            mimeType: img?.mimeType,
            base64Hash:
              typeof img?.base64 === 'string' ? hashString(img.base64) : null,
            base64Length:
              typeof img?.base64 === 'string' ? img.base64.length : 0,
          }))
        : [],
  }))

  return JSON.stringify({
    title: chat.title ?? '',
    projectId: chat.projectId ?? null,
    messages,
  })
}

/**
 * Determine whether a chat should be marked as locally modified (needing upload).
 *
 * Rules:
 * 1. Chats that failed decryption are NEVER marked modified — they are placeholders
 *    with empty messages that would overwrite real encrypted data on the server.
 * 2. Existing chats: mark modified if meaningful content changed, or preserve the
 *    existing modified flag so previously-dirty chats stay dirty.
 * 3. New chats: use the caller-provided value, defaulting to true.
 */
export function computeLocallyModified(opts: {
  isFailedDecryption: boolean
  existingChat: StoredChat | undefined
  hasContentChanges: boolean
  callerValue: boolean | undefined
}): boolean {
  if (opts.isFailedDecryption) {
    return false
  }
  if (opts.existingChat) {
    return opts.hasContentChanges || opts.existingChat.locallyModified === true
  }
  return opts.callerValue ?? true
}

export class IndexedDBStorage {
  private db: IDBDatabase | null = null
  private saveQueue: Promise<void> = Promise.resolve()

  async initialize(): Promise<void> {
    // Check if IndexedDB is available
    if (typeof window === 'undefined' || !window.indexedDB) {
      throw new Error('IndexedDB not available')
    }

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION)

      request.onerror = (event) => {
        const error = (event.target as IDBOpenDBRequest).error
        logError('IndexedDB open error', error, {
          component: 'IndexedDBStorage',
        })
        reject(
          new Error(
            `Failed to open database: ${error?.message || 'Unknown error'}`,
          ),
        )
      }

      request.onsuccess = () => {
        this.db = request.result
        resolve()
      }

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result

        try {
          if (!db.objectStoreNames.contains(CHATS_STORE)) {
            const store = db.createObjectStore(CHATS_STORE, { keyPath: 'id' })
            store.createIndex('lastAccessedAt', 'lastAccessedAt', {
              unique: false,
            })
            store.createIndex('createdAt', 'createdAt', { unique: false })
            // Add sync-related indexes
            store.createIndex('syncedAt', 'syncedAt', { unique: false })
            store.createIndex('locallyModified', 'locallyModified', {
              unique: false,
            })
          }
        } catch (error) {
          logError('Failed to create object store', error, {
            component: 'IndexedDBStorage',
          })
          reject(new Error(`Failed to upgrade database: ${error}`))
        }
      }

      request.onblocked = () => {
        logWarning('IndexedDB upgrade blocked - close other tabs', {
          component: 'IndexedDBStorage',
        })
        reject(new Error('Database upgrade blocked'))
      }
    })
  }

  private async ensureDB(): Promise<IDBDatabase> {
    if (!this.db) {
      await this.initialize()
    }
    if (!this.db) {
      throw new Error('Database not initialized')
    }
    return this.db
  }

  async saveChat(chat: Chat): Promise<void> {
    const chatSnapshot = JSON.parse(JSON.stringify(chat))
    this.saveQueue = this.saveQueue
      .catch((error) => {
        logError('Previous save operation failed, recovering queue', error, {
          component: 'IndexedDBStorage',
          action: 'saveChat.queueRecovery',
        })
      })
      .then(() => this.saveChatInternal(chatSnapshot))
    return this.saveQueue
  }

  private async saveChatInternal(chat: Chat): Promise<void> {
    const db = await this.ensureDB()

    // Don't save blank chats to IndexedDB
    if ((chat as StoredChat).isBlankChat === true) {
      return
    }

    return new Promise((resolve, reject) => {
      const transaction = db.transaction([CHATS_STORE], 'readwrite')
      const store = transaction.objectStore(CHATS_STORE)

      transaction.oncomplete = () => {
        resolve()
      }

      transaction.onerror = (event) => {
        import('@/utils/error-handling').then(({ logError }) => {
          logError(
            '[IndexedDB] Transaction error',
            (event.target as any).error,
            {
              component: 'IndexedDBStorage',
              action: 'saveChatInternal',
            },
          )
        })
        reject(new Error('Failed to save chat'))
      }

      transaction.onabort = (event) => {
        import('@/utils/error-handling').then(({ logError }) => {
          logError(
            '[IndexedDB] Transaction aborted',
            (event.target as any).error,
            {
              component: 'IndexedDBStorage',
              action: 'saveChatInternal',
              metadata: { chatId: chat.id },
            },
          )
        })
        reject(new Error('Transaction aborted'))
      }

      const getRequest = store.get(chat.id)

      getRequest.onsuccess = () => {
        const existingChat = getRequest.result as StoredChat | undefined

        const messagesForStorage = chat.messages.map((msg) => ({
          ...msg,
          timestamp:
            msg.timestamp instanceof Date
              ? msg.timestamp.toISOString()
              : msg.timestamp,
        }))

        // Determine if the chat's meaningful content has changed compared to existing version.
        // NOTE: We intentionally ignore `updatedAt` so we don't create sync churn from timestamps.
        const hasContentChanges = existingChat
          ? chatContentFingerprint({
              title: existingChat.title,
              projectId: existingChat.projectId,
              messages: existingChat.messages,
            }) !==
            chatContentFingerprint({
              title: chat.title,
              projectId: (chat as StoredChat).projectId,
              messages: messagesForStorage,
            })
          : false

        // Never mark chats that failed to decrypt as locally modified.
        // These are placeholder chats with empty messages that should NOT be uploaded.
        // If we set locallyModified: true, they would overwrite real encrypted data on the server.
        const isFailedDecryption =
          (chat as StoredChat).decryptionFailed === true ||
          !!(chat as StoredChat).encryptedData

        const storedChat: StoredChat = {
          ...chat,
          messages: messagesForStorage as any,
          lastAccessedAt: Date.now(),
          syncedAt: existingChat?.syncedAt ?? (chat as StoredChat).syncedAt,
          // For existing chats: mark as modified if content changed, or preserve existing modified state
          // This ensures modified chats are always picked up for sync even if they were
          // loaded with locallyModified: false from a previous sync
          // For new chats: use provided value or default to true
          // IMPORTANT: Never mark failed-to-decrypt chats as modified - they are placeholders
          locallyModified: computeLocallyModified({
            isFailedDecryption,
            existingChat,
            hasContentChanges,
            callerValue: (chat as StoredChat).locallyModified,
          }),
          syncVersion:
            existingChat?.syncVersion ?? (chat as StoredChat).syncVersion,
          decryptionFailed: (chat as StoredChat).decryptionFailed,
          dataCorrupted: (chat as StoredChat).dataCorrupted,
          encryptedData: (chat as StoredChat).encryptedData,
          version: 1,
          loadedAt:
            (chat as StoredChat).loadedAt ??
            existingChat?.loadedAt ??
            undefined,
          isLocalOnly: (chat as any).isLocalOnly ?? false,
        }

        const putRequest = store.put(storedChat)

        putRequest.onerror = () => {
          reject(new Error('Failed to save chat'))
        }
      }

      getRequest.onerror = () =>
        reject(new Error('Failed to check existing chat'))
    })
  }

  private async getChatInternal(id: string): Promise<StoredChat | null> {
    const db = await this.ensureDB()

    return new Promise((resolve, reject) => {
      const transaction = db.transaction([CHATS_STORE], 'readonly')
      const store = transaction.objectStore(CHATS_STORE)
      const request = store.get(id)

      request.onsuccess = () => {
        const chat = request.result
        if (chat) {
          // Convert string timestamps back to Date objects
          chat.messages = chat.messages.map((msg: any) => ({
            ...msg,
            timestamp: msg.timestamp ? new Date(msg.timestamp) : new Date(),
          }))
        }
        resolve(chat || null)
      }
      request.onerror = () => reject(new Error('Failed to get chat'))
    })
  }

  async getChat(id: string): Promise<StoredChat | null> {
    await this.saveQueue.catch(() => {})
    const chat = await this.getChatInternal(id)
    if (chat) {
      this.updateLastAccessed(id).catch((error) =>
        logError('Failed to update last accessed time', error, {
          component: 'IndexedDBStorage',
          metadata: { chatId: id },
        }),
      )
    }
    return chat
  }

  async deleteChat(id: string): Promise<void> {
    const db = await this.ensureDB()

    return new Promise((resolve, reject) => {
      const transaction = db.transaction([CHATS_STORE], 'readwrite')
      const store = transaction.objectStore(CHATS_STORE)
      const request = store.delete(id)

      request.onsuccess = () => resolve()
      request.onerror = () => reject(new Error('Failed to delete chat'))
    })
  }

  async deleteAllNonLocalChats(): Promise<number> {
    const db = await this.ensureDB()

    return new Promise((resolve, reject) => {
      const transaction = db.transaction([CHATS_STORE], 'readwrite')
      const store = transaction.objectStore(CHATS_STORE)
      const request = store.openCursor()
      let deletedCount = 0

      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result
        if (cursor) {
          const chat = cursor.value as StoredChat
          if (!chat.isLocalOnly) {
            cursor.delete()
            deletedCount++
          }
          cursor.continue()
        } else {
          resolve(deletedCount)
        }
      }

      request.onerror = () =>
        reject(new Error('Failed to delete non-local chats'))
    })
  }

  async getAllChatIds(): Promise<string[]> {
    await this.saveQueue.catch(() => {})
    const db = await this.ensureDB()

    return new Promise((resolve, reject) => {
      const transaction = db.transaction([CHATS_STORE], 'readonly')
      const store = transaction.objectStore(CHATS_STORE)
      const request = store.getAllKeys()

      request.onsuccess = () => {
        resolve((request.result as IDBValidKey[]).map((k) => String(k)))
      }
      request.onerror = () => reject(new Error('Failed to list chat IDs'))
    })
  }

  async getChatCount(): Promise<number> {
    await this.saveQueue.catch(() => {})
    const db = await this.ensureDB()

    return new Promise((resolve, reject) => {
      const transaction = db.transaction([CHATS_STORE], 'readonly')
      const store = transaction.objectStore(CHATS_STORE)
      const request = store.count()

      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(new Error('Failed to count chats'))
    })
  }

  async deleteAllChats(): Promise<number> {
    // Serialize through saveQueue so a clear() can't race with an in-flight
    // saveChatInternal that would re-insert a row after the wipe.
    let resolveResult!: (n: number) => void
    let rejectResult!: (e: unknown) => void
    const result = new Promise<number>((resolve, reject) => {
      resolveResult = resolve
      rejectResult = reject
    })

    this.saveQueue = this.saveQueue
      .catch((error) => {
        logError('Previous save operation failed, recovering queue', error, {
          component: 'IndexedDBStorage',
          action: 'deleteAllChats.queueRecovery',
        })
      })
      .then(async () => {
        try {
          const db = await this.ensureDB()
          const total = await new Promise<number>((resolve, reject) => {
            const transaction = db.transaction([CHATS_STORE], 'readwrite')
            const store = transaction.objectStore(CHATS_STORE)
            const countRequest = store.count()

            countRequest.onsuccess = () => {
              const count = countRequest.result
              const clearRequest = store.clear()
              clearRequest.onsuccess = () => resolve(count)
              clearRequest.onerror = () =>
                reject(new Error('Failed to clear chats store'))
            }

            countRequest.onerror = () =>
              reject(new Error('Failed to count chats'))
          })
          resolveResult(total)
        } catch (error) {
          rejectResult(error)
          throw error
        }
      })

    return result
  }

  async getAllChats(): Promise<StoredChat[]> {
    await this.saveQueue.catch(() => {})
    const db = await this.ensureDB()

    return new Promise((resolve, reject) => {
      const transaction = db.transaction([CHATS_STORE], 'readonly')
      const store = transaction.objectStore(CHATS_STORE)
      // Sort by ID (primary key) which contains reverse timestamp
      const request = store.openCursor(null, 'next') // Ascending order on reverse timestamp = most recent first

      const chats: StoredChat[] = []

      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest).result
        if (cursor) {
          const chat = cursor.value
          // Convert string timestamps back to Date objects
          chat.messages = chat.messages.map((msg: any) => ({
            ...msg,
            timestamp: msg.timestamp ? new Date(msg.timestamp) : new Date(),
          }))
          chats.push(chat)
          cursor.continue()
        } else {
          resolve(chats)
        }
      }

      request.onerror = () => reject(new Error('Failed to get all chats'))
    })
  }

  async clearAll(): Promise<void> {
    const db = await this.ensureDB()

    return new Promise((resolve, reject) => {
      const transaction = db.transaction([CHATS_STORE], 'readwrite')
      const store = transaction.objectStore(CHATS_STORE)
      const request = store.clear()

      request.onsuccess = () => resolve()
      request.onerror = () => reject(new Error('Failed to clear all chats'))
    })
  }

  private async updateLastAccessed(id: string): Promise<void> {
    this.saveQueue = this.saveQueue
      .catch((error) => {
        logError('Previous save operation failed, recovering queue', error, {
          component: 'IndexedDBStorage',
          action: 'updateLastAccessed.queueRecovery',
        })
      })
      .then(async () => {
        const db = await this.ensureDB()
        const chat = await this.getChatInternal(id)

        if (chat) {
          return new Promise<void>((resolve, reject) => {
            const transaction = db.transaction([CHATS_STORE], 'readwrite')
            const store = transaction.objectStore(CHATS_STORE)

            transaction.oncomplete = () => resolve()
            transaction.onerror = () =>
              reject(new Error('Failed to update last accessed'))

            chat.lastAccessedAt = Date.now()
            const request = store.put(chat)

            request.onerror = () =>
              reject(new Error('Failed to update last accessed'))
          })
        }
      })
    return this.saveQueue
  }

  async getUnsyncedChats(): Promise<StoredChat[]> {
    // Get all chats and filter for those that need syncing
    const allChats = await this.getAllChats()

    // Return chats that are either:
    // 1. Marked as locally modified
    // 2. Never synced (syncedAt is undefined/null)
    return allChats.filter(
      (chat) =>
        chat.locallyModified === true ||
        chat.syncedAt === undefined ||
        chat.syncedAt === null,
    )
  }

  async markAsSynced(id: string, syncVersion: number): Promise<void> {
    this.saveQueue = this.saveQueue
      .catch((error) => {
        logError('Previous save operation failed, recovering queue', error, {
          component: 'IndexedDBStorage',
          action: 'markAsSynced.queueRecovery',
        })
      })
      .then(async () => {
        const db = await this.ensureDB()
        const chat = await this.getChatInternal(id)

        if (chat) {
          return new Promise<void>((resolve, reject) => {
            const transaction = db.transaction([CHATS_STORE], 'readwrite')
            const store = transaction.objectStore(CHATS_STORE)

            transaction.oncomplete = () => resolve()
            transaction.onerror = () =>
              reject(new Error('Failed to mark as synced'))

            chat.syncedAt = Date.now()
            chat.locallyModified = false
            chat.syncVersion = syncVersion

            const request = store.put(chat)

            request.onerror = () =>
              reject(new Error('Failed to mark as synced'))
          })
        }
      })
    return this.saveQueue
  }

  async getChatsWithEncryptedData(): Promise<StoredChat[]> {
    const allChats = await this.getAllChats()
    return allChats.filter(
      (chat) => chat.decryptionFailed && chat.encryptedData,
    )
  }

  async resetChatTimestamps(chatId: string): Promise<void> {
    this.saveQueue = this.saveQueue
      .catch((error) => {
        logError('Previous save operation failed, recovering queue', error, {
          component: 'IndexedDBStorage',
          action: 'resetChatTimestamps.queueRecovery',
        })
      })
      .then(async () => {
        const db = await this.ensureDB()
        const chat = await this.getChatInternal(chatId)

        if (chat) {
          return new Promise<void>((resolve, reject) => {
            const transaction = db.transaction([CHATS_STORE], 'readwrite')
            const store = transaction.objectStore(CHATS_STORE)

            transaction.oncomplete = () => resolve()
            transaction.onerror = () =>
              reject(new Error('Failed to reset chat timestamps'))

            const now = new Date().toISOString()
            chat.createdAt = now
            chat.updatedAt = now
            chat.locallyModified = true
            chat.syncedAt = undefined

            const request = store.put(chat)

            request.onerror = () =>
              reject(new Error('Failed to reset chat timestamps'))
          })
        }
      })
    return this.saveQueue
  }

  async updateChatProject(
    chatId: string,
    projectId: string | null,
  ): Promise<void> {
    const chat = await this.getChatInternal(chatId)
    if (chat) {
      chat.projectId = projectId ?? undefined
      chat.locallyModified = true
      chat.updatedAt = new Date().toISOString()
      await this.saveChatInternal(chat)
    }
  }

  async updateChatLocalOnly(
    chatId: string,
    isLocalOnly: boolean,
  ): Promise<void> {
    const chat = await this.getChatInternal(chatId)
    if (chat) {
      chat.isLocalOnly = isLocalOnly
      chat.locallyModified = true
      chat.updatedAt = new Date().toISOString()
      await this.saveChatInternal(chat)
    }
  }
}

export const indexedDBStorage = new IndexedDBStorage()
