import { ACCOUNT_RESET_FAILED_EVENT } from '@/constants/auth-events'
import {
  AUTH_ACCOUNT_RESET_FAILED,
  AUTH_ACCOUNT_RESET_SIGNAL,
} from '@/constants/storage-keys'
import { deletedChatsTracker } from '@/services/storage/deleted-chats-tracker'
import {
  DB_NAME,
  handleIndexedDBAccountResetStorageEvent,
  IndexedDBStorage,
} from '@/services/storage/indexed-db'
import {
  IDBKeyRange as FakeIDBKeyRange,
  IDBObjectStore as FakeIDBObjectStore,
  IDBFactory,
} from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface FakeResetTransaction {
  oncomplete: (() => void) | null
  onerror: (() => void) | null
  onabort: (() => void) | null
  abort: ReturnType<typeof vi.fn>
  objectStore: (storeName: string) => {
    clear: ReturnType<typeof vi.fn>
  }
}

describe('IndexedDBStorage account reset', () => {
  function prepareReset(storage: IndexedDBStorage) {
    const transaction: FakeResetTransaction = {
      oncomplete: null,
      onerror: null,
      onabort: null,
      abort: vi.fn(),
      objectStore: () => ({ clear: vi.fn(() => ({ onerror: null })) }),
    }
    vi.spyOn(storage as any, 'ensureDB').mockResolvedValue({
      objectStoreNames: ['chats'],
      transaction: vi.fn(() => transaction),
    })
    return { transaction }
  }

  function openDatabase(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME)
      request.onerror = () => reject(request.error)
      request.onsuccess = () => resolve(request.result)
    })
  }

  async function countRows(): Promise<Record<string, number>> {
    const db = await openDatabase()
    const names = Array.from(db.objectStoreNames)
    const transaction = db.transaction(names)
    const counts = await Promise.all(
      names.map(
        (name) =>
          new Promise<[string, number]>((resolve, reject) => {
            const request = transaction.objectStore(name).count()
            request.onerror = () => reject(request.error)
            request.onsuccess = () => resolve([name, request.result])
          }),
      ),
    )
    db.close()
    return Object.fromEntries(counts)
  }

  async function completeReset(transaction: FakeResetTransaction) {
    await vi.waitFor(() => expect(transaction.oncomplete).not.toBeNull())
    transaction.oncomplete?.()
  }

  beforeEach(() => {
    sessionStorage.clear()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('bypasses a stalled write queue and empties every store but migrations', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    vi.stubGlobal('IDBKeyRange', FakeIDBKeyRange)
    const storage = new IndexedDBStorage()
    await storage.initialize()
    const seeded = await openDatabase()
    const names = Array.from(seeded.objectStoreNames)
    const seed = seeded.transaction(names, 'readwrite')
    for (const name of names)
      seed.objectStore(name).put({ id: 'seed', cacheKey: 'seed', userId: 'u' })
    await new Promise((resolve) => (seed.oncomplete = resolve))
    seeded.close()
    const before = await countRows()
    expect(Object.values(before).every((count) => count > 0)).toBe(true)
    Object.assign(storage as any, { saveQueue: new Promise(() => {}) })

    await storage.resetForAccountChange()

    expect(await countRows()).toEqual(
      Object.fromEntries(
        names.map((name) => [name, name === 'migrations' ? before[name] : 0]),
      ),
    )
  })

  it('resets storage when another tab signals an account change', async () => {
    const storage = new IndexedDBStorage()
    const reset = vi
      .spyOn(storage, 'resetForAccountChange')
      .mockResolvedValue(undefined)
    const reload = vi
      .spyOn(window.location, 'reload')
      .mockImplementation(() => {})
    const clearDeletedChats = vi.spyOn(deletedChatsTracker, 'clear')
    sessionStorage.setItem(AUTH_ACCOUNT_RESET_FAILED, 'true')

    handleIndexedDBAccountResetStorageEvent(
      storage,
      new StorageEvent('storage', {
        key: AUTH_ACCOUNT_RESET_SIGNAL,
        newValue: 'reset_123',
      }),
    )

    expect(reset).toHaveBeenCalledWith(false)
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
    expect(clearDeletedChats).toHaveBeenCalledTimes(1)
    expect(clearDeletedChats.mock.invocationCallOrder[0]).toBeLessThan(
      reload.mock.invocationCallOrder[0],
    )
    expect(sessionStorage.getItem(AUTH_ACCOUNT_RESET_FAILED)).toBeNull()
  })

  it('reports cross-tab reset failures without re-enabling writes', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    vi.stubGlobal('IDBKeyRange', FakeIDBKeyRange)
    const storage = new IndexedDBStorage()
    await storage.initialize()
    const originalClear = FakeIDBObjectStore.prototype.clear
    vi.spyOn(FakeIDBObjectStore.prototype, 'clear').mockImplementationOnce(
      function (this: IDBObjectStore) {
        const request = originalClear.call(this)
        request.addEventListener('success', () => this.transaction.abort())
        return request
      },
    )
    const handleFailure = vi.fn()
    const reload = vi
      .spyOn(window.location, 'reload')
      .mockImplementation(() => {})
    const clearDeletedChats = vi.spyOn(deletedChatsTracker, 'clear')
    window.addEventListener(ACCOUNT_RESET_FAILED_EVENT, handleFailure)

    try {
      handleIndexedDBAccountResetStorageEvent(
        storage,
        new StorageEvent('storage', {
          key: AUTH_ACCOUNT_RESET_SIGNAL,
          newValue: 'reset_123',
        }),
      )

      await vi.waitFor(() => expect(handleFailure).toHaveBeenCalledTimes(1))
      expect(sessionStorage.getItem(AUTH_ACCOUNT_RESET_FAILED)).toBe('true')
      expect(clearDeletedChats).not.toHaveBeenCalled()
      expect(reload).not.toHaveBeenCalled()
      await expect(
        storage.saveChat({
          id: 'old-account-write',
          title: 'Blocked',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          messages: [],
        }),
      ).rejects.toThrow('IndexedDB write superseded by account change')
    } finally {
      window.removeEventListener(ACCOUNT_RESET_FAILED_EVENT, handleFailure)
    }
  })

  it('cancels writes that were queued before the account reset', async () => {
    const storage = new IndexedDBStorage()
    const { transaction } = prepareReset(storage)
    let releaseQueue!: () => void
    const stalledQueue = new Promise<void>((resolve) => {
      releaseQueue = resolve
    })
    Object.assign(storage as any, { saveQueue: stalledQueue })
    const saveInternal = vi
      .spyOn(storage as any, 'saveChatInternal')
      .mockResolvedValue(undefined)

    const save = storage.saveChat({
      id: 'chat_123',
      title: 'Old account chat',
      messages: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as any)
    const reset = storage.resetForAccountChange()
    await completeReset(transaction)
    await reset

    releaseQueue()

    await expect(save).rejects.toThrow(
      'IndexedDB write superseded by account change',
    )
    expect(saveInternal).not.toHaveBeenCalled()
  })

  it('rejects writes submitted after the account reset starts', async () => {
    const storage = new IndexedDBStorage()
    const { transaction } = prepareReset(storage)
    const saveInternal = vi
      .spyOn(storage as any, 'saveChatInternal')
      .mockResolvedValue(undefined)
    const reset = storage.resetForAccountChange()

    const save = storage.saveChat({
      id: 'chat_123',
      title: 'Old account chat',
      messages: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as any)

    await expect(save).rejects.toThrow(
      'IndexedDB write superseded by account change',
    )
    await completeReset(transaction)
    await reset

    await expect(
      storage.saveChat({
        id: 'chat_456',
        title: 'Late old account chat',
        messages: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as any),
    ).rejects.toThrow('IndexedDB write superseded by account change')
    expect(saveInternal).not.toHaveBeenCalled()
  })

  it('rejects reads after an account reset starts', async () => {
    const storage = new IndexedDBStorage()
    const { transaction } = prepareReset(storage)
    const reset = storage.resetForAccountChange()

    await expect(storage.getAllChatIds()).rejects.toThrow(
      'IndexedDB read superseded by account change',
    )
    await expect(storage.getChat('chat_123')).rejects.toThrow(
      'IndexedDB read superseded by account change',
    )

    await completeReset(transaction)
    await reset
  })

  it('rejects reads waiting behind a stalled save queue when reset starts', async () => {
    const storage = new IndexedDBStorage()
    Object.assign(storage as any, { saveQueue: new Promise(() => {}) })
    const read = storage.getChat('chat_123')
    const { transaction } = prepareReset(storage)

    const reset = storage.resetForAccountChange()

    await expect(read).rejects.toThrow(
      'IndexedDB read superseded by account change',
    )
    await completeReset(transaction)
    await reset
  })

  it('rejects reads that were already in flight when reset started', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    vi.stubGlobal('IDBKeyRange', FakeIDBKeyRange)
    const storage = new IndexedDBStorage()
    const chatId = 'in-flight-old-account'
    await storage.saveChat({
      id: chatId,
      title: 'Old account content',
      messages: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    let reset: Promise<void> | undefined
    const originalGet = FakeIDBObjectStore.prototype.get
    vi.spyOn(FakeIDBObjectStore.prototype, 'get').mockImplementation(function (
      this: IDBObjectStore,
      key: IDBValidKey | IDBKeyRange,
    ) {
      const request = originalGet.call(this, key)
      if (this.name === 'chats' && key === chatId) {
        request.addEventListener('success', () => {
          reset = storage.resetForAccountChange(false)
        })
      }
      return request
    })
    await expect(storage.getChat(chatId)).rejects.toThrow(
      'IndexedDB read superseded by account change',
    )
    expect(reset).toBeDefined()
    await reset
  })

  it('rejects a save whose database open finishes after the reset starts', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    vi.stubGlobal('IDBKeyRange', FakeIDBKeyRange)
    const storage = new IndexedDBStorage()
    const openDatabase = (storage as any).ensureDB.bind(storage)
    let parked!: () => void
    let release!: () => void
    const waiting = new Promise<void>((resolve) => (parked = resolve))
    const held = new Promise<void>((resolve) => (release = resolve))
    vi.spyOn(storage as any, 'ensureDB').mockImplementationOnce(async () => {
      parked()
      await held
      return openDatabase()
    })
    const save = storage.saveChat({
      id: 'old-account-chat',
      title: 'Old account chat',
      messages: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    await waiting

    await storage.resetForAccountChange(false)
    release()

    await expect(save).rejects.toThrow(
      'IndexedDB write superseded by account change',
    )
    expect(await new IndexedDBStorage().getAllChatIds()).toEqual([])
  })

  it('aborts a stalled reset transaction before rejecting', async () => {
    vi.useFakeTimers()
    const storage = new IndexedDBStorage()
    const { transaction } = prepareReset(storage)

    const reset = storage.resetForAccountChange()
    const rejection = expect(reset).rejects.toThrow(
      'Timed out resetting IndexedDB for account change',
    )

    await vi.runAllTimersAsync()

    await rejection
    expect(transaction.abort).toHaveBeenCalledTimes(1)
  })
})
