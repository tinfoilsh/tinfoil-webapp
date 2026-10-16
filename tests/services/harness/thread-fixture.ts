import {
  AUTH_ACTIVE_USER_ID,
  SETTINGS_CLOUD_SYNC_ENABLED,
} from '@/constants/storage-keys'
import type { HarnessClient } from '@/services/harness/client'
import { activateAPI, HarnessAPI, publish } from '@/services/harness/runtime'
import type { Session } from '@/services/harness/types'
import { chatEvents } from '@/services/storage/chat-events'
import { deletedChatsTracker } from '@/services/storage/deleted-chats-tracker'
import {
  DB_NAME,
  DB_VERSION,
  indexedDBStorage,
} from '@/services/storage/indexed-db'
import { IDBKeyRange as FakeIDBKeyRange, IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeAll, beforeEach, vi, type Mock } from 'vitest'
import { testSession } from '../../harness-fixture'

export const KEY = 'Y29udGVudC1rZXk='

export let client: {
  events: Mock
  post: Mock
  upload: Mock
  download: Mock
}

// Signs an account in to a harness whose client each test scripts. The
// account's content key is unlocked unless `locked`; a signed-out visitor
// has none.
export function signIn({
  userId = 'alice',
  cloud = false,
  locked = false,
  session = testSession,
  profile = {},
}: {
  userId?: string | null
  cloud?: boolean
  locked?: boolean
  session?: Session
  profile?: Record<string, unknown>
} = {}) {
  if (userId) localStorage.setItem(AUTH_ACTIVE_USER_ID, userId)
  localStorage.setItem(SETTINGS_CLOUD_SYNC_ENABLED, String(cloud))
  client = {
    events: vi.fn(),
    post: vi.fn().mockResolvedValue({}),
    upload: vi.fn(),
    download: vi.fn(),
  }
  const api = new HarnessAPI(client as unknown as HarnessClient, userId)
  const unlocked = !!userId && !locked
  if (unlocked) vi.spyOn(api, 'key').mockReturnValue(KEY)
  activateAPI(api)
  publish({
    session,
    profile,
    keyReady: unlocked || !userId,
    profileReady: true,
  })
  return api
}

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
    sessionStorage.clear()
    deletedChatsTracker.clear()
    await indexedDBStorage.deleteAllChats()
    deletedChatsTracker.clear()
  })

  afterEach(() => {
    chatEvents.clear()
    deletedChatsTracker.clear()
    sessionStorage.clear()
    vi.restoreAllMocks()
  })
}
