import {
  AttachmentPayloadIdUnavailableError,
  AttachmentPayloadMissingError,
  AttachmentPayloadReferenceAmbiguityError,
  AttachmentPayloadReferenceMissingError,
  chatContentFingerprint,
  DB_NAME,
  DB_VERSION,
  INDEXED_DB_UPGRADE_BLOCKED_EVENT,
  IndexedDBStorage,
  type StoredChat,
} from '@/services/storage/indexed-db'
import {
  IDBCursor as FakeIDBCursor,
  IDBKeyRange as FakeIDBKeyRange,
  IDBFactory,
} from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

function storedChat(
  id: string,
  overrides: Partial<StoredChat> = {},
): StoredChat {
  return {
    id,
    title: id,
    messages: [],
    createdAt: '2026-08-12T00:00:00.000Z',
    updatedAt: '2026-08-12T00:00:00.000Z',
    lastAccessedAt: Date.now(),
    ...overrides,
  }
}

async function openVersionThree(chats: StoredChat[]): Promise<IDBDatabase> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 3)
    request.onerror = () => reject(request.error)
    request.onupgradeneeded = () => {
      const chatsStore = request.result.createObjectStore('chats', {
        keyPath: 'id',
      })
      chatsStore.createIndex('lastAccessedAt', 'lastAccessedAt')
      chatsStore.createIndex('createdAt', 'createdAt')
      chatsStore.createIndex('syncedAt', 'syncedAt')
      chatsStore.createIndex('locallyModified', 'locallyModified')
      chatsStore.createIndex('projectId', 'projectId')
      const projectsStore = request.result.createObjectStore('projects', {
        keyPath: 'cacheKey',
      })
      projectsStore.createIndex('userId', 'userId')
    }
    request.onsuccess = () => resolve(request.result)
  })

  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('chats', 'readwrite')
    const store = transaction.objectStore('chats')
    for (const chat of chats) store.put(chat)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
  })
  return db
}

async function seedVersionThree(chats: StoredChat[]): Promise<void> {
  const db = await openVersionThree(chats)
  db.close()
}

function blockChatTransaction(
  storage: IndexedDBStorage,
  chatId: string,
  mutation: (chat: StoredChat, transaction: IDBTransaction) => void,
): {
  ready: Promise<void>
  release: () => void
  complete: Promise<void>
} {
  const db = (storage as any).db as IDBDatabase
  const transaction = db.transaction(
    ['chats', 'attachmentPayloads'],
    'readwrite',
  )
  const store = transaction.objectStore('chats')
  let released = false
  let readyResolved = false
  let resolveReady!: () => void
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve
  })
  const complete = new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })

  const keepAlive = () => {
    const request = store.get(chatId)
    request.onerror = () => transaction.abort()
    request.onsuccess = () => {
      if (!readyResolved) {
        readyResolved = true
        resolveReady()
      }
      if (!released) {
        keepAlive()
        return
      }
      mutation(request.result as StoredChat, transaction)
    }
  }
  keepAlive()

  return {
    ready,
    release: () => {
      released = true
    },
    complete,
  }
}

describe('IndexedDB pending sync index', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  beforeEach(() => {
    Object.defineProperty(globalThis, 'indexedDB', {
      configurable: true,
      value: new IDBFactory(),
    })
    Object.defineProperty(globalThis, 'IDBKeyRange', {
      configurable: true,
      value: FakeIDBKeyRange,
    })
  })

  it('migrates existing rows and queries only uploadable pending chats', async () => {
    await seedVersionThree([
      storedChat('dirty', { locallyModified: true, syncedAt: Date.now() }),
      storedChat('never-synced', { locallyModified: false }),
      storedChat('clean', { locallyModified: false, syncedAt: Date.now() }),
      storedChat('local', { locallyModified: true, isLocalOnly: true }),
      storedChat('undecryptable', {
        locallyModified: true,
        decryptionFailed: true,
      }),
      storedChat('malformed', {
        locallyModified: true,
        messages: undefined as unknown as StoredChat['messages'],
      }),
      storedChat('malformed-message', {
        locallyModified: true,
        messages: [null] as unknown as StoredChat['messages'],
      }),
    ])

    const storage = new IndexedDBStorage()
    const pending = await storage.getUnsyncedChats()

    expect(pending.map((chat) => chat.id).sort()).toEqual([
      'dirty',
      'never-synced',
    ])

    const upgraded = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION)
      request.onerror = () => reject(request.error)
      request.onsuccess = () => resolve(request.result)
    })
    const indexNames = upgraded
      .transaction('chats')
      .objectStore('chats').indexNames
    expect(indexNames.contains('syncPending')).toBe(true)
    expect(indexNames.contains('locallyModified')).toBe(false)
    upgraded.close()
  })

  it('fails a blocked upgrade promptly and allows a retry', async () => {
    const olderConnection = await openVersionThree([storedChat('cloud-chat')])
    olderConnection.onversionchange = () => undefined
    const blocked = new Promise<void>((resolve) => {
      window.addEventListener(
        INDEXED_DB_UPGRADE_BLOCKED_EVENT,
        () => resolve(),
        { once: true },
      )
    })
    const storage = new IndexedDBStorage()
    const chatsPromise = storage.getAllChats()

    await blocked
    await expect(chatsPromise).rejects.toThrow('Database upgrade blocked')
    olderConnection.close()

    await expect(storage.getAllChats()).resolves.toEqual([
      expect.objectContaining({ id: 'cloud-chat' }),
    ])
  })

  it('stores attachment payloads separately and hydrates them on read', async () => {
    const storage = new IndexedDBStorage()
    await storage.initialize()
    const initializedDatabase = await new Promise<IDBDatabase>(
      (resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION)
        request.onerror = () => reject(request.error)
        request.onsuccess = () => resolve(request.result)
      },
    )
    expect(
      initializedDatabase.objectStoreNames.contains('attachmentPayloads'),
    ).toBe(true)
    expect(
      initializedDatabase
        .transaction('attachmentPayloads')
        .objectStore('attachmentPayloads')
        .indexNames.contains('chatId'),
    ).toBe(true)
    initializedDatabase.close()
    const base64 = 'A'.repeat(20_000)
    await storage.saveChat(
      storedChat('with-attachment', {
        messages: [
          {
            role: 'user',
            content: 'Read this',
            timestamp: new Date('2026-08-12T00:00:00.000Z'),
            attachments: [
              {
                id: 'attachment-1',
                type: 'document',
                fileName: 'document.pdf',
                base64,
                textContent: 'Document text',
                pages: [
                  {
                    page: 1,
                    text: 'Page text',
                    image: base64,
                    is_scanned: true,
                  },
                ],
              },
            ],
          },
        ],
      }),
    )

    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION)
      request.onerror = () => reject(request.error)
      request.onsuccess = () => resolve(request.result)
    })
    const rawChat = await new Promise<StoredChat>((resolve, reject) => {
      const request = db
        .transaction('chats')
        .objectStore('chats')
        .get('with-attachment')
      request.onerror = () => reject(request.error)
      request.onsuccess = () => resolve(request.result as StoredChat)
    })
    const rawAttachment = rawChat.messages[0].attachments?.[0] as
      (Record<string, unknown> & { storagePayloadId?: string }) | undefined
    expect(rawAttachment?.base64).toBeUndefined()
    expect(rawAttachment?.textContent).toBeUndefined()
    expect(rawAttachment?.storagePayloadId).toBeTruthy()

    const hydrated = await storage.getChat('with-attachment')
    expect(hydrated?.messages[0].attachments?.[0].base64).toBe(base64)
    expect(hydrated?.messages[0].attachments?.[0].textContent).toBe(
      'Document text',
    )

    const summaries = await storage.getChatSummaries()
    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toMatchObject({
      id: 'with-attachment',
      isMetadataOnly: true,
      messageCount: 1,
      messages: [],
    })

    const applied = await storage.applyRemoteChatIfFresh({
      chat: {
        ...storedChat('with-attachment'),
        messages: [
          {
            role: 'user',
            content: 'Read this remotely',
            timestamp: new Date('2026-08-12T00:00:00.000Z'),
            attachments: [
              {
                id: 'attachment-1',
                type: 'document',
                fileName: 'document.pdf',
              },
            ],
          },
        ],
      },
      syncVersion: 2,
      expectedLocalUpdatedAt: undefined,
    })
    expect(applied).toEqual({ applied: true })
    expect(
      (await storage.getChat('with-attachment'))?.messages[0].content,
    ).toBe('Read this remotely')
    expect(
      (await storage.getChat('with-attachment'))?.messages[0].attachments?.[0]
        .base64,
    ).toBe(base64)

    const chatWithoutAttachment = await storage.getChat('with-attachment')
    if (!chatWithoutAttachment) throw new Error('Expected stored chat')
    chatWithoutAttachment.messages[0].attachments = []
    await storage.saveChat(chatWithoutAttachment)
    const payloadCountAfterRemoval = await new Promise<number>(
      (resolve, reject) => {
        const request = db
          .transaction('attachmentPayloads')
          .objectStore('attachmentPayloads')
          .count()
        request.onerror = () => reject(request.error)
        request.onsuccess = () => resolve(request.result)
      },
    )
    expect(payloadCountAfterRemoval).toBe(0)
    if (!hydrated) throw new Error('Expected hydrated chat')
    await storage.saveChat(hydrated)
    const beforeDeleteCount = await new Promise<number>((resolve, reject) => {
      const request = db
        .transaction('attachmentPayloads')
        .objectStore('attachmentPayloads')
        .count()
      request.onerror = () => reject(request.error)
      request.onsuccess = () => resolve(request.result)
    })
    expect(beforeDeleteCount).toBe(1)
    await storage.deleteChat('with-attachment')
    expect(await storage.getChat('with-attachment')).toBeNull()
    expect(await storage.getChatSummaries()).toEqual([])
    const payloadCount = await new Promise<number>((resolve, reject) => {
      const request = db
        .transaction('attachmentPayloads')
        .objectStore('attachmentPayloads')
        .count()
      request.onerror = () => reject(request.error)
      request.onsuccess = () => resolve(request.result)
    })
    expect(payloadCount).toBe(0)
    db.close()
  })

  it('hydrates all chats in key order with chat-scoped payload reads', async () => {
    const storage = new IndexedDBStorage()
    await storage.initialize()
    for (const id of ['chat-b', 'chat-a']) {
      await storage.saveChat(
        storedChat(id, {
          messages: [
            {
              role: 'user',
              content: id,
              timestamp: new Date('2026-08-12T00:00:00.000Z'),
              attachments: [
                {
                  id: `${id}-attachment`,
                  type: 'document',
                  fileName: `${id}.txt`,
                  textContent: `${id}-payload`,
                },
              ],
            },
          ],
        }),
      )
    }

    const db = (storage as any).db as IDBDatabase
    const transaction = db.transaction('attachmentPayloads')
    const payloadStore = transaction.objectStore('attachmentPayloads')
    const storeGetAll = vi.spyOn(Object.getPrototypeOf(payloadStore), 'getAll')
    const payloadIndex = payloadStore.index('chatId')
    const indexGetAll = vi.spyOn(Object.getPrototypeOf(payloadIndex), 'getAll')

    const chats = await storage.getAllChats()

    expect(storeGetAll).not.toHaveBeenCalled()
    expect(indexGetAll).toHaveBeenCalledTimes(2)
    expect(
      indexGetAll.mock.calls.map(([range]) => (range as IDBKeyRange).lower),
    ).toEqual(['chat-a', 'chat-b'])
    expect(chats.map((chat) => chat.id)).toEqual(['chat-a', 'chat-b'])
    expect(
      chats.map((chat) => chat.messages[0].attachments?.[0].textContent),
    ).toEqual(['chat-a-payload', 'chat-b-payload'])
  })

  it('requests each chat payload only after the previous read resolves', async () => {
    const storage = new IndexedDBStorage()
    await storage.initialize()
    const payloadText = 'payload'.repeat(8_000)
    for (const id of ['chat-a', 'chat-b', 'chat-c']) {
      await storage.saveChat(
        storedChat(id, {
          messages: [
            {
              role: 'user',
              content: id,
              timestamp: new Date('2026-08-12T00:00:00.000Z'),
              attachments: [
                {
                  id: `${id}-attachment`,
                  type: 'document',
                  fileName: `${id}.txt`,
                  textContent: `${id}-${payloadText}`,
                },
              ],
            },
          ],
        }),
      )
    }

    const db = (storage as any).db as IDBDatabase
    const payloadIndex = db
      .transaction('attachmentPayloads')
      .objectStore('attachmentPayloads')
      .index('chatId')
    const events: string[] = []
    const originalGetAll = Object.getPrototypeOf(payloadIndex).getAll
    const getAllSpy = vi
      .spyOn(Object.getPrototypeOf(payloadIndex), 'getAll')
      .mockImplementation(function (this: IDBIndex, ...args: unknown[]) {
        const query = args[0] as IDBValidKey | IDBKeyRange
        const chatId = (query as IDBKeyRange).lower as string
        events.push(`requested:${chatId}`)
        const request = originalGetAll.call(this, query)
        request.addEventListener('success', () => {
          events.push(`resolved:${chatId}`)
        })
        return request
      })

    const chats = await storage.getAllChats()

    expect(getAllSpy).toHaveBeenCalledTimes(3)
    expect(events).toEqual([
      'requested:chat-a',
      'resolved:chat-a',
      'requested:chat-b',
      'resolved:chat-b',
      'requested:chat-c',
      'resolved:chat-c',
    ])
    expect(chats.map((chat) => chat.id)).toEqual(['chat-a', 'chat-b', 'chat-c'])
  })

  it('derives sync message counts without copying messages into metadata', async () => {
    const storage = new IndexedDBStorage()
    await storage.initialize()
    await storage.saveChat(
      storedChat('metadata-count', {
        messages: [
          {
            role: 'user',
            content: 'Count me',
            timestamp: new Date('2026-08-12T00:00:00.000Z'),
          },
        ],
      }),
    )

    const metadata = await storage.getChatSyncMetadata()

    expect(metadata).toEqual([
      expect.objectContaining({ id: 'metadata-count', messageCount: 1 }),
    ])
    expect(metadata[0]).not.toHaveProperty('messages')
  })

  it('serves recurring metadata reads without hydrating full chat rows', async () => {
    const storage = new IndexedDBStorage()
    await storage.initialize()
    const pendingRecovery = {
      v: 1 as const,
      turnId: 'turn-1',
      keyId: '0123456789abcdef0123456789abcdef',
      createdAt: '2026-08-12T00:00:00.000Z',
      expiresAt: '2026-08-12T01:00:00.000Z',
      nonce: 'AAAAAAAAAAAAAAAA',
      ciphertext: 'AAAAAAAAAAAAAAAAAAAAAAAA',
    }
    await storage.saveChat(
      storedChat('pending-recovery', {
        projectId: 'project-1',
        pendingRecoveries: [pendingRecovery],
        messages: [
          {
            role: 'user',
            content: 'Do not hydrate me',
            timestamp: new Date('2026-08-12T00:00:00.000Z'),
          },
        ],
      }),
    )
    await storage.saveChat(
      storedChat('local-only', {
        isLocalOnly: true,
        projectId: 'project-1',
      }),
    )

    await storage.getChatSummaries()
    const db = (storage as any).db as IDBDatabase
    const chatStore = db.transaction('chats').objectStore('chats')
    const storePrototype = Object.getPrototypeOf(chatStore)
    const originalOpenCursor = storePrototype.openCursor
    const cursorStoreNames: string[] = []
    vi.spyOn(storePrototype, 'openCursor').mockImplementation(function (
      this: IDBObjectStore,
      ...args: unknown[]
    ) {
      cursorStoreNames.push(this.name)
      const [query, direction] = args as [
        IDBValidKey | IDBKeyRange | null | undefined,
        IDBCursorDirection | undefined,
      ]
      return originalOpenCursor.call(this, query, direction)
    })

    await expect(storage.getPendingChatRecoveries()).resolves.toEqual([
      {
        id: 'pending-recovery',
        pendingRecoveries: [pendingRecovery],
      },
    ])
    await expect(storage.hasPendingChatRecoveries()).resolves.toBe(true)
    await expect(storage.getCloudChatCount()).resolves.toBe(1)
    await expect(storage.getProjectChatCount('project-1')).resolves.toBe(1)
    expect(cursorStoreNames).toEqual([
      'chatSummaries',
      'chatSummaries',
      'chatSummaries',
      'chatSummaries',
    ])
  })

  it('rejects malformed all-chat sync metadata', async () => {
    const storage = new IndexedDBStorage()
    await storage.initialize()
    const db = (storage as any).db as IDBDatabase
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('chats', 'readwrite')
      transaction.objectStore('chats').put({
        ...storedChat('invalid-project'),
        projectId: 42,
      })
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
    })

    await expect(storage.getChatSyncMetadata()).rejects.toThrow(
      'Stored chat has invalid sync metadata: projectId',
    )
  })

  it('rejects malformed unsynced sync metadata', async () => {
    const storage = new IndexedDBStorage()
    await storage.initialize()
    const db = (storage as any).db as IDBDatabase
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('chats', 'readwrite')
      transaction.objectStore('chats').put({
        ...storedChat('invalid-messages'),
        messages: null,
        syncPending: 1,
      })
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
    })

    await expect(storage.getUnsyncedChatMetadata()).rejects.toThrow(
      'Stored chat has invalid sync metadata: messages',
    )
  })

  it('fails reads when a local attachment payload row is missing', async () => {
    const storage = new IndexedDBStorage()
    await storage.initialize()
    await storage.saveChat(
      storedChat('missing-payload', {
        messages: [
          {
            role: 'user',
            content: 'Read this',
            timestamp: new Date('2026-08-12T00:00:00.000Z'),
            attachments: [
              {
                id: 'document-1',
                type: 'document',
                fileName: 'document.pdf',
                textContent: 'Important document text',
              },
            ],
          },
        ],
      }),
    )
    const stored = await storage.getChat('missing-payload')
    const payloadId = (
      stored?.messages[0].attachments?.[0] as { storagePayloadId?: string }
    ).storagePayloadId
    if (!payloadId) throw new Error('Expected attachment payload id')

    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION)
      request.onerror = () => reject(request.error)
      request.onsuccess = () => resolve(request.result)
    })
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('attachmentPayloads', 'readwrite')
      transaction.objectStore('attachmentPayloads').delete(payloadId)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
    })
    db.close()

    await expect(storage.getChat('missing-payload')).rejects.toBeInstanceOf(
      AttachmentPayloadMissingError,
    )
  })

  it('keeps remotely retrievable images metadata-only until lazy loading', async () => {
    const storage = new IndexedDBStorage()
    await storage.initialize()

    await expect(
      storage.applyRemoteChatIfFresh({
        chat: storedChat('lazy-image', {
          messages: [
            {
              role: 'assistant',
              content: 'Generated image',
              timestamp: new Date('2026-08-12T00:00:00.000Z'),
              attachments: [
                {
                  id: 'remote-image',
                  type: 'image',
                  fileName: 'image.png',
                  mimeType: 'image/png',
                  encryptionKey: 'remote-image-key',
                },
              ],
            },
          ],
        }),
        syncVersion: 1,
        expectedLocalUpdatedAt: null,
      }),
    ).resolves.toEqual({ applied: true })

    const attachment = (await storage.getChat('lazy-image'))?.messages[0]
      .attachments?.[0] as
      ({ storagePayloadId?: string } & Record<string, unknown>) | undefined
    expect(attachment).toMatchObject({
      id: 'remote-image',
      type: 'image',
      encryptionKey: 'remote-image-key',
    })
    expect(attachment?.storagePayloadId).toBeTruthy()
    expect(attachment?.base64).toBeUndefined()
  })

  it('keeps offloaded documents metadata-only until lazy loading', async () => {
    const storage = new IndexedDBStorage()
    await storage.initialize()

    await expect(
      storage.applyRemoteChatIfFresh({
        chat: storedChat('lazy-document', {
          messages: [
            {
              role: 'user',
              content: 'Summarize this',
              timestamp: new Date('2026-08-12T00:00:00.000Z'),
              attachments: [
                {
                  id: 'remote-doc',
                  type: 'document',
                  fileName: 'report.pdf',
                  mimeType: 'application/pdf',
                  encryptionKey: 'remote-doc-key',
                },
              ],
            },
          ],
        }),
        syncVersion: 1,
        expectedLocalUpdatedAt: null,
      }),
    ).resolves.toEqual({ applied: true })

    const attachment = (await storage.getChat('lazy-document'))?.messages[0]
      .attachments?.[0] as Record<string, unknown> | undefined
    expect(attachment).toMatchObject({
      id: 'remote-doc',
      type: 'document',
      encryptionKey: 'remote-doc-key',
    })
    expect(attachment?.textContent).toBeUndefined()
    expect(attachment?.pages).toBeUndefined()
  })

  it('rejects remote attachments without payload or retrieval identity', async () => {
    const storage = new IndexedDBStorage()
    await storage.initialize()

    await expect(
      storage.applyRemoteChatIfFresh({
        chat: storedChat('missing-remote-payload', {
          messages: [
            {
              role: 'user',
              content: 'Missing document',
              timestamp: new Date('2026-08-12T00:00:00.000Z'),
              attachments: [
                {
                  id: 'document-1',
                  type: 'document',
                  fileName: 'document.pdf',
                },
              ],
            },
          ],
        }),
        syncVersion: 1,
        expectedLocalUpdatedAt: null,
      }),
    ).rejects.toBeInstanceOf(AttachmentPayloadReferenceMissingError)
    await expect(storage.getChat('missing-remote-payload')).resolves.toBeNull()
  })

  it('hydrates attachment payloads through mutateChat without reinlining them', async () => {
    const storage = new IndexedDBStorage()
    await storage.initialize()
    const base64 = 'B'.repeat(20_000)
    await storage.saveChat(
      storedChat('mutated-attachment', {
        messages: [
          {
            role: 'user',
            content: 'Read this',
            timestamp: new Date('2026-08-12T00:00:00.000Z'),
            attachments: [
              {
                id: 'attachment-1',
                type: 'document',
                fileName: 'document.pdf',
                base64,
                textContent: 'Document text',
                pages: [
                  {
                    page: 1,
                    text: 'Page text',
                    image: base64,
                    is_scanned: true,
                  },
                ],
              },
            ],
          },
        ],
      }),
    )

    const mutated = await storage.mutateChat('mutated-attachment', (chat) => ({
      chat: {
        ...chat,
        messages: [
          ...chat.messages,
          {
            role: 'assistant',
            content: 'Recovered response',
            timestamp: new Date('2026-08-12T00:00:01.000Z'),
          },
        ],
      },
      changed: true,
    }))

    const mutatedAttachment = mutated?.messages[0].attachments?.[0]
    expect(mutatedAttachment?.base64).toBe(base64)
    expect(mutatedAttachment?.textContent).toBe('Document text')
    expect(mutatedAttachment?.pages?.[0].image).toBe(base64)
    expect(mutated?.messages[1].content).toBe('Recovered response')

    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION)
      request.onerror = () => reject(request.error)
      request.onsuccess = () => resolve(request.result)
    })
    const rawChat = await new Promise<StoredChat>((resolve, reject) => {
      const request = db
        .transaction('chats')
        .objectStore('chats')
        .get('mutated-attachment')
      request.onerror = () => reject(request.error)
      request.onsuccess = () => resolve(request.result as StoredChat)
    })
    const rawAttachment = rawChat.messages[0].attachments?.[0] as
      (Record<string, unknown> & { storagePayloadId?: string }) | undefined
    expect(rawAttachment?.base64).toBeUndefined()
    expect(rawAttachment?.textContent).toBeUndefined()
    expect(rawAttachment?.pages).toBeUndefined()
    expect(rawAttachment?.storagePayloadId).toBeTruthy()
    expect(rawChat.messages[1].content).toBe('Recovered response')

    const payloadCount = await new Promise<number>((resolve, reject) => {
      const request = db
        .transaction('attachmentPayloads')
        .objectStore('attachmentPayloads')
        .count()
      request.onerror = () => reject(request.error)
      request.onsuccess = () => resolve(request.result)
    })
    expect(payloadCount).toBe(1)

    const hydrated = await storage.getChat('mutated-attachment')
    expect(hydrated?.messages[0].attachments?.[0].base64).toBe(base64)
    db.close()
  })

  it('keeps duplicate attachment ids bound to their original payloads', async () => {
    const storage = new IndexedDBStorage()
    await storage.initialize()
    const firstBase64 = 'first-base64'
    const secondBase64 = 'second-base64'
    await storage.saveChat(
      storedChat('duplicate-attachments', {
        messages: [
          {
            role: 'user',
            content: 'First message',
            timestamp: new Date('2026-08-12T00:00:00.000Z'),
            attachments: [
              {
                id: 'legacy-attachment',
                type: 'document',
                fileName: 'first.pdf',
                base64: firstBase64,
                textContent: 'First text',
                pages: [
                  {
                    page: 1,
                    text: 'First page',
                    image: firstBase64,
                    is_scanned: true,
                  },
                ],
              },
            ],
          },
          {
            role: 'user',
            content: 'Second message',
            timestamp: new Date('2026-08-12T00:00:01.000Z'),
            attachments: [
              {
                id: 'legacy-attachment',
                type: 'document',
                fileName: 'second.pdf',
                base64: secondBase64,
                textContent: 'Second text',
                pages: [
                  {
                    page: 1,
                    text: 'Second page',
                    image: secondBase64,
                    is_scanned: true,
                  },
                ],
              },
            ],
          },
        ],
      }),
    )

    const original = await storage.getChat('duplicate-attachments')
    if (!original) throw new Error('Expected stored chat')
    expect(
      original.messages.map((message) => message.attachments?.[0].textContent),
    ).toEqual(['First text', 'Second text'])
    const originalPayloadIds = original.messages.map(
      (message) =>
        (
          message.attachments?.[0] as
            | ({ storagePayloadId?: string } & Record<string, unknown>)
            | undefined
        )?.storagePayloadId,
    )
    expect(new Set(originalPayloadIds).size).toBe(2)

    await storage.saveChat({ ...original, title: 'Second save' })
    const secondSave = await storage.getChat('duplicate-attachments')
    if (!secondSave) throw new Error('Expected stored chat')
    await storage.saveChat({
      ...secondSave,
      messages: [...secondSave.messages].reverse(),
    })

    const reordered = await storage.getChat('duplicate-attachments')
    expect(
      reordered?.messages.map(
        (message) => message.attachments?.[0].textContent,
      ),
    ).toEqual(['Second text', 'First text'])
    expect(reordered?.messages[0].attachments?.[0].pages?.[0].image).toBe(
      secondBase64,
    )

    await storage.applyRemoteChatIfFresh({
      chat: {
        ...storedChat('duplicate-attachments'),
        messages: [
          {
            role: 'user',
            content: 'First message updated remotely',
            timestamp: new Date('2026-08-12T00:00:00.000Z'),
            attachments: [
              {
                id: 'legacy-attachment',
                type: 'document',
                fileName: 'first.pdf',
              },
            ],
          },
          {
            role: 'user',
            content: 'Second message updated remotely',
            timestamp: new Date('2026-08-12T00:00:01.000Z'),
            attachments: [
              {
                id: 'legacy-attachment',
                type: 'document',
                fileName: 'second.pdf',
              },
            ],
          },
        ],
      },
      syncVersion: 2,
      expectedLocalUpdatedAt: undefined,
    })

    const remotelyUpdated = await storage.getChat('duplicate-attachments')
    expect(
      remotelyUpdated?.messages.map(
        (message) => message.attachments?.[0].textContent,
      ),
    ).toEqual(['First text', 'Second text'])

    if (!remotelyUpdated) throw new Error('Expected stored chat')
    const exportStyleCopy = storedChat('duplicate-export-copy', {
      messages: remotelyUpdated.messages.map((message) => ({
        ...message,
        attachments: message.attachments?.map((attachment) => {
          const { storagePayloadId: _storagePayloadId, ...exported } =
            attachment as typeof attachment & { storagePayloadId?: string }
          return exported
        }),
      })),
    })
    await storage.saveChat(exportStyleCopy)
    expect(
      (await storage.getChat('duplicate-export-copy'))?.messages.map(
        (message) => ({
          base64: message.attachments?.[0].base64,
          text: message.attachments?.[0].textContent,
          page: message.attachments?.[0].pages?.[0].text,
        }),
      ),
    ).toEqual([
      { base64: firstBase64, text: 'First text', page: 'First page' },
      { base64: secondBase64, text: 'Second text', page: 'Second page' },
    ])

    remotelyUpdated.messages[0].attachments = []
    await storage.saveChat(remotelyUpdated)
    const afterRemoval = await storage.getChat('duplicate-attachments')
    expect(afterRemoval?.messages[0].attachments).toEqual([])
    expect(afterRemoval?.messages[1].attachments?.[0].textContent).toBe(
      'Second text',
    )
  })

  it('rejects ambiguous remote payload inheritance without changing local data', async () => {
    const storage = new IndexedDBStorage()
    await storage.initialize()
    await storage.saveChat(
      storedChat('ambiguous-payloads', {
        title: 'Local title',
        messages: [
          {
            role: 'user',
            content: 'Local content',
            timestamp: new Date('2026-08-12T00:00:00.000Z'),
            attachments: [
              {
                id: 'duplicate-id',
                type: 'document',
                fileName: 'same.pdf',
                mimeType: 'application/pdf',
                fileSize: 4,
                textContent: 'first payload',
              },
              {
                id: 'duplicate-id',
                type: 'document',
                fileName: 'same.pdf',
                mimeType: 'application/pdf',
                fileSize: 4,
                textContent: 'second payload',
              },
            ],
          },
        ],
      }),
    )

    await expect(
      storage.applyRemoteChatIfFresh({
        chat: storedChat('ambiguous-payloads', {
          title: 'Remote title',
          messages: [
            {
              role: 'user',
              content: 'Remote content',
              timestamp: new Date('2026-08-12T00:00:00.000Z'),
              attachments: [
                {
                  id: 'duplicate-id',
                  type: 'document',
                  fileName: 'same.pdf',
                  mimeType: 'application/pdf',
                  fileSize: 4,
                },
              ],
            },
          ],
        }),
        syncVersion: 2,
        expectedLocalUpdatedAt: undefined,
      }),
    ).rejects.toBeInstanceOf(AttachmentPayloadReferenceAmbiguityError)

    const preserved = await storage.getChat('ambiguous-payloads')
    expect(preserved?.title).toBe('Local title')
    expect(preserved?.messages[0].content).toBe('Local content')
    expect(
      preserved?.messages[0].attachments?.map(
        (attachment) => attachment.textContent,
      ),
    ).toEqual(['first payload', 'second payload'])

    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION)
      request.onerror = () => reject(request.error)
      request.onsuccess = () => resolve(request.result)
    })
    const payloadCount = await new Promise<number>((resolve, reject) => {
      const request = db
        .transaction('attachmentPayloads')
        .objectStore('attachmentPayloads')
        .count()
      request.onerror = () => reject(request.error)
      request.onsuccess = () => resolve(request.result)
    })
    expect(payloadCount).toBe(2)
    db.close()
  })

  it('reserves an exact legacy payload match before duplicate fallback', async () => {
    const storage = new IndexedDBStorage()
    await storage.initialize()
    await storage.saveChat(
      storedChat('inserted-duplicate', {
        messages: [
          {
            role: 'user',
            content: 'Original',
            timestamp: new Date('2026-08-12T00:00:00.000Z'),
            attachments: [
              {
                id: 'shared-id',
                type: 'image',
                fileName: 'old.png',
                mimeType: 'image/png',
                fileSize: 3,
                base64: 'old',
              },
            ],
          },
        ],
      }),
    )

    await storage.applyRemoteChatIfFresh({
      chat: storedChat('inserted-duplicate', {
        messages: [
          {
            role: 'user',
            content: 'Inserted',
            timestamp: new Date('2026-08-12T00:00:01.000Z'),
            attachments: [
              {
                id: 'shared-id',
                type: 'image',
                fileName: 'new.png',
                mimeType: 'image/png',
                fileSize: 3,
                encryptionKey: 'new-image-key',
              },
            ],
          },
          {
            role: 'user',
            content: 'Original',
            timestamp: new Date('2026-08-12T00:00:00.000Z'),
            attachments: [
              {
                id: 'shared-id',
                type: 'image',
                fileName: 'old.png',
                mimeType: 'image/png',
                fileSize: 3,
              },
            ],
          },
        ],
      }),
      syncVersion: 2,
      expectedLocalUpdatedAt: undefined,
    })

    const updated = await storage.getChat('inserted-duplicate')
    expect(
      updated?.messages.map((message) => ({
        fileName: message.attachments?.[0].fileName,
        base64: message.attachments?.[0].base64,
      })),
    ).toEqual([
      { fileName: 'new.png', base64: undefined },
      { fileName: 'old.png', base64: 'old' },
    ])
  })

  it('keeps generated payload ids separate from adversarial legacy ids', async () => {
    const storage = new IndexedDBStorage()
    await storage.initialize()
    await storage.saveChat(
      storedChat('payload-id-collision', {
        messages: [
          {
            role: 'user',
            content: 'Attachments',
            timestamp: new Date('2026-08-12T00:00:00.000Z'),
            attachments: [
              {
                id: 'x',
                type: 'image',
                fileName: 'first.png',
                base64: 'first',
              },
              {
                id: 'x',
                type: 'image',
                fileName: 'second.png',
                base64: 'second',
              },
              {
                id: 'x:duplicate:1',
                type: 'image',
                fileName: 'adversarial.png',
                base64: 'adversarial',
              },
            ],
          },
        ],
      }),
    )

    const stored = await storage.getChat('payload-id-collision')
    const attachments = stored?.messages[0].attachments ?? []
    expect(
      new Set(
        attachments.map(
          (attachment) =>
            (attachment as { storagePayloadId?: string }).storagePayloadId,
        ),
      ).size,
    ).toBe(3)
    expect(attachments.map((attachment) => attachment.base64)).toEqual([
      'first',
      'second',
      'adversarial',
    ])
  })

  it('rejects duplicate payload saves atomically without randomUUID', async () => {
    const storage = new IndexedDBStorage()
    await storage.initialize()
    await storage.saveChat(
      storedChat('uuid-required', {
        title: 'Original',
        messages: [
          {
            role: 'user',
            content: 'Original',
            timestamp: new Date('2026-08-12T00:00:00.000Z'),
            attachments: [
              {
                id: 'shared',
                type: 'image',
                fileName: 'original.png',
                base64: 'original',
              },
            ],
          },
        ],
      }),
    )

    vi.stubGlobal('crypto', {})
    await expect(
      storage.saveChat(
        storedChat('uuid-required', {
          title: 'Changed',
          messages: [
            {
              role: 'user',
              content: 'Changed',
              timestamp: new Date('2026-08-12T00:00:00.000Z'),
              attachments: [
                {
                  id: 'shared',
                  type: 'image',
                  fileName: 'changed.png',
                  base64: 'changed',
                },
                {
                  id: 'shared',
                  type: 'image',
                  fileName: 'duplicate.png',
                  base64: 'duplicate',
                },
              ],
            },
          ],
        }),
      ),
    ).rejects.toBeInstanceOf(AttachmentPayloadIdUnavailableError)

    const stored = await storage.getChat('uuid-required')
    expect(stored?.title).toBe('Original')
    expect(stored?.messages[0].content).toBe('Original')
    expect(stored?.messages[0].attachments).toEqual([
      expect.objectContaining({
        fileName: 'original.png',
        base64: 'original',
      }),
    ])
  })

  it('uses deterministic legacy payload ids without randomUUID', async () => {
    vi.stubGlobal('crypto', {})
    const storage = new IndexedDBStorage()
    await storage.initialize()
    await storage.saveChat(
      storedChat('legacy-only', {
        messages: [
          {
            role: 'user',
            content: 'Legacy',
            timestamp: new Date('2026-08-12T00:00:00.000Z'),
            attachments: [
              {
                id: 'unique',
                type: 'image',
                fileName: 'legacy.png',
                base64: 'legacy',
              },
            ],
          },
        ],
      }),
    )

    const stored = await storage.getChat('legacy-only')
    expect(stored?.messages[0].attachments).toEqual([
      expect.objectContaining({
        storagePayloadId: 'legacy-only:unique',
        base64: 'legacy',
      }),
    ])
  })

  it('finalizes duplicate client ids using their payload identities', async () => {
    const storage = new IndexedDBStorage()
    await storage.initialize()
    await storage.saveChat(
      storedChat('duplicate-rewrites', {
        messages: [
          {
            role: 'user',
            content: 'First',
            timestamp: new Date('2026-08-12T00:00:00.000Z'),
            attachments: [
              {
                id: 'client-id',
                type: 'image',
                fileName: 'first.png',
                base64: 'first-image',
              },
            ],
          },
          {
            role: 'user',
            content: 'Second',
            timestamp: new Date('2026-08-12T00:00:01.000Z'),
            attachments: [
              {
                id: 'client-id',
                type: 'image',
                fileName: 'second.png',
                base64: 'second-image',
              },
            ],
          },
        ],
      }),
    )
    const uploaded = await storage.getChat('duplicate-rewrites')
    if (!uploaded) throw new Error('Expected stored chat')
    const firstPayloadId = (
      uploaded.messages[0].attachments?.[0] as {
        storagePayloadId?: string
      }
    ).storagePayloadId
    const secondPayloadId = (
      uploaded.messages[1].attachments?.[0] as {
        storagePayloadId?: string
      }
    ).storagePayloadId

    await storage.finalizeUpload({
      chatId: uploaded.id,
      rewrites: [
        {
          clientId: 'client-id',
          serverId: 'server-second',
          encryptionKey: 'key-second',
          storagePayloadId: secondPayloadId,
        },
        {
          clientId: 'client-id',
          serverId: 'server-first',
          encryptionKey: 'key-first',
          storagePayloadId: firstPayloadId,
        },
      ],
      preUploadUpdatedAt: uploaded.updatedAt,
      preUploadFingerprint: chatContentFingerprint(uploaded),
      syncVersion: 2,
      uploadedProjectId: uploaded.projectId,
      projectIntentIncluded: false,
    })

    const finalized = await storage.getChat(uploaded.id)
    expect(
      finalized?.messages.map((message) => ({
        id: message.attachments?.[0].id,
        key: message.attachments?.[0].encryptionKey,
        base64: message.attachments?.[0].base64,
      })),
    ).toEqual([
      { id: 'server-first', key: 'key-first', base64: 'first-image' },
      { id: 'server-second', key: 'key-second', base64: 'second-image' },
    ])
  })

  it('serializes metadata updates after a concurrent tab write', async () => {
    const writer = new IndexedDBStorage()
    const metadataWriter = new IndexedDBStorage()
    await Promise.all([writer.initialize(), metadataWriter.initialize()])
    await writer.saveChat(
      storedChat('metadata-race', {
        locallyModified: true,
        messages: [
          {
            role: 'user',
            content: 'Original',
            timestamp: new Date('2026-08-12T00:00:00.000Z'),
            attachments: [
              {
                id: 'attachment',
                type: 'document',
                fileName: 'document.txt',
                textContent: 'Keep this payload',
              },
            ],
          },
        ],
      }),
    )

    const blocker = blockChatTransaction(
      writer,
      'metadata-race',
      (chat, transaction) => {
        chat.messages.push({
          role: 'assistant',
          content: 'Newer tab message',
          timestamp: new Date('2026-08-12T00:00:01.000Z'),
        })
        chat.updatedAt = '2026-08-12T00:00:01.000Z'
        transaction.objectStore('chats').put(chat)
      },
    )
    await blocker.ready
    const metadataDb = (metadataWriter as any).db as IDBDatabase
    const transactionSpy = vi.spyOn(metadataDb, 'transaction')
    const marking = metadataWriter.markAsSynced('metadata-race', 3)
    await vi.waitFor(() =>
      expect(transactionSpy).toHaveBeenCalledWith(
        ['chats', 'chatSummaries'],
        'readwrite',
      ),
    )
    blocker.release()
    await Promise.all([blocker.complete, marking])

    const result = await writer.getChat('metadata-race')
    expect(result?.messages.map((message) => message.content)).toEqual([
      'Original',
      'Newer tab message',
    ])
    expect(result?.messages[0].attachments?.[0].textContent).toBe(
      'Keep this payload',
    )
    expect(result).toMatchObject({
      locallyModified: false,
      syncVersion: 3,
      clockVersion: 3,
    })
  })

  it('uses one chat transaction for every metadata-only mutation', async () => {
    const initialTime = new Date('2026-08-12T00:00:00.000Z')
    const accessedTime = new Date('2026-08-12T00:00:10.000Z')
    vi.setSystemTime(initialTime)
    const storage = new IndexedDBStorage()
    await storage.initialize()
    await storage.saveChat(storedChat('metadata-transactions'))
    await storage.getChatSummaries()
    const db = (storage as any).db as IDBDatabase
    const transactionSpy = vi.spyOn(db, 'transaction')

    vi.setSystemTime(accessedTime)
    await storage.getChat('metadata-transactions')
    const [accessed] = await storage.getChatSummaries()
    expect(accessed.lastAccessedAt).toBe(accessedTime.getTime())
    expect(
      transactionSpy.mock.calls.filter(([, mode]) => mode === 'readwrite'),
    ).toEqual([[['chats', 'chatSummaries'], 'readwrite']])

    transactionSpy.mockClear()
    await storage.markAsSynced('metadata-transactions', 2)
    expect(transactionSpy).toHaveBeenCalledTimes(1)
    expect(transactionSpy).toHaveBeenLastCalledWith(
      ['chats', 'chatSummaries'],
      'readwrite',
    )

    expect((await storage.getChatSummaries())[0]).toMatchObject({
      locallyModified: false,
      syncPending: 0,
      syncVersion: 2,
      clockVersion: 2,
    })

    transactionSpy.mockClear()
    await storage.rebaseSyncVersion('metadata-transactions', 3)
    expect(transactionSpy).toHaveBeenCalledTimes(1)
    expect(transactionSpy).toHaveBeenLastCalledWith(
      ['chats', 'chatSummaries'],
      'readwrite',
    )
    expect((await storage.getChatSummaries())[0]).toMatchObject({
      locallyModified: true,
      syncPending: 1,
      syncVersion: 3,
      clockVersion: 2,
    })
  })

  it('does not rewrite attachments after a cross-tab content edit', async () => {
    const writer = new IndexedDBStorage()
    const finalizer = new IndexedDBStorage()
    await Promise.all([writer.initialize(), finalizer.initialize()])
    await writer.saveChat(
      storedChat('finalize-race', {
        locallyModified: true,
        messages: [
          {
            role: 'user',
            content: 'Uploaded message',
            timestamp: new Date('2026-08-12T00:00:00.000Z'),
            attachments: [
              {
                id: 'uploaded-attachment',
                type: 'image',
                fileName: 'uploaded.png',
                base64: 'uploaded-payload',
              },
            ],
          },
        ],
      }),
    )
    const uploaded = await writer.getChat('finalize-race')
    if (!uploaded) throw new Error('Expected stored chat')
    const uploadedPayloadId = (
      uploaded.messages[0].attachments?.[0] as {
        storagePayloadId?: string
      }
    ).storagePayloadId

    const blocker = blockChatTransaction(
      writer,
      uploaded.id,
      (chat, transaction) => {
        const newPayloadId = 'cross-tab-new-payload'
        chat.messages.push({
          role: 'user',
          content: 'Newer tab message',
          timestamp: new Date('2026-08-12T00:00:01.000Z'),
          attachments: [
            {
              id: 'new-attachment',
              type: 'document',
              fileName: 'new.txt',
              storagePayloadId: newPayloadId,
            } as any,
          ],
        })
        chat.updatedAt = '2026-08-12T00:00:01.000Z'
        chat.locallyModified = true
        transaction.objectStore('attachmentPayloads').put({
          id: newPayloadId,
          chatId: chat.id,
          textContent: 'Newer tab payload',
        })
        transaction.objectStore('chats').put(chat)
      },
    )
    await blocker.ready
    const finalizerDb = (finalizer as any).db as IDBDatabase
    const transactionSpy = vi.spyOn(finalizerDb, 'transaction')
    const finalizing = finalizer.finalizeUpload({
      chatId: uploaded.id,
      rewrites: [
        {
          clientId: 'uploaded-attachment',
          serverId: 'server-attachment',
          encryptionKey: 'server-key',
          storagePayloadId: uploadedPayloadId,
        },
      ],
      preUploadUpdatedAt: uploaded.updatedAt,
      preUploadFingerprint: chatContentFingerprint(uploaded),
      syncVersion: 4,
      uploadedProjectId: uploaded.projectId,
      projectIntentIncluded: false,
    })
    await vi.waitFor(() =>
      expect(transactionSpy).toHaveBeenCalledWith(
        ['chats', 'attachmentPayloads', 'chatSummaries'],
        'readwrite',
      ),
    )
    blocker.release()
    await Promise.all([blocker.complete, finalizing])

    const result = await writer.getChat(uploaded.id)
    expect(result?.messages.map((message) => message.content)).toEqual([
      'Uploaded message',
      'Newer tab message',
    ])
    expect(result?.messages[0].attachments?.[0]).toMatchObject({
      id: 'uploaded-attachment',
      base64: 'uploaded-payload',
    })
    expect(result?.messages[0].attachments?.[0].encryptionKey).toBeUndefined()
    expect(result?.messages[1].attachments?.[0].textContent).toBe(
      'Newer tab payload',
    )
    expect(result?.locallyModified).toBe(true)
    expect(result?.syncVersion).toBe(4)
  })

  it('keeps replacement bytes uploadable when finalization was blocked', async () => {
    const writer = new IndexedDBStorage()
    const finalizer = new IndexedDBStorage()
    await Promise.all([writer.initialize(), finalizer.initialize()])
    await writer.saveChat(
      storedChat('replacement-race', {
        locallyModified: true,
        messages: [
          {
            role: 'user',
            content: 'Image',
            timestamp: new Date('2026-08-12T00:00:00.000Z'),
            attachments: [
              {
                id: 'client-image',
                type: 'image',
                fileName: 'image.png',
                base64: 'old-bytes',
              },
            ],
          },
        ],
      }),
    )
    const uploaded = await writer.getChat('replacement-race')
    if (!uploaded) throw new Error('Expected stored chat')
    const payloadId = (
      uploaded.messages[0].attachments?.[0] as {
        storagePayloadId?: string
      }
    ).storagePayloadId
    if (!payloadId) throw new Error('Expected attachment payload id')

    const blocker = blockChatTransaction(
      writer,
      uploaded.id,
      (chat, transaction) => {
        chat.updatedAt = '2026-08-12T00:00:01.000Z'
        chat.locallyModified = true
        transaction.objectStore('attachmentPayloads').put({
          id: payloadId,
          chatId: chat.id,
          base64: 'new-bytes',
        })
        transaction.objectStore('chats').put(chat)
      },
    )
    await blocker.ready
    const finalizing = finalizer.finalizeUpload({
      chatId: uploaded.id,
      rewrites: [
        {
          clientId: 'client-image',
          serverId: 'old-server-image',
          encryptionKey: 'old-server-key',
          storagePayloadId: payloadId,
        },
      ],
      preUploadUpdatedAt: uploaded.updatedAt,
      preUploadFingerprint: chatContentFingerprint(uploaded),
      syncVersion: 4,
      uploadedProjectId: uploaded.projectId,
      projectIntentIncluded: false,
    })
    blocker.release()
    await Promise.all([blocker.complete, finalizing])

    const result = await writer.getChat(uploaded.id)
    expect(result?.messages[0].attachments?.[0]).toMatchObject({
      id: 'client-image',
      base64: 'new-bytes',
    })
    expect(result?.messages[0].attachments?.[0].encryptionKey).toBeUndefined()
    expect(result).toMatchObject({ locallyModified: true, syncVersion: 4 })
  })

  it('keeps same-timestamp edits dirty using the upload fingerprint', async () => {
    const storage = new IndexedDBStorage()
    await storage.initialize()
    await storage.saveChat(
      storedChat('same-timestamp-finalize', {
        title: 'Before upload',
        locallyModified: true,
      }),
    )
    const uploaded = await storage.getChat('same-timestamp-finalize')
    if (!uploaded) throw new Error('Expected stored chat')
    const preUploadFingerprint = chatContentFingerprint(uploaded)

    await storage.saveChat({
      ...uploaded,
      title: 'Edited during upload',
      updatedAt: uploaded.updatedAt,
    })
    await storage.finalizeUpload({
      chatId: uploaded.id,
      rewrites: [],
      preUploadUpdatedAt: uploaded.updatedAt,
      preUploadFingerprint,
      syncVersion: 5,
      uploadedProjectId: uploaded.projectId,
      projectIntentIncluded: false,
    })

    expect(await storage.getChat(uploaded.id)).toMatchObject({
      title: 'Edited during upload',
      updatedAt: uploaded.updatedAt,
      locallyModified: true,
      syncVersion: 5,
    })
  })

  it('rechecks remote apply CAS after an overlapping tab transaction', async () => {
    const writer = new IndexedDBStorage()
    const remoteWriter = new IndexedDBStorage()
    await Promise.all([writer.initialize(), remoteWriter.initialize()])
    await writer.saveChat(
      storedChat('remote-race', {
        locallyModified: false,
        messages: [
          {
            role: 'user',
            content: 'Original',
            timestamp: new Date('2026-08-12T00:00:00.000Z'),
            attachments: [
              {
                id: 'attachment',
                type: 'document',
                fileName: 'original.txt',
                textContent: 'Original payload',
              },
            ],
          },
        ],
      }),
    )
    const expectedUpdatedAt = '2026-08-12T00:00:00.000Z'
    const blocker = blockChatTransaction(
      writer,
      'remote-race',
      (chat, transaction) => {
        chat.messages.push({
          role: 'assistant',
          content: 'Local tab won',
          timestamp: new Date('2026-08-12T00:00:01.000Z'),
        })
        chat.updatedAt = '2026-08-12T00:00:01.000Z'
        chat.locallyModified = true
        transaction.objectStore('chats').put(chat)
      },
    )
    await blocker.ready
    const remoteDb = (remoteWriter as any).db as IDBDatabase
    const transactionSpy = vi.spyOn(remoteDb, 'transaction')
    const applying = remoteWriter.applyRemoteChatIfFresh({
      chat: storedChat('remote-race', {
        updatedAt: '2026-08-12T00:00:02.000Z',
        messages: [
          {
            role: 'assistant',
            content: 'Remote replacement',
            timestamp: new Date('2026-08-12T00:00:02.000Z'),
          },
        ],
      }),
      syncVersion: 5,
      expectedLocalUpdatedAt: expectedUpdatedAt,
      allowLocallyModified: true,
    })
    await vi.waitFor(() =>
      expect(transactionSpy).toHaveBeenCalledWith(
        ['chats', 'attachmentPayloads', 'chatSummaries', 'sync_outbox'],
        'readwrite',
      ),
    )
    blocker.release()
    const [applyResult] = await Promise.all([applying, blocker.complete])

    expect(applyResult).toEqual({ applied: false })
    const result = await writer.getChat('remote-race')
    expect(result?.messages.map((message) => message.content)).toEqual([
      'Original',
      'Local tab won',
    ])
    expect(result?.messages[0].attachments?.[0].textContent).toBe(
      'Original payload',
    )
  })

  it('rolls back payload reconciliation when a remote apply becomes stale', async () => {
    const storage = new IndexedDBStorage()
    await storage.initialize()
    await storage.saveChat(
      storedChat('cancelled-remote-apply', {
        locallyModified: false,
        messages: [
          {
            role: 'user',
            content: 'Original',
            timestamp: new Date('2026-08-12T00:00:00.000Z'),
            attachments: [
              {
                id: 'first',
                type: 'document',
                fileName: 'first.txt',
                textContent: 'First payload',
              },
              {
                id: 'second',
                type: 'document',
                fileName: 'second.txt',
                textContent: 'Second payload',
              },
            ],
          },
        ],
      }),
    )
    let current = true
    let payloadDeleted = false
    const originalDelete = FakeIDBCursor.prototype.delete
    vi.spyOn(FakeIDBCursor.prototype, 'delete').mockImplementation(function (
      this: IDBCursor,
    ) {
      const request = originalDelete.call(this)
      const store =
        'objectStore' in this.source ? this.source.objectStore : this.source
      if (store.name === 'attachmentPayloads') {
        request.addEventListener('success', () => {
          payloadDeleted = true
          current = false
        })
      }
      return request
    })
    const result = await storage.applyRemoteChatIfFresh({
      chat: storedChat('cancelled-remote-apply', {
        updatedAt: '2026-08-12T00:00:01.000Z',
        messages: [
          {
            role: 'assistant',
            content: 'Remote replacement',
            timestamp: new Date('2026-08-12T00:00:01.000Z'),
          },
        ],
      }),
      syncVersion: 2,
      expectedLocalUpdatedAt: undefined,
      isCurrent: () => current,
    })

    expect(result).toEqual({ applied: false })
    expect(payloadDeleted).toBe(true)
    const stored = await storage.getChat('cancelled-remote-apply')
    expect(stored?.messages[0].content).toBe('Original')
    expect(
      stored?.messages[0].attachments?.map(
        (attachment) => attachment.textContent,
      ),
    ).toEqual(['First payload', 'Second payload'])
  })
})
