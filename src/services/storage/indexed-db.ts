import type {
  Attachment,
  Chat as ChatType,
  Message,
} from '@/components/chat/types'
import { ACCOUNT_RESET_FAILED_EVENT } from '@/constants/auth-events'
import {
  AUTH_ACCOUNT_RESET_FAILED,
  AUTH_ACCOUNT_RESET_SIGNAL,
  AUTH_ACTIVE_USER_ID,
} from '@/constants/storage-keys'
import type { PendingRecoveryEnvelope } from '@/types/chat-recovery'
import { logError, logWarning } from '@/utils/error-handling'
import { bytesToHex } from '@noble/hashes/utils.js'
import { deletedChatsTracker } from './deleted-chats-tracker'

export interface Chat extends Omit<ChatType, 'createdAt'> {
  createdAt: string
  updatedAt: string
  model?: string
  pendingRecoveries?: PendingRecoveryEnvelope[]
}

export interface StoredChat extends Chat {
  lastAccessedAt: number
  syncedAt?: number
  syncVersion?: number
  formatVersion?: number
  decryptionFailed?: boolean
  dataCorrupted?: boolean
  version?: number
  loadedAt?: number
  isLocalOnly?: boolean
  isBlankChat?: boolean
  syncUserId?: string
  projectLocallyModified?: boolean
}

export interface SaveChatResult {
  saved: boolean
  isLocalOnly: boolean
}

interface StoredAttachmentPayload {
  id: string
  chatId: string
  base64?: string
  thumbnailBase64?: string
  textContent?: string
  pages?: Attachment['pages']
}

type StoredAttachmentReference = Attachment & {
  storagePayloadId?: string
}

export class AttachmentPayloadIdUnavailableError extends Error {
  readonly code = 'ATTACHMENT_PAYLOAD_ID_UNAVAILABLE'

  constructor() {
    super('Secure random UUID generation is unavailable')
    this.name = 'AttachmentPayloadIdUnavailableError'
  }
}

export class AttachmentPayloadMissingError extends Error {
  readonly code = 'ATTACHMENT_PAYLOAD_MISSING'

  constructor() {
    super('Stored attachment payload is missing')
    this.name = 'AttachmentPayloadMissingError'
  }
}

export const DB_NAME = 'tinfoil-chat'
export const DB_VERSION = 7
const CHATS_STORE = 'chats'
const CHATS_PROJECT_INDEX = 'projectId'
const CHATS_SYNC_PENDING_INDEX = 'syncPending'
const PROJECTS_STORE = 'projects'
const PROJECTS_USER_INDEX = 'userId'
const MIGRATIONS_STORE = 'migrations'
const SYNC_PENDING_MIGRATION_ID = 'sync-pending-v4'
const ATTACHMENT_PAYLOADS_STORE = 'attachmentPayloads'
const ATTACHMENT_PAYLOADS_CHAT_INDEX = 'chatId'
const GENERATED_ATTACHMENT_PAYLOAD_PREFIX = 'attachment-payload:'
const CHAT_SUMMARIES_STORE = 'chatSummaries'
const CHAT_SUMMARIES_MIGRATION_ID = 'chat-summaries-v6'
const SYNC_STATE_STORE = 'sync_state'
const REMOTE_CHAT_STATE_STORE = 'remote_chat_state'
const SYNC_OUTBOX_STORE = 'sync_outbox'
const ACCOUNT_CHANGE_RESET_TIMEOUT_MS = 10_000
const ACCOUNT_CHANGE_READ_ERROR = 'IndexedDB read superseded by account change'
const ACCOUNT_CHANGE_WRITE_ERROR =
  'IndexedDB write superseded by account change'
const textEncoder = new TextEncoder()

function deserializeStoredChat(chat: StoredChat): StoredChat {
  if (!Array.isArray(chat.messages)) {
    throw new Error('Stored chat has invalid messages')
  }

  // Full rows always carry their real messages; drop summary markers that
  // an earlier write may have leaked so readers never mistake a hydrated
  // chat for a summary.
  const { isMetadataOnly, messageCount, ...fullChat } = chat

  return {
    ...fullChat,
    messages: chat.messages.map((message) => ({
      ...message,
      timestamp: message.timestamp ? new Date(message.timestamp) : new Date(),
    })),
  } as StoredChat
}

function toStoredChatSummary(chat: StoredChat): StoredChat {
  return {
    ...chat,
    messages: [],
    messageCount: Array.isArray(chat.messages) ? chat.messages.length : 0,
    isMetadataOnly: true,
  }
}

function putStoredChat(
  chatStore: IDBObjectStore,
  summaryStore: IDBObjectStore,
  chat: StoredChat,
): IDBRequest<IDBValidKey> {
  summaryStore.put(toStoredChatSummary(chat))
  // isMetadataOnly/messageCount describe summary rows only; persisting
  // them on the full row would make hydrated reads look like summaries.
  const { isMetadataOnly, messageCount, ...fullRow } = chat
  return chatStore.put(fullRow)
}

/**
 * Copies mutable chat containers without duplicating immutable attachment
 * payload strings. New nested message fields must be snapshotted here.
 */
function snapshotChatForStorage(chat: Chat): Chat {
  return {
    ...chat,
    pendingRecoveries: chat.pendingRecoveries?.map((recovery) => ({
      ...recovery,
    })),
    messages: chat.messages.map((message) => ({
      ...message,
      attachments: message.attachments?.map((attachment) => ({
        ...attachment,
        pages: attachment.pages?.map((page) => ({ ...page })),
      })),
      annotations: message.annotations?.map((annotation) => ({
        ...annotation,
        url_citation: { ...annotation.url_citation },
      })),
      codeExecCalls: message.codeExecCalls?.map((call) => ({ ...call })),
      documents: message.documents?.map((document) => ({ ...document })),
      imageData: message.imageData?.map((image) => ({ ...image })),
      timeline: message.timeline
        ? structuredClone(message.timeline)
        : undefined,
      toolCalls: message.toolCalls?.map((call) => ({ ...call })),
      urlFetches: message.urlFetches?.map((urlFetch) => ({
        ...urlFetch,
        sources: urlFetch.sources?.map((source) => ({ ...source })),
      })),
      webSearch: message.webSearch
        ? {
            ...message.webSearch,
            sources: message.webSearch.sources?.map((source) => ({
              ...source,
            })),
          }
        : undefined,
    })),
  }
}

function attachmentHasPayload(attachment: Attachment): boolean {
  return (
    attachment.base64 !== undefined ||
    attachment.thumbnailBase64 !== undefined ||
    attachment.textContent !== undefined ||
    attachment.pages !== undefined
  )
}

function isLazilyRetrievableAttachment(attachment: Attachment): boolean {
  return (
    attachment.id.trim().length > 0 &&
    typeof attachment.encryptionKey === 'string' &&
    attachment.encryptionKey.trim().length > 0
  )
}

function createAttachmentPayloadId(
  chatId: string,
  reservedPayloadIds: Set<string>,
): string {
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    throw new AttachmentPayloadIdUnavailableError()
  }

  const token = globalThis.crypto.randomUUID()
  const encodedChatId = bytesToHex(textEncoder.encode(chatId))
  const baseId = `${GENERATED_ATTACHMENT_PAYLOAD_PREFIX}${encodedChatId}:${token}`
  let payloadId = baseId
  let collision = 0
  while (reservedPayloadIds.has(payloadId)) {
    collision += 1
    payloadId = `${baseId}:${collision}`
  }
  reservedPayloadIds.add(payloadId)
  return payloadId
}

function normalizeAttachmentPayloads(chat: Chat): {
  messages: Message[]
  payloads: StoredAttachmentPayload[]
  referencedPayloadIds: Set<string>
} {
  const payloads: StoredAttachmentPayload[] = []
  const referencedPayloadIds = new Set<string>()
  const attachmentIdOccurrences = new Map<string, number>()
  const reservedPayloadIds = new Set<string>()
  const explicitlyReferencedPayloadIds = new Set<string>()

  for (const message of chat.messages) {
    for (const attachment of message.attachments ?? []) {
      reservedPayloadIds.add(`${chat.id}:${attachment.id}`)
      const storagePayloadId = (attachment as StoredAttachmentReference)
        .storagePayloadId
      if (storagePayloadId) {
        reservedPayloadIds.add(storagePayloadId)
        explicitlyReferencedPayloadIds.add(storagePayloadId)
      }
    }
  }

  const messages = chat.messages.map((message) => ({
    ...message,
    attachments: message.attachments?.map((attachment) => {
      const storedAttachment = attachment as StoredAttachmentReference
      const occurrence = attachmentIdOccurrences.get(attachment.id) ?? 0
      attachmentIdOccurrences.set(attachment.id, occurrence + 1)
      const legacyPayloadId = `${chat.id}:${attachment.id}`
      const referencedPayloadId = storedAttachment.storagePayloadId
      const payloadId =
        referencedPayloadId && !referencedPayloadIds.has(referencedPayloadId)
          ? referencedPayloadId
          : occurrence === 0 &&
              !referencedPayloadIds.has(legacyPayloadId) &&
              !explicitlyReferencedPayloadIds.has(legacyPayloadId)
            ? legacyPayloadId
            : createAttachmentPayloadId(chat.id, reservedPayloadIds)
      referencedPayloadIds.add(payloadId)
      const { base64, thumbnailBase64, textContent, pages, ...metadata } =
        storedAttachment

      if (attachmentHasPayload(attachment)) {
        payloads.push({
          id: payloadId,
          chatId: chat.id,
          base64,
          thumbnailBase64,
          textContent,
          pages,
        })
      }

      return {
        ...metadata,
        storagePayloadId: payloadId,
      }
    }),
  }))

  return {
    messages,
    payloads,
    referencedPayloadIds,
  }
}

function normalizeAttachmentPayloadsInTransaction(
  chat: Chat,
  transaction: IDBTransaction,
  reject: (reason?: unknown) => void,
): ReturnType<typeof normalizeAttachmentPayloads> | null {
  try {
    return normalizeAttachmentPayloads(chat)
  } catch (error) {
    transaction.abort()
    reject(error)
    return null
  }
}

function hydrateAttachmentPayloads(
  chat: StoredChat,
  payloads: StoredAttachmentPayload[],
): StoredChat {
  const payloadById = new Map(payloads.map((payload) => [payload.id, payload]))

  return {
    ...chat,
    messages: chat.messages.map((message) => ({
      ...message,
      attachments: message.attachments?.map((attachment) => {
        const { storagePayloadId, ...metadata } =
          attachment as StoredAttachmentReference
        if (!storagePayloadId) {
          if (
            attachmentHasPayload(metadata) ||
            isLazilyRetrievableAttachment(metadata)
          ) {
            return metadata
          }
          throw new AttachmentPayloadMissingError()
        }
        const payload = storagePayloadId
          ? payloadById.get(storagePayloadId)
          : undefined
        if (!payload) {
          if (isLazilyRetrievableAttachment(metadata)) {
            return { ...metadata, storagePayloadId }
          }
          throw new AttachmentPayloadMissingError()
        }
        const { id, chatId, ...content } = payload
        return { ...metadata, storagePayloadId, ...content }
      }),
    })),
  }
}

function deleteAttachmentPayloadsForChat(
  store: IDBObjectStore,
  chatId: string,
): void {
  const request = store
    .index(ATTACHMENT_PAYLOADS_CHAT_INDEX)
    .openKeyCursor(IDBKeyRange.only(chatId))
  request.onsuccess = () => {
    const cursor = request.result
    if (!cursor) return
    store.delete(cursor.primaryKey)
    cursor.continue()
  }
}

function activeUserId(): string | undefined {
  if (typeof window === 'undefined') return undefined
  try {
    return localStorage.getItem(AUTH_ACTIVE_USER_ID) ?? undefined
  } catch {
    return undefined
  }
}

function chatOwnerId(chat: StoredChat | Chat): string | undefined {
  return (
    (chat as StoredChat).syncUserId ??
    (chat as StoredChat & { userId?: string }).userId
  )
}

export class IndexedDBStorage {
  private db: IDBDatabase | null = null
  private initializationPromise: Promise<void> | null = null
  private saveQueue: Promise<unknown> = Promise.resolve()
  private chatSummariesReady = false
  private saveGeneration = 0
  // Account cleanup always reloads; keep this instance fail-closed until then.
  private accountResetStarted = false
  private accountResetPromise: Promise<void> | null = null
  private activeSaveGeneration: number | null = null
  private readonly accountResetSignal: Promise<never>
  private rejectAccountReads!: (reason: Error) => void

  constructor() {
    this.accountResetSignal = new Promise((_, reject) => {
      this.rejectAccountReads = reject
    })
    void this.accountResetSignal.catch(() => {})
  }

  async initialize(): Promise<void> {
    if (this.db) return
    if (this.initializationPromise) return this.initializationPromise

    // Check if IndexedDB is available
    if (typeof window === 'undefined' || !window.indexedDB) {
      throw new Error('IndexedDB not available')
    }

    const saveGeneration = this.saveGeneration
    const initializationPromise = new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION)
      let abandoned = false

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
        if (abandoned) {
          request.result.close()
          return
        }
        const db = request.result
        db.onversionchange = () => {
          db.close()
          if (this.db === db) {
            this.db = null
          }
        }

        if (saveGeneration !== this.saveGeneration) {
          db.close()
          reject(new Error('Database open superseded by account change'))
          return
        }

        this.db = db
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
            store.createIndex(CHATS_SYNC_PENDING_INDEX, 'syncPending', {
              unique: false,
            })
            store.createIndex(CHATS_PROJECT_INDEX, 'projectId', {
              unique: false,
            })
            store.createIndex(
              'pendingUploadByUser',
              ['pendingUpload', 'syncUserId'],
              { unique: false },
            )
          } else {
            const store = request.transaction!.objectStore(CHATS_STORE)
            if (store.indexNames.contains('locallyModified')) {
              store.deleteIndex('locallyModified')
            }
            if (!store.indexNames.contains(CHATS_PROJECT_INDEX)) {
              store.createIndex(CHATS_PROJECT_INDEX, 'projectId', {
                unique: false,
              })
            }
            if (!store.indexNames.contains(CHATS_SYNC_PENDING_INDEX)) {
              store.createIndex(CHATS_SYNC_PENDING_INDEX, 'syncPending', {
                unique: false,
              })
            }
            if (store.indexNames.contains('pendingUpload')) {
              store.deleteIndex('pendingUpload')
            }
            if (!store.indexNames.contains('pendingUploadByUser')) {
              store.createIndex(
                'pendingUploadByUser',
                ['pendingUpload', 'syncUserId'],
                { unique: false },
              )
            }
            const cursorRequest = store.openCursor()
            cursorRequest.onsuccess = () => {
              const cursor = cursorRequest.result
              if (!cursor) return
              const chat = cursor.value as StoredChat
              chat.syncUserId ??= chatOwnerId(chat) ?? activeUserId()
              cursor.update(chat)
              cursor.continue()
            }
          }
          if (!db.objectStoreNames.contains(PROJECTS_STORE)) {
            const store = db.createObjectStore(PROJECTS_STORE, {
              keyPath: 'cacheKey',
            })
            store.createIndex(PROJECTS_USER_INDEX, 'userId', { unique: false })
          }
          if (!db.objectStoreNames.contains(SYNC_STATE_STORE)) {
            db.createObjectStore(SYNC_STATE_STORE, { keyPath: 'id' })
          }
          if (!db.objectStoreNames.contains(REMOTE_CHAT_STATE_STORE)) {
            db.createObjectStore(REMOTE_CHAT_STATE_STORE, {
              keyPath: 'id',
            })
          } else {
            const store = request.transaction!.objectStore(
              REMOTE_CHAT_STATE_STORE,
            )
            if (store.indexNames.contains('updatedAt')) {
              store.deleteIndex('updatedAt')
            }
          }
          if (!db.objectStoreNames.contains(SYNC_OUTBOX_STORE)) {
            const store = db.createObjectStore(SYNC_OUTBOX_STORE, {
              keyPath: ['userId', 'id'],
            })
            store.createIndex('userId', 'userId', { unique: false })
          }
          if (!db.objectStoreNames.contains(MIGRATIONS_STORE)) {
            db.createObjectStore(MIGRATIONS_STORE, { keyPath: 'id' })
          }
          if (!db.objectStoreNames.contains(ATTACHMENT_PAYLOADS_STORE)) {
            const store = db.createObjectStore(ATTACHMENT_PAYLOADS_STORE, {
              keyPath: 'id',
            })
            store.createIndex(
              ATTACHMENT_PAYLOADS_CHAT_INDEX,
              ATTACHMENT_PAYLOADS_CHAT_INDEX,
              { unique: false },
            )
          }
          if (!db.objectStoreNames.contains(CHAT_SUMMARIES_STORE)) {
            db.createObjectStore(CHAT_SUMMARIES_STORE, { keyPath: 'id' })
          }
          if ((event as IDBVersionChangeEvent).oldVersion === 0) {
            const migrations =
              request.transaction?.objectStore(MIGRATIONS_STORE)
            migrations?.put({
              id: SYNC_PENDING_MIGRATION_ID,
              completedAt: Date.now(),
            })
            migrations?.put({
              id: CHAT_SUMMARIES_MIGRATION_ID,
              completedAt: Date.now(),
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
        abandoned = true
        logWarning('IndexedDB upgrade blocked - close other tabs', {
          component: 'IndexedDBStorage',
        })
        reject(new Error('Database upgrade blocked'))
      }
    })

    this.initializationPromise = initializationPromise

    try {
      await initializationPromise
    } finally {
      if (this.initializationPromise === initializationPromise) {
        this.initializationPromise = null
      }
    }
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

  private async waitForSaveQueue(): Promise<void> {
    if (this.accountResetStarted) {
      throw new Error(ACCOUNT_CHANGE_READ_ERROR)
    }
    await Promise.race([
      this.saveQueue.catch(() => {}),
      this.accountResetSignal,
    ])
    if (this.accountResetStarted) {
      throw new Error(ACCOUNT_CHANGE_READ_ERROR)
    }
  }

  private protectRead<T>(read: Promise<T>): Promise<T> {
    return Promise.race([read, this.accountResetSignal])
  }

  private assertActiveSaveGeneration(): void {
    if (
      this.accountResetStarted ||
      this.activeSaveGeneration !== this.saveGeneration
    ) {
      throw new Error(ACCOUNT_CHANGE_WRITE_ERROR)
    }
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
    if (this.accountResetStarted) {
      return Promise.reject(new Error(ACCOUNT_CHANGE_WRITE_ERROR))
    }

    const saveGeneration = this.saveGeneration
    const result = this.saveQueue
      .catch((error) => {
        logError('Previous save operation failed, recovering queue', error, {
          component: 'IndexedDBStorage',
          action: `${action}.queueRecovery`,
        })
      })
      .then(async () => {
        if (saveGeneration !== this.saveGeneration) {
          throw new Error(ACCOUNT_CHANGE_WRITE_ERROR)
        }
        this.activeSaveGeneration = saveGeneration
        try {
          return await operation()
        } finally {
          if (this.activeSaveGeneration === saveGeneration) {
            this.activeSaveGeneration = null
          }
        }
      })
    this.saveQueue = result
    return result
  }

  async resetForAccountChange(notifyOtherTabs = true): Promise<void> {
    if (this.accountResetPromise) return this.accountResetPromise

    if (notifyOtherTabs && typeof window !== 'undefined') {
      try {
        localStorage.setItem(AUTH_ACCOUNT_RESET_SIGNAL, crypto.randomUUID())
        localStorage.removeItem(AUTH_ACCOUNT_RESET_SIGNAL)
      } catch {
        // best-effort — this tab still clears and blocks its own storage
      }
    }

    this.accountResetStarted = true
    this.rejectAccountReads(new Error(ACCOUNT_CHANGE_READ_ERROR))
    this.saveGeneration += 1
    this.saveQueue = Promise.resolve()
    this.initializationPromise = null

    const db = this.db
    this.db = null
    db?.close()

    const reset = this.ensureDB().then((resetDb) => {
      const storeNames = Array.from(resetDb.objectStoreNames).filter(
        (storeName) => storeName !== MIGRATIONS_STORE,
      )
      return new Promise<void>((resolve, reject) => {
        const transaction = resetDb.transaction(storeNames, 'readwrite')
        const timeout = window.setTimeout(() => {
          try {
            transaction.abort()
          } finally {
            reject(
              new Error('Timed out resetting IndexedDB for account change'),
            )
          }
        }, ACCOUNT_CHANGE_RESET_TIMEOUT_MS)

        transaction.oncomplete = () => {
          clearTimeout(timeout)
          resolve()
        }
        transaction.onerror = () => {
          clearTimeout(timeout)
          reject(new Error('Failed to reset IndexedDB for account change'))
        }
        transaction.onabort = () => {
          clearTimeout(timeout)
          reject(new Error('IndexedDB account reset was aborted'))
        }

        for (const storeName of storeNames) {
          const clearRequest = transaction.objectStore(storeName).clear()
          clearRequest.onerror = () => {
            clearTimeout(timeout)
            reject(
              new Error(
                `Failed to clear IndexedDB store ${storeName} for account change`,
              ),
            )
          }
        }
      })
    })

    const trackedReset = reset
    this.accountResetPromise = trackedReset
    this.saveQueue = trackedReset
    void trackedReset.then(
      () => {
        if (this.accountResetPromise === trackedReset) {
          this.accountResetPromise = null
        }
      },
      () => {
        if (this.accountResetPromise === trackedReset) {
          this.accountResetPromise = null
        }
      },
    )
    return trackedReset
  }

  async saveChat(chat: Chat): Promise<SaveChatResult> {
    const chatSnapshot = snapshotChatForStorage(chat)
    return this.enqueueSave('saveChat', () =>
      this.saveChatInternal(chatSnapshot),
    )
  }

  private async saveChatInternal(chat: Chat): Promise<SaveChatResult> {
    this.assertActiveSaveGeneration()
    const db = await this.ensureDB()
    this.assertActiveSaveGeneration()

    // Don't save blank chats to IndexedDB
    if ((chat as StoredChat).isBlankChat === true) {
      return {
        saved: false,
        isLocalOnly: (chat as StoredChat).isLocalOnly === true,
      }
    }

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(
        [CHATS_STORE, ATTACHMENT_PAYLOADS_STORE, CHAT_SUMMARIES_STORE],
        'readwrite',
      )
      const store = transaction.objectStore(CHATS_STORE)
      const payloadStore = transaction.objectStore(ATTACHMENT_PAYLOADS_STORE)
      const summaryStore = transaction.objectStore(CHAT_SUMMARIES_STORE)
      let result: SaveChatResult = {
        saved: false,
        isLocalOnly: (chat as StoredChat).isLocalOnly === true,
      }

      transaction.oncomplete = () => {
        resolve(result)
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
        reject(transaction.error ?? new Error('Transaction aborted'))
      }

      const getRequest = store.get(chat.id)

      getRequest.onsuccess = () => {
        const existingChat = getRequest.result as StoredChat | undefined

        const normalizedAttachments = normalizeAttachmentPayloadsInTransaction(
          chat,
          transaction,
          reject,
        )
        if (!normalizedAttachments) return
        const messagesForStorage = normalizedAttachments.messages.map(
          (msg) => ({
            ...msg,
            timestamp:
              msg.timestamp instanceof Date
                ? msg.timestamp.toISOString()
                : msg.timestamp,
          }),
        )

        const isLocalOnly =
          (chat as StoredChat).isLocalOnly === true ||
          existingChat?.isLocalOnly === true
        const storedChat: StoredChat = {
          ...chat,
          messages: messagesForStorage as any,
          lastAccessedAt: Date.now(),
          syncedAt: existingChat?.syncedAt ?? (chat as StoredChat).syncedAt,
          syncVersion:
            existingChat?.syncVersion ?? (chat as StoredChat).syncVersion,
          decryptionFailed: (chat as StoredChat).decryptionFailed,
          dataCorrupted: (chat as StoredChat).dataCorrupted,
          version: 1,
          loadedAt:
            (chat as StoredChat).loadedAt ??
            existingChat?.loadedAt ??
            undefined,
          isLocalOnly,
          syncUserId:
            chatOwnerId(chat) ?? existingChat?.syncUserId ?? activeUserId(),
          projectLocallyModified:
            (chat as StoredChat).projectLocallyModified ??
            existingChat?.projectLocallyModified ??
            false,
        }
        result = { saved: true, isLocalOnly }

        const writeChatAndPayloads = () => {
          for (const payload of normalizedAttachments.payloads) {
            const payloadRequest = payloadStore.put(payload)
            payloadRequest.onerror = () =>
              reject(
                payloadRequest.error ??
                  new Error('Failed to save attachment payload'),
              )
          }
          const putRequest = putStoredChat(store, summaryStore, storedChat)
          putRequest.onerror = () => reject(new Error('Failed to save chat'))
        }

        const payloadCursor = payloadStore
          .index(ATTACHMENT_PAYLOADS_CHAT_INDEX)
          .openCursor(IDBKeyRange.only(chat.id))
        payloadCursor.onerror = () =>
          reject(new Error('Failed to reconcile attachment payloads'))
        payloadCursor.onsuccess = () => {
          const cursor = payloadCursor.result
          if (cursor) {
            if (
              !normalizedAttachments.referencedPayloadIds.has(
                String(cursor.primaryKey),
              )
            ) {
              cursor.delete()
            }
            cursor.continue()
            return
          }
          writeChatAndPayloads()
        }
      }

      getRequest.onerror = () =>
        reject(new Error('Failed to check existing chat'))
    })
  }

  private async getChatInternal(id: string): Promise<StoredChat | null> {
    const db = await this.ensureDB()

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(
        [CHATS_STORE, ATTACHMENT_PAYLOADS_STORE],
        'readonly',
      )
      let chat: StoredChat | null = null
      let payloads: StoredAttachmentPayload[] = []
      const chatRequest = transaction.objectStore(CHATS_STORE).get(id)
      const payloadRequest = transaction
        .objectStore(ATTACHMENT_PAYLOADS_STORE)
        .index(ATTACHMENT_PAYLOADS_CHAT_INDEX)
        .getAll(IDBKeyRange.only(id))

      chatRequest.onsuccess = () => {
        try {
          const stored = chatRequest.result as StoredChat | undefined
          chat = stored ? deserializeStoredChat(stored) : null
        } catch (error) {
          reject(error)
        }
      }
      chatRequest.onerror = () => reject(new Error('Failed to get chat'))
      payloadRequest.onsuccess = () => {
        payloads = payloadRequest.result as StoredAttachmentPayload[]
      }
      payloadRequest.onerror = () =>
        reject(new Error('Failed to get attachment payloads'))
      transaction.oncomplete = () => {
        try {
          resolve(chat ? hydrateAttachmentPayloads(chat, payloads) : null)
        } catch (error) {
          reject(error)
        }
      }
    })
  }

  async getChat(id: string): Promise<StoredChat | null> {
    await this.waitForSaveQueue()
    return this.protectRead(
      this.getChatInternal(id).then((chat) => {
        if (chat) {
          this.updateLastAccessed(id).catch((error) =>
            logError('Failed to update last accessed time', error, {
              component: 'IndexedDBStorage',
              metadata: { chatId: id },
            }),
          )
        }
        return chat
      }),
    )
  }

  async deleteChat(id: string): Promise<void> {
    // Serialize through saveQueue so a deletion can't race with an in-flight
    // saveChatInternal that would resurrect the row after the delete.
    return this.enqueueSave('deleteChat', async () => {
      const db = await this.ensureDB()
      return new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(
          [CHATS_STORE, ATTACHMENT_PAYLOADS_STORE, CHAT_SUMMARIES_STORE],
          'readwrite',
        )
        const store = transaction.objectStore(CHATS_STORE)
        const request = store.delete(id)
        transaction.objectStore(CHAT_SUMMARIES_STORE).delete(id)
        deleteAttachmentPayloadsForChat(
          transaction.objectStore(ATTACHMENT_PAYLOADS_STORE),
          id,
        )

        transaction.oncomplete = () => resolve()
        transaction.onerror = () => reject(new Error('Failed to delete chat'))
        request.onerror = () => reject(new Error('Failed to delete chat'))
      })
    })
  }

  async getAllChatIds(): Promise<string[]> {
    await this.waitForSaveQueue()
    const db = await this.ensureDB()

    return this.protectRead(
      new Promise((resolve, reject) => {
        const transaction = db.transaction([CHATS_STORE], 'readonly')
        const store = transaction.objectStore(CHATS_STORE)
        const request = store.getAllKeys()

        request.onsuccess = () => {
          resolve((request.result as IDBValidKey[]).map((k) => String(k)))
        }
        request.onerror = () => reject(new Error('Failed to list chat IDs'))
      }),
    )
  }

  async deleteAllChats(): Promise<number> {
    // Serialize through saveQueue so a clear() can't race with an in-flight
    // saveChatInternal that would re-insert a row after the wipe.
    return this.enqueueSave('deleteAllChats', async () => {
      const db = await this.ensureDB()
      return new Promise<number>((resolve, reject) => {
        const transaction = db.transaction(
          [CHATS_STORE, ATTACHMENT_PAYLOADS_STORE, CHAT_SUMMARIES_STORE],
          'readwrite',
        )
        const store = transaction.objectStore(CHATS_STORE)
        const countRequest = store.count()
        let count = 0

        countRequest.onsuccess = () => {
          count = countRequest.result
          store.clear()
          transaction.objectStore(ATTACHMENT_PAYLOADS_STORE).clear()
          transaction.objectStore(CHAT_SUMMARIES_STORE).clear()
        }

        transaction.oncomplete = () => resolve(count)
        transaction.onerror = () =>
          reject(new Error('Failed to clear chats store'))
        countRequest.onerror = () => reject(new Error('Failed to count chats'))
      })
    })
  }

  async getChatSummaries(): Promise<StoredChat[]> {
    await this.ensureChatSummaries()
    await this.waitForSaveQueue()
    const db = await this.ensureDB()

    return this.protectRead(
      new Promise((resolve, reject) => {
        const transaction = db.transaction([CHAT_SUMMARIES_STORE], 'readonly')
        const request = transaction.objectStore(CHAT_SUMMARIES_STORE).getAll()
        request.onsuccess = () => {
          const chats: StoredChat[] = []
          for (const chat of request.result as StoredChat[]) {
            if (!Array.isArray(chat.messages)) {
              logWarning('Skipping invalid chat summary', {
                component: 'IndexedDBStorage',
                metadata: { chatId: chat.id },
              })
              continue
            }
            chats.push(chat)
          }
          resolve(chats)
        }
        request.onerror = () =>
          reject(new Error('Failed to get chat summaries'))
      }),
    )
  }

  private async ensureChatSummaries(): Promise<void> {
    if (this.chatSummariesReady) return
    return this.enqueueSave('ensureChatSummaries', async () => {
      if (this.chatSummariesReady) return
      const db = await this.ensureDB()
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(
          [CHATS_STORE, CHAT_SUMMARIES_STORE, MIGRATIONS_STORE],
          'readwrite',
        )
        const chatsStore = transaction.objectStore(CHATS_STORE)
        const summariesStore = transaction.objectStore(CHAT_SUMMARIES_STORE)
        const migrationsStore = transaction.objectStore(MIGRATIONS_STORE)

        transaction.oncomplete = () => resolve()
        transaction.onerror = () =>
          reject(new Error('Failed to prepare chat summaries'))
        transaction.onabort = () =>
          reject(new Error('Chat summary migration was aborted'))

        const markerRequest = migrationsStore.get(CHAT_SUMMARIES_MIGRATION_ID)
        markerRequest.onerror = () =>
          reject(new Error('Failed to read the chat summary migration'))
        markerRequest.onsuccess = () => {
          if (markerRequest.result) return

          const cursorRequest = chatsStore.openCursor()
          cursorRequest.onerror = () =>
            reject(new Error('Failed to migrate chat summaries'))
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result
            if (!cursor) {
              migrationsStore.put({
                id: CHAT_SUMMARIES_MIGRATION_ID,
                completedAt: Date.now(),
              })
              return
            }

            const chat = cursor.value as StoredChat
            if (Array.isArray(chat.messages)) {
              summariesStore.put(toStoredChatSummary(chat))
            } else {
              logWarning('Skipping invalid chat during summary migration', {
                component: 'IndexedDBStorage',
                metadata: { chatId: chat.id },
              })
            }
            cursor.continue()
          }
        }
      })
      this.chatSummariesReady = true
    })
  }

  private async updateLastAccessed(id: string): Promise<void> {
    return this.enqueueSave('updateLastAccessed', async () => {
      const db = await this.ensureDB()
      return new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(
          [CHATS_STORE, CHAT_SUMMARIES_STORE],
          'readwrite',
        )
        const store = transaction.objectStore(CHATS_STORE)
        const summaryStore = transaction.objectStore(CHAT_SUMMARIES_STORE)
        const request = store.get(id)

        transaction.oncomplete = () => resolve()
        transaction.onerror = () =>
          reject(new Error('Failed to update last accessed'))
        transaction.onabort = () =>
          reject(new Error('Last accessed update transaction aborted'))
        request.onerror = () =>
          reject(new Error('Failed to read chat for last accessed update'))
        request.onsuccess = () => {
          const chat = request.result as StoredChat | undefined
          if (!chat) return
          chat.lastAccessedAt = Date.now()
          const putRequest = putStoredChat(store, summaryStore, chat)
          putRequest.onerror = () =>
            reject(new Error('Failed to update last accessed'))
        }
      })
    })
  }
}

export const indexedDBStorage = new IndexedDBStorage()

export function handleIndexedDBAccountResetStorageEvent(
  storage: IndexedDBStorage,
  event: StorageEvent,
): void {
  if (event.key !== AUTH_ACCOUNT_RESET_SIGNAL || !event.newValue) return
  void storage
    .resetForAccountChange(false)
    .then(() => {
      sessionStorage.removeItem(AUTH_ACCOUNT_RESET_FAILED)
      deletedChatsTracker.clear()
      window.location.reload()
    })
    .catch((error) => {
      logError(
        'Failed to reset IndexedDB after cross-tab account change',
        error,
        {
          component: 'IndexedDBStorage',
          action: 'crossTabAccountReset',
        },
      )
      sessionStorage.setItem(AUTH_ACCOUNT_RESET_FAILED, 'true')
      window.dispatchEvent(new CustomEvent(ACCOUNT_RESET_FAILED_EVENT))
    })
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    handleIndexedDBAccountResetStorageEvent(indexedDBStorage, event)
  })
}
