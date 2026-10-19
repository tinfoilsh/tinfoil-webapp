import type { StoredThread } from '@/services/harness/types'
import { chatEvents } from '@/services/storage/chat-events'
import { deletedChatsTracker } from '@/services/storage/deleted-chats-tracker'
import {
  DB_NAME,
  DB_VERSION,
  indexedDBStorage,
} from '@/services/storage/indexed-db'
import { IDBKeyRange as FakeIDBKeyRange, IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeAll, beforeEach } from 'vitest'

// The rows of a chat database store, read with their own transaction.
export async function rawRows(store: 'chats' | 'attachmentPayloads') {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve(request.result)
  })
  try {
    return await new Promise<Record<string, unknown>[]>((resolve, reject) => {
      const request = db.transaction(store).objectStore(store).getAll()
      request.onerror = () => reject(request.error)
      request.onsuccess = () => resolve(request.result)
    })
  } finally {
    db.close()
  }
}

// Each test starts with no stored chats and an empty session storage.
export function resetChatStoresAroundEachTest() {
  beforeAll(() => {
    Object.defineProperty(globalThis, 'indexedDB', {
      configurable: true,
      value: new IDBFactory(),
    })
    Object.defineProperty(globalThis, 'IDBKeyRange', {
      configurable: true,
      value: FakeIDBKeyRange,
    })
  })

  beforeEach(async () => {
    deletedChatsTracker.clear()
    await indexedDBStorage.deleteAllChats()
  })

  afterEach(() => {
    chatEvents.clear()
    deletedChatsTracker.clear()
  })
}

// A chat in the harness's thread format, as the harness returns it and this
// device keeps it.
export function storedThread(
  id: string,
  fields: Partial<StoredThread> = {},
): StoredThread {
  return {
    id,
    title: 'New Chat',
    titleState: 'placeholder',
    createdAt: '2026-04-01T09:00:00Z',
    updatedAt: '2026-04-01T09:00:00Z',
    model: 'test-model',
    projectId: null,
    presetId: null,
    pinned: false,
    webSearchEnabled: true,
    messages: [],
    activeRun: null,
    ...fields,
  }
}
