import {
  AttachmentPayloadIdUnavailableError,
  AttachmentPayloadMissingError,
  DB_NAME,
  DB_VERSION,
  IndexedDBStorage,
  type StoredChat,
} from '@/services/storage/indexed-db'
import { IDBKeyRange as FakeIDBKeyRange, IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// A row as an earlier version stored it, with the sync fields it kept.
type EarlierRow = StoredChat & Record<string, unknown>

function storedChat(id: string, overrides: Partial<EarlierRow> = {}) {
  return {
    id,
    title: id,
    messages: [],
    createdAt: '2026-08-12T00:00:00.000Z',
    updatedAt: '2026-08-12T00:00:00.000Z',
    ...overrides,
  } as EarlierRow
}

function openDatabase(version?: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, version)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve(request.result)
  })
}

function put(
  db: IDBDatabase,
  rows: Record<string, Record<string, unknown>[]>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(Object.keys(rows), 'readwrite')
    for (const [store, values] of Object.entries(rows))
      for (const value of values) transaction.objectStore(store).put(value)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
  })
}

async function openVersionThree(chats: EarlierRow[]): Promise<IDBDatabase> {
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

  await put(db, { chats })
  return db
}

async function seedVersionThree(chats: EarlierRow[]): Promise<void> {
  const db = await openVersionThree(chats)
  db.close()
}

// The schema version 7 created for a new browser.
async function seedVersionSeven(
  rows: Record<string, Record<string, unknown>[]>,
): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 7)
    request.onerror = () => reject(request.error)
    request.onupgradeneeded = () => {
      const db = request.result
      const chats = db.createObjectStore('chats', { keyPath: 'id' })
      for (const index of [
        'lastAccessedAt',
        'createdAt',
        'syncedAt',
        'syncPending',
        'projectId',
      ])
        chats.createIndex(index, index)
      chats.createIndex('pendingUploadByUser', ['pendingUpload', 'syncUserId'])
      db.createObjectStore('projects', { keyPath: 'cacheKey' }).createIndex(
        'userId',
        'userId',
      )
      db.createObjectStore('sync_state', { keyPath: 'id' })
      db.createObjectStore('remote_chat_state', { keyPath: 'id' })
      db.createObjectStore('sync_outbox', {
        keyPath: ['userId', 'id'],
      }).createIndex('userId', 'userId')
      db.createObjectStore('migrations', { keyPath: 'id' })
      db.createObjectStore('attachmentPayloads', {
        keyPath: 'id',
      }).createIndex('chatId', 'chatId')
      db.createObjectStore('chatSummaries', { keyPath: 'id' })
    }
    request.onsuccess = () => resolve(request.result)
  })
  await put(db, rows)
  db.close()
}

describe('IndexedDB pending sync index', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  beforeEach(() => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    vi.stubGlobal('IDBKeyRange', FakeIDBKeyRange)
  })

  it('keeps every existing chat readable after upgrading, malformed ones included', async () => {
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

    expect((await storage.getAllChatIds()).sort()).toEqual([
      'clean',
      'dirty',
      'local',
      'malformed',
      'malformed-message',
      'never-synced',
      'undecryptable',
    ])
    expect(
      (await storage.getChatSummaries()).map((chat) => chat.id).sort(),
    ).toEqual([
      'clean',
      'dirty',
      'local',
      'malformed-message',
      'never-synced',
      'undecryptable',
    ])
  })

  it('keeps a chat stored by the previous version and drops what nothing reads', async () => {
    const thread = {
      id: 'device-chat',
      title: 'Device chat',
      titleState: 'manual',
      createdAt: '2026-08-12T00:00:00.000Z',
      updatedAt: '2026-08-12T00:00:00.000Z',
    }
    const row = {
      id: 'device-chat',
      isLocalOnly: true,
      threadFormat: 1,
      title: 'Device chat',
      createdAt: '2026-08-12T00:00:00.000Z',
      updatedAt: '2026-08-12T00:00:00.000Z',
      thread,
      lastAccessedAt: 1,
      syncUserId: 'alice',
      messages: [
        {
          id: 'message-1',
          role: 'user',
          content: 'Read this',
          attachments: [
            {
              id: 'document-1',
              kind: 'document',
              fileName: 'notes.txt',
              storagePayloadId: 'device-chat:document-1',
            },
          ],
        },
      ],
    }
    await seedVersionSeven({
      chats: [row],
      chatSummaries: [{ ...row, messages: [], messageCount: 1 }],
      attachmentPayloads: [
        {
          id: 'device-chat:document-1',
          chatId: 'device-chat',
          textContent: 'Document text',
        },
      ],
      migrations: [{ id: 'chat-summaries-v6', completedAt: 1 }],
      projects: [{ cacheKey: 'project', userId: 'alice' }],
      sync_outbox: [{ userId: 'alice', id: 'device-chat' }],
    })

    const storage = new IndexedDBStorage()

    const stored = await storage.getChat('device-chat')
    expect(stored).toMatchObject({ id: 'device-chat', thread })
    expect(stored?.messages[0].attachments).toEqual([
      {
        id: 'document-1',
        kind: 'document',
        fileName: 'notes.txt',
        storagePayloadId: 'device-chat:document-1',
        textContent: 'Document text',
      },
    ])
    expect((await storage.getChatSummaries()).map((chat) => chat.id)).toEqual([
      'device-chat',
    ])
    const db = await openDatabase()
    expect(Array.from(db.objectStoreNames).sort()).toEqual([
      'attachmentPayloads',
      'chatSummaries',
      'chats',
      'migrations',
    ])
    expect(
      Array.from(db.transaction('chats').objectStore('chats').indexNames),
    ).toEqual([])
    db.close()
  })

  it('fails a blocked upgrade promptly and allows a retry', async () => {
    const olderConnection = await openVersionThree([storedChat('cloud-chat')])
    olderConnection.onversionchange = () => undefined
    const storage = new IndexedDBStorage()

    await expect(storage.getAllChatIds()).rejects.toThrow(
      'Database upgrade blocked',
    )
    olderConnection.close()

    await expect(storage.getAllChatIds()).resolves.toEqual(['cloud-chat'])
  })

  it('stores attachment payloads separately and hydrates them on read', async () => {
    const storage = new IndexedDBStorage()
    await storage.initialize()
    const initializedDatabase = await openDatabase(DB_VERSION)
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
})
