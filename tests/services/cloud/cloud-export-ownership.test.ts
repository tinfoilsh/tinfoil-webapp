import {
  AUTH_ACTIVE_USER_ID,
  SETTINGS_CLOUD_SYNC_ENABLED,
} from '@/constants/storage-keys'
import * as codec from '@/services/cloud/chat-codec'
import type { CloudStorageService } from '@/services/cloud/cloud-storage'
import {
  CloudSyncLifecycleCanceledError,
  CloudSyncService,
} from '@/services/cloud/cloud-sync'
import type { StoredChat } from '@/services/storage/indexed-db'
import { SyncRequestAbortedError } from '@/services/sync-enclave/sync-enclave-client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  auth: vi.fn<CloudStorageService['isAuthenticated']>(),
  list: vi.fn<CloudStorageService['listChats']>(),
  pull: vi.fn<CloudStorageService['downloadChats']>(),
  local: vi.fn<() => Promise<StoredChat[]>>(),
  clear: vi.fn<() => Promise<void>>(),
}))

vi.mock('@/services/cloud/cloud-storage', () => ({
  cloudStorage: {
    isAuthenticated: mocks.auth,
    listChats: mocks.list,
    downloadChats: mocks.pull,
  },
}))
vi.mock('@/services/storage/indexed-db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/storage/indexed-db')>()),
  indexedDBStorage: {
    getAllChats: mocks.local,
    clearRevisionSyncState: mocks.clear,
  },
}))
vi.mock('@/utils/error-handling', () => ({
  logError: vi.fn(),
  logWarning: vi.fn(),
  logInfo: vi.fn(),
}))

const OWNER_A = 'export-owner-a'
const OWNER_B = 'export-owner-b'
const CREATED_AT = '2026-01-01T00:00:00.000Z'
const remotePage = {
  conversations: [
    { id: 'private-a', syncVersion: 2, updatedAt: CREATED_AT, projectId: null },
  ],
  hasMore: false,
}
const pulledPage: Awaited<ReturnType<CloudStorageService['downloadChats']>> = [
  {
    id: 'private-a',
    status: 'ok',
    syncVersion: 2,
    content: JSON.stringify({
      title: 'Owner A confidential title',
      messages: [
        {
          role: 'user',
          content: 'Owner A confidential message',
          timestamp: CREATED_AT,
        },
      ],
      createdAt: CREATED_AT,
    }),
  },
]
const localChat: StoredChat = {
  id: 'local-a',
  title: 'Owner A offline chat',
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
  lastAccessedAt: 0,
  syncUserId: OWNER_A,
  messages: [
    {
      role: 'user',
      content: 'Offline message',
      timestamp: new Date(CREATED_AT),
    },
  ],
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function changeOwner(service: CloudSyncService, reset = true) {
  localStorage.setItem(AUTH_ACTIVE_USER_ID, OWNER_B)
  if (reset) service.resetForAccountChange()
}

describe('cloud export ownership', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    localStorage.setItem(AUTH_ACTIVE_USER_ID, OWNER_A)
    localStorage.setItem(SETTINGS_CLOUD_SYNC_ENABLED, 'true')
    mocks.auth.mockResolvedValue(true)
    mocks.list.mockResolvedValue(remotePage)
    mocks.pull.mockResolvedValue(pulledPage)
    mocks.local.mockResolvedValue([localChat])
    mocks.clear.mockResolvedValue(undefined)
  })
  afterEach(() => vi.restoreAllMocks())

  it('decodes a same-owner remote export with the real codec', async () => {
    const page = await new CloudSyncService().loadChatsWithPagination({
      limit: 5,
      loadLocal: false,
    })
    expect(page.chats).toMatchObject([
      {
        id: 'private-a',
        title: 'Owner A confidential title',
        syncVersion: 2,
        messages: [{ role: 'user', content: 'Owner A confidential message' }],
      },
    ])
    expect(page.hasMore).toBe(false)
    expect(mocks.local).not.toHaveBeenCalled()
  })

  it.each([
    { authenticated: true, loadLocal: true },
    { authenticated: false, loadLocal: true },
    { authenticated: false, loadLocal: false },
  ])(
    'rejects an owner change during auth ($authenticated, local $loadLocal)',
    async ({ authenticated, loadLocal }) => {
      const held = deferred<boolean>()
      mocks.auth.mockReturnValueOnce(held.promise)
      const service = new CloudSyncService()
      const pending = service.loadChatsWithPagination({ limit: 5, loadLocal })
      const rejected = expect(pending).rejects.toThrow('Cloud account changed')
      await vi.waitFor(() => expect(mocks.auth).toHaveBeenCalledOnce())
      changeOwner(service)
      held.resolve(authenticated)
      await rejected
      expect(mocks.list).not.toHaveBeenCalled()
      expect(mocks.local).not.toHaveBeenCalled()
    },
  )

  it.each([false, true])(
    'never pulls an old list under a new owner (reset: %s)',
    async (reset) => {
      const held = deferred<typeof remotePage>()
      mocks.list.mockReturnValueOnce(held.promise)
      const service = new CloudSyncService()
      const rejected = expect(
        service.loadChatsWithPagination({ limit: 5 }),
      ).rejects.toThrow('Cloud account changed')
      await vi.waitFor(() => expect(mocks.list).toHaveBeenCalledOnce())
      changeOwner(service, reset)
      held.resolve(remotePage)
      await rejected
      expect(mocks.pull).not.toHaveBeenCalled()
      expect(mocks.local).not.toHaveBeenCalled()
    },
  )

  it.each([false, true])(
    'discards held old-owner plaintext (reset: %s)',
    async (reset) => {
      const held = deferred<typeof pulledPage>()
      mocks.pull.mockReturnValueOnce(held.promise)
      const service = new CloudSyncService()
      const rejected = expect(
        service.loadChatsWithPagination({ limit: 5 }),
      ).rejects.toThrow('Cloud account changed')
      await vi.waitFor(() =>
        expect(mocks.pull).toHaveBeenCalledExactlyOnceWith(['private-a']),
      )
      changeOwner(service, reset)
      held.resolve(pulledPage)
      await rejected
      expect(mocks.local).not.toHaveBeenCalled()
    },
  )

  it.each(['resolve', 'reject'])(
    'rejects owner changes while decoded content settles (%s)',
    async (settlement) => {
      const held = deferred<void>()
      const entered = deferred<void>()
      const realDecode = codec.processRemoteChat
      vi.spyOn(codec, 'processRemoteChat').mockImplementationOnce(
        async (...args) => {
          const decoded = await realDecode(...args)
          entered.resolve()
          await held.promise
          return decoded
        },
      )
      const service = new CloudSyncService()
      const rejected = expect(
        service.loadChatsWithPagination({ limit: 5 }),
      ).rejects.toThrow('Cloud account changed')
      await entered.promise
      changeOwner(service)
      if (settlement === 'resolve') held.resolve()
      else held.reject(new Error('Decode interrupted'))
      await rejected
      expect(mocks.local).not.toHaveBeenCalled()
    },
  )

  it.each([false, true])(
    'preserves same-owner offline fallback (authenticated: %s)',
    async (authenticated) => {
      mocks.auth.mockResolvedValue(authenticated)
      mocks.list.mockRejectedValue(new Error('Network unavailable'))
      const newer: StoredChat = {
        ...localChat,
        id: 'newer-local-a',
        createdAt: '2026-02-01T00:00:00.000Z',
      }
      mocks.local.mockResolvedValue([localChat, newer])
      await expect(
        new CloudSyncService().loadChatsWithPagination({ limit: 1 }),
      ).resolves.toEqual({ chats: [newer], hasMore: true, nextToken: '1' })
      expect(mocks.local).toHaveBeenCalledOnce()
      expect(mocks.pull).not.toHaveBeenCalled()
    },
  )

  it.each([false, true])(
    'discards a held local fallback after owner change (authenticated: %s)',
    async (authenticated) => {
      mocks.auth.mockResolvedValue(authenticated)
      mocks.list.mockRejectedValue(new Error('Offline'))
      const held = deferred<StoredChat[]>()
      mocks.local.mockReturnValueOnce(held.promise)
      const service = new CloudSyncService()
      const rejected = expect(
        service.loadChatsWithPagination({ limit: 5 }),
      ).rejects.toThrow('Cloud account changed')
      await vi.waitFor(() => expect(mocks.local).toHaveBeenCalledOnce())
      changeOwner(service)
      held.resolve([localChat])
      await rejected
      expect(mocks.local).toHaveBeenCalledOnce()
    },
  )

  it.each([
    new SyncRequestAbortedError(),
    new CloudSyncLifecycleCanceledError('account-reset'),
    new DOMException('Canceled', 'AbortError'),
  ])(
    'does not turn cancellation into an offline export: $name',
    async (cancellation) => {
      mocks.list.mockRejectedValueOnce(cancellation)
      await expect(
        new CloudSyncService().loadChatsWithPagination({ limit: 5 }),
      ).rejects.toBe(cancellation)
      expect(mocks.local).not.toHaveBeenCalled()
    },
  )

  it('does not enter local fallback when a remote rejection follows account reset', async () => {
    const held = deferred<typeof remotePage>()
    mocks.list.mockReturnValueOnce(held.promise)
    const service = new CloudSyncService()
    const rejected = expect(
      service.loadChatsWithPagination({ limit: 5 }),
    ).rejects.toThrow('Cloud account changed')
    await vi.waitFor(() => expect(mocks.list).toHaveBeenCalledOnce())
    changeOwner(service)
    held.reject(new Error('Request interrupted'))
    await rejected
    expect(mocks.local).not.toHaveBeenCalled()
  })

  it('rejects an expired caller guard before authenticating another page', async () => {
    const service = new CloudSyncService()
    const guard = service.createAccountOperationGuard()
    await service.loadChatsWithPagination({ limit: 5 }, guard)
    mocks.auth.mockClear()
    mocks.list.mockClear()
    changeOwner(service)
    await expect(
      service.loadChatsWithPagination(
        { limit: 5, continuationToken: 'old-cursor' },
        guard,
      ),
    ).rejects.toThrow('Cloud account changed')
    expect(mocks.auth).not.toHaveBeenCalled()
    expect(mocks.list).not.toHaveBeenCalled()
  })
})
