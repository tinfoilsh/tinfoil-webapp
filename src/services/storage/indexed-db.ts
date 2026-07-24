import type { Chat as ChatType } from '@/components/chat/types'
import { nextClock } from '@/services/cloud/edit-clock'
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
  formatVersion?: number
  decryptionFailed?: boolean
  dataCorrupted?: boolean
  version?: number
  loadedAt?: number
  isLocalOnly?: boolean
  isBlankChat?: boolean
  // Logical edit clock for conflict arbitration. `clock`/`writer` are
  // bumped on each local content edit; `clockVersion` records the
  // syncVersion the clock was last maintained at, so a reader can tell
  // whether a clock-unaware client wrote since (see remoteWins).
  clock?: number
  writer?: string
  clockVersion?: number
}

/**
 * Rewrite emitted by the upload path when the enclave mints a fresh
 * attachment id + per-attachment key. `clientId` is what the local
 * attachment used before the upload; `serverId` and `encryptionKey`
 * are what the chat envelope was sealed with. `finalizeUpload`
 * applies these against the freshest local copy so we never mutate
 * the wrong attachment after a concurrent edit.
 */
export interface AttachmentRewrite {
  clientId: string
  serverId: string
  encryptionKey: string
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
  pendingRecoveries?: any[]
}): string {
  const messages = (chat.messages || []).map((m) => ({
    role: m.role,
    content: m.content,
    turnId: m.turnId,
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
    pendingRecoveries: chat.pendingRecoveries ?? [],
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
  private saveQueue: Promise<unknown> = Promise.resolve()

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

  /**
   * Serialize a write behind every previously queued one. The
   * returned promise is the caller's view of the operation (typed
   * result, rejections included); the same promise becomes the new
   * queue tail so a failure is logged as "recovered" by whichever
   * operation queues next.
   */
  private enqueueSave<T>(
    action: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const result = this.saveQueue
      .catch((error) => {
        logError('Previous save operation failed, recovering queue', error, {
          component: 'IndexedDBStorage',
          action: `${action}.queueRecovery`,
        })
      })
      .then(operation)
    this.saveQueue = result
    return result
  }

  async saveChat(chat: Chat): Promise<void> {
    const chatSnapshot = JSON.parse(JSON.stringify(chat))
    return this.enqueueSave('saveChat', () =>
      this.saveChatInternal(chatSnapshot),
    )
  }

  async saveExistingChat(chat: Chat): Promise<void> {
    const chatSnapshot = JSON.parse(JSON.stringify(chat))
    return this.enqueueSave('saveExistingChat', () =>
      this.saveChatInternal(chatSnapshot, { requireExisting: true }),
    )
  }

  async mutateChat(
    chatId: string,
    mutation: (chat: StoredChat) => {
      chat: StoredChat
      changed: boolean
    },
  ): Promise<StoredChat | null> {
    return this.enqueueSave('mutateChat', async () => {
      const db = await this.ensureDB()
      return new Promise<StoredChat | null>((resolve, reject) => {
        const transaction = db.transaction([CHATS_STORE], 'readwrite')
        const store = transaction.objectStore(CHATS_STORE)
        let output: StoredChat | null = null

        transaction.oncomplete = () => resolve(output)
        transaction.onerror = () => reject(new Error('Failed to mutate chat'))
        transaction.onabort = () =>
          reject(new Error('Chat mutation transaction aborted'))

        const request = store.get(chatId)
        request.onerror = () => reject(new Error('Failed to read chat'))
        request.onsuccess = () => {
          const current = request.result as StoredChat | undefined
          if (!current) return

          const result = mutation(current)
          if (!result.changed) {
            output = result.chat
            return
          }

          const clock = nextClock(current.clock)
          output = {
            ...result.chat,
            messages: result.chat.messages.map((message) => ({
              ...message,
              timestamp:
                message.timestamp instanceof Date
                  ? message.timestamp.toISOString()
                  : message.timestamp,
            })) as any,
            lastAccessedAt: Date.now(),
            clock: clock.v,
            writer: clock.w,
            locallyModified: computeLocallyModified({
              isFailedDecryption: current.decryptionFailed === true,
              existingChat: current,
              hasContentChanges: true,
              callerValue: result.chat.locallyModified,
            }),
            version: 1,
          }
          store.put(output)
        }
      })
    })
  }

  private async saveChatInternal(
    chat: Chat,
    options: {
      requireExisting?: boolean
      markContentChangesAsLocal?: boolean
    } = {},
  ): Promise<void> {
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
        if (options.requireExisting && !existingChat) {
          resolve()
          return
        }

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
              pendingRecoveries: existingChat.pendingRecoveries,
            }) !==
            chatContentFingerprint({
              title: chat.title,
              projectId: (chat as StoredChat).projectId,
              messages: messagesForStorage,
              pendingRecoveries: (chat as StoredChat).pendingRecoveries,
            })
          : false

        // Never mark chats that failed to decrypt as locally modified.
        // These are placeholder chats with empty messages that should NOT be uploaded.
        // If we set locallyModified: true, they would overwrite real encrypted data on the server.
        const isFailedDecryption =
          (chat as StoredChat).decryptionFailed === true

        // Bump the edit clock only on a genuine local content edit: a
        // changed existing chat, or a brand-new locally-created one.
        // Re-saves that don't touch content (and synced writes) keep the
        // existing clock so they don't outrank a real concurrent edit.
        const bumpClock =
          !isFailedDecryption &&
          options.markContentChangesAsLocal !== false &&
          (hasContentChanges ||
            (!existingChat && ((chat as StoredChat).locallyModified ?? true)))
        const bumpedClock = bumpClock
          ? nextClock(existingChat?.clock ?? (chat as StoredChat).clock)
          : null

        const storedChat: StoredChat = {
          ...chat,
          messages: messagesForStorage as any,
          lastAccessedAt: Date.now(),
          syncedAt: existingChat?.syncedAt ?? (chat as StoredChat).syncedAt,
          clock:
            bumpedClock?.v ?? existingChat?.clock ?? (chat as StoredChat).clock,
          writer:
            bumpedClock?.w ??
            existingChat?.writer ??
            (chat as StoredChat).writer,
          clockVersion:
            existingChat?.clockVersion ?? (chat as StoredChat).clockVersion,
          // For existing chats: mark as modified if content changed, or preserve existing modified state
          // This ensures modified chats are always picked up for sync even if they were
          // loaded with locallyModified: false from a previous sync
          // For new chats: use provided value or default to true
          // IMPORTANT: Never mark failed-to-decrypt chats as modified - they are placeholders
          locallyModified: computeLocallyModified({
            isFailedDecryption,
            existingChat,
            hasContentChanges:
              options.markContentChangesAsLocal === false
                ? false
                : hasContentChanges,
            callerValue: (chat as StoredChat).locallyModified,
          }),
          syncVersion:
            existingChat?.syncVersion ?? (chat as StoredChat).syncVersion,
          decryptionFailed: (chat as StoredChat).decryptionFailed,
          dataCorrupted: (chat as StoredChat).dataCorrupted,
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
    // Serialize through saveQueue so a deletion can't race with an in-flight
    // saveChatInternal that would resurrect the row after the delete.
    return this.enqueueSave('deleteChat', async () => {
      const db = await this.ensureDB()
      return new Promise<void>((resolve, reject) => {
        const transaction = db.transaction([CHATS_STORE], 'readwrite')
        const store = transaction.objectStore(CHATS_STORE)
        const request = store.delete(id)

        transaction.oncomplete = () => resolve()
        transaction.onerror = () => reject(new Error('Failed to delete chat'))
        request.onerror = () => reject(new Error('Failed to delete chat'))
      })
    })
  }

  async deleteChatIfUnchanged(
    id: string,
    expectedUpdatedAt: string,
    isCurrent: () => boolean = () => true,
  ): Promise<boolean> {
    return this.enqueueSave('deleteChatIfUnchanged', async () => {
      if (!isCurrent()) return false
      const db = await this.ensureDB()
      if (!isCurrent()) return false
      return new Promise<boolean>((resolve, reject) => {
        const transaction = db.transaction([CHATS_STORE], 'readwrite')
        const store = transaction.objectStore(CHATS_STORE)
        let deleted = false
        const getRequest = store.get(id)

        getRequest.onsuccess = () => {
          if (!isCurrent()) return
          const chat = getRequest.result as StoredChat | undefined
          if (!chat || chat.updatedAt !== expectedUpdatedAt) return
          store.delete(id)
          deleted = true
        }
        transaction.oncomplete = () => resolve(deleted)
        transaction.onerror = () =>
          reject(new Error('Failed to conditionally delete chat'))
        getRequest.onerror = () =>
          reject(new Error('Failed to read chat for conditional deletion'))
      })
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

  async deleteChatsByProject(projectId: string): Promise<string[]> {
    // Serialize through saveQueue so deletions can't race with an in-flight
    // saveChatInternal that would resurrect a row after the delete.
    return this.enqueueSave('deleteChatsByProject', async () => {
      const db = await this.ensureDB()
      return new Promise<string[]>((resolve, reject) => {
        const transaction = db.transaction([CHATS_STORE], 'readwrite')
        const store = transaction.objectStore(CHATS_STORE)
        const request = store.openCursor()
        const deletedIds: string[] = []

        request.onsuccess = (event) => {
          const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result
          if (cursor) {
            const chat = cursor.value as StoredChat
            if (chat.projectId === projectId) {
              deletedIds.push(chat.id)
              cursor.delete()
            }
            cursor.continue()
          }
        }

        transaction.oncomplete = () => resolve(deletedIds)
        transaction.onerror = () =>
          reject(new Error('Failed to delete project chats'))
        request.onerror = () =>
          reject(new Error('Failed to delete project chats'))
      })
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
    return this.enqueueSave('deleteAllChats', async () => {
      const db = await this.ensureDB()
      return new Promise<number>((resolve, reject) => {
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

        countRequest.onerror = () => reject(new Error('Failed to count chats'))
      })
    })
  }

  // Count chats that are eligible for cloud sync (everything except
  // local-only rows). Cheaper than getAllChats when the caller only
  // needs the total — avoids deserializing every stored message.
  async getCloudChatCount(): Promise<number> {
    await this.saveQueue.catch(() => {})
    const db = await this.ensureDB()

    return new Promise((resolve, reject) => {
      const transaction = db.transaction([CHATS_STORE], 'readonly')
      const store = transaction.objectStore(CHATS_STORE)
      const request = store.openCursor()
      let count = 0

      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest).result
        if (cursor) {
          const chat = cursor.value
          if (!chat.isLocalOnly) {
            count++
          }
          cursor.continue()
        } else {
          resolve(count)
        }
      }

      request.onerror = () => reject(new Error('Failed to count chats'))
    })
  }

  async hasPendingChatRecoveries(): Promise<boolean> {
    await this.saveQueue.catch(() => {})
    const db = await this.ensureDB()

    return new Promise((resolve, reject) => {
      const transaction = db.transaction([CHATS_STORE], 'readonly')
      const store = transaction.objectStore(CHATS_STORE)
      const request = store.openCursor()

      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue | null>)
          .result
        if (!cursor) {
          resolve(false)
          return
        }
        const chat = cursor.value as StoredChat
        if ((chat.pendingRecoveries?.length ?? 0) > 0) {
          resolve(true)
          return
        }
        cursor.continue()
      }

      request.onerror = () =>
        reject(new Error('Failed to inspect pending chat recoveries'))
    })
  }

  async isChatHistoryAuthoritative(
    expectedCloudVersions: ReadonlyMap<string, number>,
  ): Promise<boolean> {
    await this.saveQueue.catch(() => {})
    const db = await this.ensureDB()

    return new Promise((resolve, reject) => {
      const transaction = db.transaction([CHATS_STORE], 'readonly')
      const store = transaction.objectStore(CHATS_STORE)
      const request = store.openCursor()
      const missingCloudVersions = new Map(expectedCloudVersions)

      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue | null>)
          .result
        if (!cursor) {
          resolve(missingCloudVersions.size === 0)
          return
        }
        const chat = cursor.value as StoredChat
        if (!chat.isLocalOnly) {
          const expectedVersion = missingCloudVersions.get(chat.id)
          if (
            chat.locallyModified ||
            chat.decryptionFailed ||
            expectedVersion === undefined ||
            chat.syncVersion !== expectedVersion
          ) {
            resolve(false)
            return
          }
          missingCloudVersions.delete(chat.id)
        }
        cursor.continue()
      }

      request.onerror = () =>
        reject(new Error('Failed to verify local chat history'))
    })
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
    return this.enqueueSave('updateLastAccessed', async () => {
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
    return this.enqueueSave('markAsSynced', async () => {
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
          // The clock is now current as of this synced version, so a
          // later reader trusts it for arbitration.
          chat.clockVersion = syncVersion

          const request = store.put(chat)

          request.onerror = () => reject(new Error('Failed to mark as synced'))
        })
      }
    })
  }

  /**
   * Rebase a chat's sync version onto the server's current version
   * while KEEPING `locallyModified` set. Used by last-write-wins
   * conflict resolution (§C5) when the local copy is the fresher
   * write: the next upload's If-Match must match the server's current
   * ETag so the CAS succeeds and the local content wins, instead of
   * looping on STALE_BLOB forever. Unlike `markAsSynced`, this never
   * clears the dirty flag, so the chat is still uploaded.
   */
  async rebaseSyncVersion(id: string, syncVersion: number): Promise<void> {
    return this.enqueueSave('rebaseSyncVersion', async () => {
      const db = await this.ensureDB()
      const chat = await this.getChatInternal(id)
      if (!chat) {
        return
      }

      chat.syncVersion = syncVersion
      chat.locallyModified = true

      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction([CHATS_STORE], 'readwrite')
        const store = transaction.objectStore(CHATS_STORE)
        transaction.oncomplete = () => resolve()
        transaction.onerror = () =>
          reject(new Error('Failed to rebase sync version'))
        const request = store.put(chat)
        request.onerror = () =>
          reject(new Error('Failed to rebase sync version'))
      })
    })
  }

  /**
   * Atomic upload finalization (§C6 / §H5).
   *
   * Runs inside `saveQueue` so it is serialized with any concurrent
   * user saves. Re-reads the chat fresh, applies attachment id/key
   * rewrites by stable client id (not by position), and only clears
   * `locallyModified` if no edit happened since `preUploadUpdatedAt`.
   *
   * If a concurrent edit is detected, the new sync version is still
   * persisted but the chat stays `locallyModified=true` so the next
   * sync cycle uploads the new content.
   */
  async finalizeUpload(opts: {
    chatId: string
    rewrites: AttachmentRewrite[]
    preUploadUpdatedAt: string | undefined
    syncVersion: number
  }): Promise<void> {
    return this.enqueueSave('finalizeUpload', async () => {
      const db = await this.ensureDB()
      const chat = await this.getChatInternal(opts.chatId)
      if (!chat) {
        return
      }

      if (opts.rewrites.length > 0) {
        const rewriteByClient = new Map(
          opts.rewrites.map((r) => [r.clientId, r]),
        )
        for (const msg of chat.messages ?? []) {
          for (const att of msg.attachments ?? []) {
            const rewrite = rewriteByClient.get(att.id)
            if (rewrite) {
              att.id = rewrite.serverId
              att.encryptionKey = rewrite.encryptionKey
            }
          }
        }
      }

      const concurrentEdit =
        opts.preUploadUpdatedAt !== undefined &&
        chat.updatedAt !== opts.preUploadUpdatedAt

      chat.syncVersion = opts.syncVersion
      if (!concurrentEdit) {
        chat.locallyModified = false
        chat.syncedAt = Date.now()
        // Clock is current as of the uploaded version. On a concurrent
        // edit the chat stays dirty and clockVersion intentionally lags
        // so the next upload re-stamps it.
        chat.clockVersion = opts.syncVersion
      }

      return new Promise<void>((resolve, reject) => {
        const transaction = db.transaction([CHATS_STORE], 'readwrite')
        const store = transaction.objectStore(CHATS_STORE)
        transaction.oncomplete = () => resolve()
        transaction.onerror = () =>
          reject(new Error('Failed to finalize upload'))

        const request = store.put(chat)
        request.onerror = () => reject(new Error('Failed to finalize upload'))
      })
    })
  }

  /**
   * CAS ingest (§H6). Apply a remote chat locally only when the
   * on-disk row still matches the snapshot the caller observed.
   * Returns `{ applied: true }` on write and `{ applied: false }`
   * when an interleaved local edit means the remote would clobber
   * the user's in-progress work.
   *
   * Pass `expectedLocalUpdatedAt: undefined` to force the write
   * (e.g. last-write-wins conflict resolution).
   *
   * Pass `allowLocallyModified: true` to keep the timestamp CAS while
   * permitting an overwrite of a `locallyModified` row. Last-write-wins
   * conflict resolution uses this: the remote has already been judged
   * the winner, but the apply must still no-op if the local row changed
   * since that judgement (a TOCTOU edit during the remote download).
   */
  async applyRemoteChatIfFresh(opts: {
    chat: Chat
    syncVersion: number
    expectedLocalUpdatedAt: string | null | undefined
    setLoadedAt?: boolean
    allowLocallyModified?: boolean
    isCurrent?: () => boolean
  }): Promise<{ applied: boolean }> {
    return this.enqueueSave('applyRemoteChatIfFresh', async () => {
      const isCurrent = opts.isCurrent ?? (() => true)
      if (!isCurrent()) return { applied: false }
      const db = await this.ensureDB()
      if (!isCurrent()) return { applied: false }
      const existing = await this.getChatInternal(opts.chat.id)
      if (!isCurrent()) return { applied: false }

      if (opts.expectedLocalUpdatedAt !== undefined) {
        if (opts.expectedLocalUpdatedAt === null) {
          if (existing) {
            return { applied: false }
          }
        } else if (
          !existing ||
          existing.updatedAt !== opts.expectedLocalUpdatedAt ||
          (existing.locallyModified === true && !opts.allowLocallyModified)
        ) {
          return { applied: false }
        }
      }

      const messagesForStorage = opts.chat.messages.map((msg) => ({
        ...msg,
        timestamp:
          msg.timestamp instanceof Date
            ? msg.timestamp.toISOString()
            : msg.timestamp,
      }))

      const storedChat: StoredChat = {
        ...opts.chat,
        messages: messagesForStorage as any,
        lastAccessedAt: Date.now(),
        syncedAt: Date.now(),
        locallyModified: false,
        syncVersion: opts.syncVersion,
        version: 1,
        loadedAt: opts.setLoadedAt
          ? Date.now()
          : ((opts.chat as StoredChat).loadedAt ?? existing?.loadedAt),
        isLocalOnly: (opts.chat as any).isLocalOnly ?? false,
      }

      if (!isCurrent()) return { applied: false }
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction([CHATS_STORE], 'readwrite')
        const store = transaction.objectStore(CHATS_STORE)
        transaction.oncomplete = () => resolve()
        transaction.onerror = () =>
          reject(new Error('Failed to apply remote chat'))
        const request = store.put(storedChat)
        request.onerror = () => reject(new Error('Failed to apply remote chat'))
      })
      return { applied: true }
    })
  }

  /**
   * Wipe sync metadata for every chat (§H4). Called after a
   * `start_fresh` rotation so subsequent pushes go up as fresh
   * creates instead of failing the next ETag CAS forever.
   */
  async resetSyncMetadataForAllChats(): Promise<void> {
    return this.enqueueSave('resetSyncMetadataForAllChats', async () => {
      const db = await this.ensureDB()
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction([CHATS_STORE], 'readwrite')
        const store = transaction.objectStore(CHATS_STORE)
        transaction.oncomplete = () => resolve()
        transaction.onerror = () =>
          reject(new Error('Failed to reset sync metadata'))

        const request = store.openCursor()
        request.onsuccess = (event) => {
          const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result
          if (!cursor) return
          const chat = cursor.value as StoredChat
          chat.syncVersion = 0
          chat.syncedAt = undefined
          chat.locallyModified = true
          cursor.update(chat)
          cursor.continue()
        }
        request.onerror = () =>
          reject(new Error('Failed to iterate chats for sync reset'))
      })
    })
  }

  async resetChatTimestamps(chatId: string): Promise<void> {
    return this.enqueueSave('resetChatTimestamps', async () => {
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
  }

  async updateChatProject(
    chatId: string,
    projectId: string | null,
  ): Promise<void> {
    return this.enqueueSave('updateChatProject', async () => {
      const chat = await this.getChatInternal(chatId)
      if (chat) {
        chat.projectId = projectId ?? undefined
        chat.locallyModified = true
        chat.updatedAt = new Date().toISOString()
        await this.saveChatInternal(chat)
      }
    })
  }

  async applyRemoteChatProject(
    chatId: string,
    projectId: string | null,
    expectedLocalUpdatedAt: string | null,
  ): Promise<boolean> {
    return this.enqueueSave('applyRemoteChatProject', async () => {
      const chat = await this.getChatInternal(chatId)
      if (
        !chat ||
        chat.updatedAt !== expectedLocalUpdatedAt ||
        chat.locallyModified
      ) {
        return false
      }
      chat.projectId = projectId ?? undefined
      await this.saveChatInternal(chat, {
        markContentChangesAsLocal: false,
      })
      return true
    })
  }

  async updateChatLocalOnly(
    chatId: string,
    isLocalOnly: boolean,
  ): Promise<void> {
    return this.enqueueSave('updateChatLocalOnly', async () => {
      const chat = await this.getChatInternal(chatId)
      if (chat) {
        chat.isLocalOnly = isLocalOnly
        chat.locallyModified = true
        chat.updatedAt = new Date().toISOString()
        await this.saveChatInternal(chat)
      }
    })
  }
}

export const indexedDBStorage = new IndexedDBStorage()
