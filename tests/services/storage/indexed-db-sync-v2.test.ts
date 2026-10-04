import { AUTH_ACTIVE_USER_ID } from '@/constants/storage-keys'
import {
  applyAttachmentRewritesInPlace,
  chatContentFingerprint,
  derivePendingUpload,
  IndexedDBStorage,
} from '@/services/storage/indexed-db'
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const DB_NAME = 'tinfoil-chat'
const LEGACY_DB_VERSION = 1
const SUMMARY_DATABASE_VERSION = 6

function deleteDatabase(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
    request.onblocked = () =>
      reject(new Error('Test database deletion blocked'))
  })
}

function createLegacyDatabase(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, LEGACY_DB_VERSION)
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore('chats', { keyPath: 'id' })
      store.createIndex('lastAccessedAt', 'lastAccessedAt')
      store.createIndex('createdAt', 'createdAt')
      store.createIndex('syncedAt', 'syncedAt')
      store.createIndex('locallyModified', 'locallyModified')
      store.put({
        id: 'dirty-chat',
        title: 'Dirty',
        messages: [{ role: 'user', content: 'hello' }],
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        lastAccessedAt: 0,
        locallyModified: true,
        isLocalOnly: false,
      })
    }
    request.onsuccess = () => {
      request.result.close()
      resolve()
    }
    request.onerror = () => reject(request.error)
  })
}

function createSummaryDatabase(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, SUMMARY_DATABASE_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      const chats = db.createObjectStore('chats', { keyPath: 'id' })
      chats.createIndex('lastAccessedAt', 'lastAccessedAt')
      chats.createIndex('createdAt', 'createdAt')
      chats.createIndex('syncedAt', 'syncedAt')
      chats.createIndex('syncPending', 'syncPending')
      chats.createIndex('projectId', 'projectId')
      const metadataOnlyChat = {
        id: 'metadata-only',
        title: 'Remote summary',
        messages: [],
        messageCount: 4,
        isMetadataOnly: true,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-02T00:00:00Z',
        lastAccessedAt: 0,
        locallyModified: true,
        syncPending: 1,
        isLocalOnly: false,
      }
      chats.put(metadataOnlyChat)

      const projects = db.createObjectStore('projects', {
        keyPath: 'cacheKey',
      })
      projects.createIndex('userId', 'userId')
      db.createObjectStore('migrations', { keyPath: 'id' })
      const payloads = db.createObjectStore('attachmentPayloads', {
        keyPath: 'id',
      })
      payloads.createIndex('chatId', 'chatId')
      const summaries = db.createObjectStore('chatSummaries', {
        keyPath: 'id',
      })
      summaries.put(metadataOnlyChat)
    }
    request.onsuccess = () => {
      request.result.close()
      resolve()
    }
    request.onerror = () => reject(request.error)
  })
}

function readIndexNames(storeName: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME)
    request.onsuccess = () => {
      const db = request.result
      const names = Array.from(
        db.transaction(storeName, 'readonly').objectStore(storeName).indexNames,
      )
      db.close()
      resolve(names)
    }
    request.onerror = () => reject(request.error)
  })
}

function readStoreNames(): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME)
    request.onsuccess = () => {
      const db = request.result
      const names = Array.from(db.objectStoreNames)
      db.close()
      resolve(names)
    }
    request.onerror = () => reject(request.error)
  })
}

describe('IndexedDB sync protocol v2 migration', () => {
  beforeEach(async () => {
    Object.defineProperty(window, 'indexedDB', {
      configurable: true,
      value: indexedDB,
    })
    localStorage.setItem(AUTH_ACTIVE_USER_ID, 'user-1')
    await deleteDatabase()
  })

  it('adds global state, remote metadata, outbox, and pending index', async () => {
    await createLegacyDatabase()
    const storage = new IndexedDBStorage()
    await storage.initialize()

    expect(await storage.hasPendingSyncWork('user-1')).toBe(true)
    await expect(storage.getPendingUploadChats('user-1')).resolves.toEqual([
      expect.objectContaining({ id: 'dirty-chat', pendingUpload: 1 }),
    ])
    await expect(storage.getSyncState('user-1')).resolves.toBeNull()
    expect(await readIndexNames('chats')).toContain('pendingUploadByUser')
    expect(await readIndexNames('chats')).not.toContain('pendingUpload')
    expect(await readIndexNames('remote_chat_state')).not.toContain('updatedAt')
  })

  it('fails closed when an upgraded pending row has no active account', async () => {
    localStorage.removeItem(AUTH_ACTIVE_USER_ID)
    await createLegacyDatabase()
    const storage = new IndexedDBStorage()
    await storage.initialize()

    expect(await storage.hasPendingSyncWork('user-1')).toBe(false)
    await expect(storage.getPendingUploadChats('user-1')).resolves.toEqual([])
  })

  it('upgrades the summary schema without making metadata uploadable', async () => {
    await createSummaryDatabase()
    const storage = new IndexedDBStorage()
    await storage.initialize()

    expect(await readStoreNames()).toEqual(
      expect.arrayContaining([
        'chats',
        'projects',
        'migrations',
        'attachmentPayloads',
        'chatSummaries',
        'sync_state',
        'remote_chat_state',
        'sync_outbox',
      ]),
    )
    expect(await readIndexNames('chats')).toEqual(
      expect.arrayContaining([
        'projectId',
        'syncPending',
        'pendingUploadByUser',
      ]),
    )
    await expect(storage.getPendingUploadChats('user-1')).resolves.toEqual([])
    await expect(storage.hasPendingSyncWork('user-1')).resolves.toBe(false)
    await expect(storage.getChatSummaries()).resolves.toEqual([
      expect.objectContaining({
        id: 'metadata-only',
        isMetadataOnly: true,
        messageCount: 0,
      }),
    ])
  })

  it('lists pending uploads only for their owning account', async () => {
    const storage = new IndexedDBStorage()
    await storage.initialize()
    await storage.saveChat({
      id: 'user-1-chat',
      title: 'One',
      messages: [{ role: 'user', content: 'one' } as any],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    })
    localStorage.setItem(AUTH_ACTIVE_USER_ID, 'user-2')
    await storage.saveChat({
      id: 'user-2-chat',
      title: 'Two',
      messages: [{ role: 'user', content: 'two' } as any],
      createdAt: '2026-01-02T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z',
    })

    await expect(storage.getPendingUploadChats('user-1')).resolves.toEqual([
      expect.objectContaining({ id: 'user-1-chat' }),
    ])
    await expect(storage.getPendingUploadChats('user-2')).resolves.toEqual([
      expect.objectContaining({ id: 'user-2-chat' }),
    ])
  })

  it('persists a local delete intent atomically with row removal', async () => {
    const storage = new IndexedDBStorage()
    await storage.initialize()
    await storage.saveChat({
      id: 'chat-1',
      title: 'Chat',
      messages: [{ role: 'user', content: 'hello' } as any],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    })

    await storage.markAsSynced('chat-1', 1)
    await storage.deleteChatWithPendingIntent(
      'chat-1',
      'stable-delete-key',
      'user-1',
    )

    await expect(storage.getChat('chat-1')).resolves.toBeNull()
    await expect(storage.getPendingDeletes('user-1')).resolves.toEqual([
      expect.objectContaining({
        id: 'chat-1',
        userId: 'user-1',
        idempotencyKey: 'stable-delete-key',
      }),
    ])
    expect(await storage.hasPendingSyncWork('user-1')).toBe(true)
  })

  it('does not create a remote delete for a never-synced local chat', async () => {
    const storage = new IndexedDBStorage()
    await storage.initialize()
    await storage.saveChat({
      id: 'local-create',
      title: 'Local create',
      messages: [{ role: 'user', content: 'hello' } as any],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    })

    const queued = await storage.deleteChatWithPendingIntent(
      'local-create',
      'unused-key',
      'user-1',
    )

    expect(queued).toBe(false)
    await expect(storage.getPendingDeletes('user-1')).resolves.toEqual([])
  })

  it('persists a forced delete intent when the local row is missing', async () => {
    const storage = new IndexedDBStorage()
    await storage.initialize()

    const queued = await storage.deleteChatWithPendingIntent(
      'memory-only-chat',
      'forced-delete-key',
      'user-1',
      { forceQueue: true },
    )

    expect(queued).toBe(true)
    await expect(storage.getPendingDeletes('user-1')).resolves.toEqual([
      expect.objectContaining({
        id: 'memory-only-chat',
        userId: 'user-1',
        idempotencyKey: 'forced-delete-key',
      }),
    ])
  })

  it('removes a matching delete intent with a remote deletion', async () => {
    const storage = new IndexedDBStorage()
    await storage.initialize()
    await storage.saveChat({
      id: 'chat-1',
      title: 'Chat',
      messages: [{ role: 'user', content: 'hello' } as any],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    })
    await storage.markAsSynced('chat-1', 1)
    await storage.deleteChatWithPendingIntent('chat-1', 'delete-key', 'user-1')

    await storage.applyRemoteDeletion('chat-1', 'user-1')

    await expect(storage.getPendingDeletes('user-1')).resolves.toEqual([])
  })

  it('does not apply a stale or wrong-owner remote deletion', async () => {
    const storage = new IndexedDBStorage()
    await storage.initialize()
    localStorage.setItem(AUTH_ACTIVE_USER_ID, 'user-2')
    await storage.saveChat({
      id: 'user-2-chat',
      title: 'Chat',
      messages: [{ role: 'user', content: 'hello' } as any],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    })
    await storage.markAsSynced('user-2-chat', 1)
    localStorage.setItem(AUTH_ACTIVE_USER_ID, 'user-1')

    await expect(
      storage.applyRemoteDeletion('user-2-chat', 'user-1'),
    ).resolves.toBe(false)
    await expect(storage.getChat('user-2-chat')).resolves.not.toBeNull()

    await expect(
      storage.applyRemoteDeletion('user-2-chat', 'user-2', () => false),
    ).resolves.toBe(false)
    await expect(storage.getChat('user-2-chat')).resolves.not.toBeNull()
  })

  it('blocks a remote apply while an account-scoped delete is pending', async () => {
    const storage = new IndexedDBStorage()
    await storage.initialize()
    const chat = {
      id: 'chat-1',
      title: 'Chat',
      messages: [{ role: 'user', content: 'hello' } as any],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    }
    await storage.saveChat(chat)
    await storage.markAsSynced(chat.id, 1)
    await storage.deleteChatWithPendingIntent(
      chat.id,
      'stable-delete-key',
      'user-1',
    )

    await expect(
      storage.applyRemoteChatIfFresh({
        chat,
        syncVersion: 2,
        expectedLocalUpdatedAt: null,
        userId: 'user-1',
      }),
    ).resolves.toEqual({ applied: false })
    await expect(storage.getChat(chat.id)).resolves.toBeNull()
  })

  it('aborts a remote apply when its account expires after the put', async () => {
    const storage = new IndexedDBStorage()
    await storage.initialize()
    const isCurrent = vi
      .fn<() => boolean>()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValue(false)

    await expect(
      storage.applyRemoteChatIfFresh({
        chat: {
          id: 'stale-account-chat',
          title: 'Stale',
          messages: [{ role: 'user', content: 'hello' } as any],
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
        syncVersion: 1,
        expectedLocalUpdatedAt: null,
        isCurrent,
      }),
    ).resolves.toEqual({ applied: false })
    await expect(storage.getChat('stale-account-chat')).resolves.toBeNull()
  })

  it('stages remote-only and locally discovered project deletes idempotently', async () => {
    const storage = new IndexedDBStorage()
    await storage.initialize()
    await storage.saveChat({
      id: 'local-chat',
      title: 'Local',
      projectId: 'project-1',
      messages: [{ role: 'user', content: 'hello' } as any],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      syncedAt: 1,
    })

    const keys = ['remote-key', 'local-key']
    await storage.deleteChatsByProject(
      'project-1',
      ['remote-only'],
      'user-1',
      () => keys.shift()!,
    )
    await storage.deleteChatsByProject(
      'project-1',
      ['remote-only'],
      'user-1',
      () => 'replacement-key',
    )

    await expect(storage.getChat('local-chat')).resolves.toBeNull()
    await expect(storage.getPendingDeletes('user-1')).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'local-chat',
          idempotencyKey: 'local-key',
        }),
        expect.objectContaining({
          id: 'remote-only',
          idempotencyKey: 'remote-key',
        }),
      ]),
    )
  })

  it('removes an in-flight local create without staging an absent-row intent', async () => {
    const storage = new IndexedDBStorage()
    await storage.initialize()
    const save = storage.saveChat({
      id: 'creating-chat',
      title: 'Creating',
      projectId: 'project-1',
      messages: [{ role: 'user', content: 'hello' } as any],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    })
    const deletion = storage.deleteChatsByProject(
      'project-1',
      [],
      'user-1',
      () => 'create-delete-key',
    )

    await Promise.all([save, deletion])

    await expect(storage.getChat('creating-chat')).resolves.toBeNull()
    await expect(storage.getPendingDeletes('user-1')).resolves.toEqual([])
  })

  it('does not stage project intents for zero-version local chats', async () => {
    const storage = new IndexedDBStorage()
    await storage.initialize()
    await storage.saveChat({
      id: 'zero-version-chat',
      title: 'Creating',
      projectId: 'project-1',
      syncVersion: 0,
      messages: [{ role: 'user', content: 'hello' } as any],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    })

    await storage.deleteChatsByProject(
      'project-1',
      [],
      'user-1',
      () => 'unused-key',
    )

    await expect(storage.getChat('zero-version-chat')).resolves.toBeNull()
    await expect(storage.getPendingDeletes('user-1')).resolves.toEqual([])
  })

  it('leaves project rows owned by another account untouched', async () => {
    const storage = new IndexedDBStorage()
    await storage.initialize()
    await storage.saveChat({
      id: 'user-1-chat',
      title: 'One',
      projectId: 'project-1',
      messages: [{ role: 'user', content: 'one' } as any],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    })
    localStorage.setItem(AUTH_ACTIVE_USER_ID, 'user-2')
    await storage.saveChat({
      id: 'user-2-chat',
      title: 'Two',
      projectId: 'project-1',
      messages: [{ role: 'user', content: 'two' } as any],
      createdAt: '2026-01-02T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z',
    })
    localStorage.setItem(AUTH_ACTIVE_USER_ID, 'user-1')

    await storage.deleteChatsByProject(
      'project-1',
      [],
      'user-1',
      () => 'user-1-delete-key',
    )

    await expect(storage.getChat('user-1-chat')).resolves.toBeNull()
    await expect(storage.getChat('user-2-chat')).resolves.toEqual(
      expect.objectContaining({ syncUserId: 'user-2' }),
    )
    await expect(storage.getPendingDeletes('user-2')).resolves.toEqual([])
  })

  it('does not stage project deletion after its account guard expires', async () => {
    const storage = new IndexedDBStorage()
    await storage.initialize()
    await storage.saveChat({
      id: 'chat-1',
      title: 'Chat',
      projectId: 'project-1',
      messages: [{ role: 'user', content: 'hello' } as any],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    })
    const isCurrent = vi
      .fn<() => boolean>()
      .mockReturnValueOnce(true)
      .mockReturnValue(false)

    await expect(
      storage.deleteChatsByProject(
        'project-1',
        [],
        'user-1',
        () => 'unused-key',
        isCurrent,
      ),
    ).resolves.toEqual([])
    await expect(storage.getChat('chat-1')).resolves.not.toBeNull()
    await expect(storage.getPendingDeletes('user-1')).resolves.toEqual([])
  })

  it('repairs state and outbox when the account changes', async () => {
    const storage = new IndexedDBStorage()
    await storage.initialize()
    await storage.commitRevisionBatch([], '7', 'user-1')

    await expect(storage.getSyncState('user-1')).resolves.toEqual(
      expect.objectContaining({ userId: 'user-1', appliedRevision: '7' }),
    )
    await expect(storage.getSyncState('user-2')).resolves.toBeNull()
  })

  it('invalidates the revision checkpoint when synced chats are wiped locally', async () => {
    const storage = new IndexedDBStorage()
    await storage.initialize()
    await storage.saveChat({
      id: 'synced-chat',
      title: 'Synced',
      messages: [{ role: 'user', content: 'hello' } as any],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    })
    await storage.markAsSynced('synced-chat', 1)
    await storage.saveChat({
      id: 'local-chat',
      title: 'Local',
      messages: [{ role: 'user', content: 'hello' } as any],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      isLocalOnly: true,
    })
    await storage.commitRevisionBatch([], '7', 'user-1')

    await expect(storage.deleteAllNonLocalChats()).resolves.toBe(1)

    await expect(storage.getChat('synced-chat')).resolves.toBeNull()
    await expect(storage.getChat('local-chat')).resolves.not.toBeNull()
    await expect(storage.getSyncState('user-1')).resolves.toBeNull()
  })

  it('preserves other-account delete intents across checkpoint resets', async () => {
    const storage = new IndexedDBStorage()
    await storage.initialize()
    await storage.saveChat({
      id: 'chat-1',
      title: 'Chat',
      messages: [{ role: 'user', content: 'hello' } as any],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    })
    await storage.markAsSynced('chat-1', 1)
    await storage.deleteChatWithPendingIntent('chat-1', 'delete-key', 'user-1')

    await storage.getSyncState('user-2')
    await storage.clearRevisionSyncState()

    await expect(storage.getPendingDeletes('user-1')).resolves.toHaveLength(1)
    await storage.clearRevisionSyncStateAfterServerWipe('user-2')
    await expect(storage.getPendingDeletes('user-1')).resolves.toHaveLength(1)
    await storage.clearRevisionSyncStateAfterServerWipe('user-1')
    await expect(storage.getPendingDeletes('user-1')).resolves.toEqual([])
  })

  it('preserves dirty project membership and ETag during metadata commits', async () => {
    const storage = new IndexedDBStorage()
    await storage.initialize()
    await storage.saveChat({
      id: 'dirty-chat',
      title: 'Chat',
      messages: [{ role: 'user', content: 'hello' } as any],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    })
    await storage.markAsSynced('dirty-chat', 2)
    await storage.updateChatProject('dirty-chat', 'local-project')

    await storage.commitRevisionBatch(
      [
        {
          id: 'dirty-chat',
          revision: '3',
          kind: 'upsert',
          etag: '3',
          projectId: 'remote-project',
          updatedAt: '2026-01-02T00:00:00Z',
        },
      ],
      '3',
      'user-1',
    )

    await expect(storage.getChat('dirty-chat')).resolves.toEqual(
      expect.objectContaining({
        projectId: 'local-project',
        syncVersion: 2,
        locallyModified: true,
        projectLocallyModified: true,
      }),
    )
  })

  it('preserves dirty metadata during snapshot reconciliation', async () => {
    const storage = new IndexedDBStorage()
    await storage.initialize()
    await storage.saveChat({
      id: 'dirty-chat',
      title: 'Chat',
      projectId: 'local-project',
      messages: [{ role: 'user', content: 'hello' } as any],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    })
    await storage.markAsSynced('dirty-chat', 2)
    await storage.updateChatProject('dirty-chat', 'local-project-2')

    await storage.reconcileRevisionSnapshot(
      [
        {
          id: 'dirty-chat',
          revision: '4',
          kind: 'upsert',
          etag: '4',
          projectId: 'remote-project',
          updatedAt: '2026-01-02T00:00:00Z',
        },
      ],
      '4',
      'user-1',
    )

    await expect(storage.getChat('dirty-chat')).resolves.toEqual(
      expect.objectContaining({
        projectId: 'local-project-2',
        syncVersion: 2,
        locallyModified: true,
        projectLocallyModified: true,
      }),
    )
  })

  it('applies a remote project delete to a content-dirty chat', async () => {
    const storage = new IndexedDBStorage()
    await storage.initialize()
    await storage.saveChat({
      id: 'dirty-chat',
      title: 'Chat',
      projectId: 'old-project',
      messages: [{ role: 'user', content: 'hello' } as any],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    })
    await storage.markAsSynced('dirty-chat', 2)
    await storage.saveChat({
      ...(await storage.getChat('dirty-chat'))!,
      title: 'Locally edited',
    })

    await storage.commitRevisionBatch(
      [
        {
          id: 'dirty-chat',
          revision: '3',
          kind: 'upsert',
          etag: '3',
          projectId: null,
          updatedAt: '2026-01-02T00:00:00Z',
        },
      ],
      '3',
      'user-1',
    )

    await expect(storage.getChat('dirty-chat')).resolves.toEqual(
      expect.objectContaining({
        projectId: undefined,
        locallyModified: true,
        projectLocallyModified: false,
      }),
    )
  })

  it('applies a remote project move during dirty snapshot reconciliation', async () => {
    const storage = new IndexedDBStorage()
    await storage.initialize()
    await storage.saveChat({
      id: 'dirty-chat',
      title: 'Chat',
      projectId: 'old-project',
      messages: [{ role: 'user', content: 'hello' } as any],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    })
    await storage.markAsSynced('dirty-chat', 2)
    await storage.saveChat({
      ...(await storage.getChat('dirty-chat'))!,
      title: 'Locally edited',
    })

    await storage.reconcileRevisionSnapshot(
      [
        {
          id: 'dirty-chat',
          revision: '4',
          kind: 'upsert',
          etag: '4',
          projectId: 'remote-project',
          updatedAt: '2026-01-02T00:00:00Z',
        },
      ],
      '4',
      'user-1',
    )

    await expect(storage.getChat('dirty-chat')).resolves.toEqual(
      expect.objectContaining({
        projectId: 'remote-project',
        locallyModified: true,
        projectLocallyModified: false,
      }),
    )
  })

  it('recomputes pending state for local-only and project toggles', async () => {
    const storage = new IndexedDBStorage()
    await storage.initialize()
    await storage.saveChat({
      id: 'chat-1',
      title: 'Chat',
      messages: [{ role: 'user', content: 'hello' } as any],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    })
    await expect(storage.getChat('chat-1')).resolves.toEqual(
      expect.objectContaining({ pendingUpload: 1 }),
    )

    await storage.updateChatLocalOnly('chat-1', true)
    await expect(storage.getChat('chat-1')).resolves.toEqual(
      expect.objectContaining({ pendingUpload: 0 }),
    )

    await storage.updateChatLocalOnly('chat-1', false)
    await storage.updateChatProject('chat-1', 'project-1')
    await expect(storage.getChat('chat-1')).resolves.toEqual(
      expect.objectContaining({ pendingUpload: 1 }),
    )
  })

  it('clears only the uploaded project intent during finalization', async () => {
    const storage = new IndexedDBStorage()
    await storage.initialize()
    await storage.saveChat({
      id: 'chat-1',
      title: 'Chat',
      messages: [{ role: 'user', content: 'hello' } as any],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    })
    await storage.markAsSynced('chat-1', 1)
    await storage.updateChatProject('chat-1', 'project-a')
    const uploaded = await storage.getChat('chat-1')
    await storage.finalizeUpload({
      chatId: 'chat-1',
      rewrites: [],
      preUploadUpdatedAt: uploaded!.updatedAt,
      syncVersion: 2,
      uploadedProjectId: 'project-a',
      projectIntentIncluded: true,
    })
    await expect(storage.getChat('chat-1')).resolves.toEqual(
      expect.objectContaining({ projectLocallyModified: false }),
    )

    await storage.updateChatProject('chat-1', 'project-b')
    await storage.finalizeUpload({
      chatId: 'chat-1',
      rewrites: [],
      preUploadUpdatedAt: uploaded!.updatedAt,
      syncVersion: 3,
      uploadedProjectId: 'project-a',
      projectIntentIncluded: true,
    })
    await expect(storage.getChat('chat-1')).resolves.toEqual(
      expect.objectContaining({
        projectId: 'project-b',
        projectLocallyModified: true,
      }),
    )
  })

  it('preserves local project intent while rebasing a conflict retry', async () => {
    const storage = new IndexedDBStorage()
    await storage.initialize()
    await storage.saveChat({
      id: 'chat-1',
      title: 'Chat',
      messages: [{ role: 'user', content: 'hello' } as any],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    })
    await storage.markAsSynced('chat-1', 1)
    await storage.updateChatProject('chat-1', 'local-project')

    await storage.rebaseSyncVersion('chat-1', 2)

    await expect(storage.getChat('chat-1')).resolves.toEqual(
      expect.objectContaining({
        projectId: 'local-project',
        projectLocallyModified: true,
        locallyModified: true,
        syncVersion: 2,
      }),
    )
  })

  it('preserves reset rows when an empty wipe snapshot is reconciled', async () => {
    const storage = new IndexedDBStorage()
    await storage.initialize()
    await storage.saveChat({
      id: 'reset-chat',
      title: 'Reset',
      messages: [{ role: 'user', content: 'hello' } as any],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    })
    await storage.markAsSynced('reset-chat', 3)
    await storage.commitRevisionBatch([], '9', 'user-1')

    await storage.resetSyncMetadataForAllChats()
    await storage.clearRevisionSyncState()
    await storage.reconcileRevisionSnapshot([], '10', 'user-1')

    await expect(storage.getChat('reset-chat')).resolves.toEqual(
      expect.objectContaining({
        syncVersion: 0,
        syncedAt: undefined,
        locallyModified: true,
      }),
    )
  })

  it('records attachment rewrites without touching sync bookkeeping', async () => {
    const storage = new IndexedDBStorage()
    await storage.initialize()
    await storage.saveChat({
      id: 'chat-1',
      title: 'Chat',
      messages: [
        {
          role: 'user',
          content: 'hello',
          attachments: [
            {
              id: 'local-att',
              type: 'image',
              fileName: 'image.png',
              base64: 'AQID',
            },
          ],
        } as any,
      ],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    })
    await storage.markAsSynced('chat-1', 1)
    await storage.saveChat({
      ...(await storage.getChat('chat-1'))!,
      title: 'Edited',
    })
    const before = (await storage.getChat('chat-1'))!
    expect(before.locallyModified).toBe(true)

    await storage.recordAttachmentRewrites('chat-1', [
      { clientId: 'local-att', serverId: 'srv-att', encryptionKey: 'k' },
    ])

    const after = (await storage.getChat('chat-1'))!
    expect(after.messages[0].attachments?.[0]).toEqual(
      expect.objectContaining({
        id: 'srv-att',
        encryptionKey: 'k',
        base64: 'AQID',
      }),
    )
    expect(after.locallyModified).toBe(true)
    expect(after.pendingUpload).toBe(1)
    expect(after.syncVersion).toBe(before.syncVersion)
    expect(after.updatedAt).toBe(before.updatedAt)
    expect(after.clock).toBe(before.clock)
  })

  it('finalizes an upload whose attachment rewrites were persisted before the push', async () => {
    const storage = new IndexedDBStorage()
    await storage.initialize()
    localStorage.setItem(AUTH_ACTIVE_USER_ID, 'user-1')
    await storage.saveChat({
      id: 'chat-1',
      title: 'Chat',
      messages: [
        {
          role: 'user',
          content: 'hello',
          timestamp: new Date('2026-01-01T00:00:00Z'),
          attachments: [
            {
              id: 'local-att',
              type: 'image',
              fileName: 'image.png',
              base64: 'AQID',
            },
          ],
        } as any,
      ],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    })
    const snapshot = (await storage.getChat('chat-1'))!
    expect(snapshot.pendingUpload).toBe(1)
    const rewrites = [
      { clientId: 'local-att', serverId: 'srv-att', encryptionKey: 'k' },
    ]

    // What the sync service does: persist rewrites as soon as the enclave
    // stores the bytes, then finalize against the snapshot with those
    // rewrites applied.
    await storage.recordAttachmentRewrites('chat-1', rewrites)
    const expected = structuredClone(snapshot)
    applyAttachmentRewritesInPlace(expected.messages, rewrites)
    await storage.finalizeUpload({
      chatId: 'chat-1',
      rewrites,
      preUploadUpdatedAt: snapshot.updatedAt,
      preUploadFingerprint: chatContentFingerprint(expected),
      syncVersion: 1,
      uploadedProjectId: undefined,
      projectIntentIncluded: false,
    })

    const finalized = (await storage.getChat('chat-1'))!
    expect(finalized.pendingUpload).toBe(0)
    expect(finalized.locallyModified).toBe(false)
    expect(finalized.syncVersion).toBe(1)
    expect(finalized.messages[0].attachments?.[0]).toEqual(
      expect.objectContaining({ id: 'srv-att', encryptionKey: 'k' }),
    )
  })

  it('forgets server identity only for attachments it can re-upload', async () => {
    const storage = new IndexedDBStorage()
    await storage.initialize()
    localStorage.setItem(AUTH_ACTIVE_USER_ID, 'user-1')
    await storage.saveChat({
      id: 'chat-1',
      title: 'Chat',
      messages: [
        {
          role: 'user',
          content: 'hello',
          timestamp: new Date('2026-01-01T00:00:00Z'),
          attachments: [
            {
              id: 'srv-full',
              type: 'image',
              fileName: 'full.png',
              base64: 'AQID',
              encryptionKey: 'k-full',
            },
            {
              id: 'srv-thumb-only',
              type: 'image',
              fileName: 'thumb.png',
              thumbnailBase64: 'dGh1bWI=',
              encryptionKey: 'k-thumb',
            },
            {
              id: 'srv-doc',
              type: 'document',
              fileName: 'doc.txt',
              textContent: 'text',
              encryptionKey: 'k-doc',
            },
            {
              id: 'srv-untouched',
              type: 'image',
              fileName: 'other.png',
              base64: 'BAUG',
              encryptionKey: 'k-other',
            },
          ],
        } as any,
      ],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    })

    const reset = await storage.forgetServerAttachments('chat-1', [
      'srv-full',
      'srv-thumb-only',
      'srv-doc',
    ])

    expect(reset).toEqual(['srv-full', 'srv-doc'])
    const after = (await storage.getChat('chat-1'))!
    const byId = Object.fromEntries(
      after.messages[0].attachments!.map((a) => [a.id, a]),
    )
    expect(byId['srv-full']).not.toHaveProperty('encryptionKey')
    expect(byId['srv-full'].base64).toBe('AQID')
    expect(byId['srv-doc']).not.toHaveProperty('encryptionKey')
    expect(byId['srv-doc'].textContent).toBe('text')
    expect(byId['srv-thumb-only'].encryptionKey).toBe('k-thumb')
    expect(byId['srv-untouched'].encryptionKey).toBe('k-other')
    expect(after.locallyModified).toBe(true)
  })

  it('derives pending uploads only for valid dirty content', () => {
    const valid = {
      locallyModified: true,
      syncUserId: 'user-1',
      messages: [{}] as any[],
    }
    expect(derivePendingUpload(valid)).toBe(1)
    expect(derivePendingUpload({ ...valid, isLocalOnly: true })).toBe(0)
    expect(derivePendingUpload({ ...valid, decryptionFailed: true })).toBe(0)
    expect(derivePendingUpload({ ...valid, dataCorrupted: true })).toBe(0)
    expect(derivePendingUpload({ ...valid, isBlankChat: true })).toBe(0)
    expect(derivePendingUpload({ ...valid, messages: [] })).toBe(0)
    expect(derivePendingUpload({ ...valid, isMetadataOnly: true })).toBe(0)
    expect(derivePendingUpload({ ...valid, locallyModified: false })).toBe(0)
  })
})
