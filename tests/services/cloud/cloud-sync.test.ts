import { PAGINATION } from '@/config'
import {
  AUTH_ACTIVE_USER_ID,
  SETTINGS_CLOUD_SYNC_ENABLED,
} from '@/constants/storage-keys'
import {
  CloudSyncService,
  CROSS_TAB_SYNC_LOCK,
  CROSS_TAB_SYNC_LOCK_OPTIONS,
} from '@/services/cloud/cloud-sync'
import { chatEvents } from '@/services/storage/chat-events'
import { SyncEnclaveError } from '@/services/sync-enclave/sync-enclave-client'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  drainChatRevisionSync,
  isAuthenticated,
  clearRevisionSyncState,
  getChat,
  canWriteToCloud,
  uploadChat,
  downloadChat,
  downloadChats,
  forkCloudChat,
  finalizeUpload,
  getPendingUploadChats,
  applyRemoteChatIfFresh,
  listChats,
  processRemoteChat,
  getAllChats,
  deleteStoredChat,
  clearRevisionCheckpoint,
  reportKeyActionRequired,
  reportChatSyncFailed,
} = vi.hoisted(() => ({
  drainChatRevisionSync: vi.fn(),
  isAuthenticated: vi.fn(),
  clearRevisionSyncState: vi.fn(),
  getChat: vi.fn(),
  canWriteToCloud: vi.fn(),
  uploadChat: vi.fn(),
  downloadChat: vi.fn(),
  downloadChats: vi.fn(),
  forkCloudChat: vi.fn(),
  finalizeUpload: vi.fn(),
  getPendingUploadChats: vi.fn(),
  applyRemoteChatIfFresh: vi.fn(),
  listChats: vi.fn(),
  processRemoteChat: vi.fn(),
  getAllChats: vi.fn(),
  deleteStoredChat: vi.fn(),
  clearRevisionCheckpoint: vi.fn(),
  reportKeyActionRequired: vi.fn(),
  reportChatSyncFailed: vi.fn(),
}))

vi.mock('@/services/cloud/chat-revision-sync', () => ({
  BOOTSTRAP_RECENT_CONTENT_LIMIT: 50,
  drainChatRevisionSync,
}))
vi.mock('@/services/cloud/cloud-storage', () => ({
  cloudStorage: {
    isAuthenticated,
    uploadChat,
    downloadChat,
    downloadChats,
    forkChat: forkCloudChat,
    listChats,
  },
}))
vi.mock('@/services/storage/indexed-db', () => ({
  chatContentFingerprint: vi.fn(() => 'content-fingerprint'),
  indexedDBStorage: {
    clearRevisionSyncState,
    getChat,
    finalizeUpload,
    getPendingUploadChats,
    applyRemoteChatIfFresh,
    getAllChats,
    deleteChat: deleteStoredChat,
    clearRevisionCheckpoint,
  },
}))
vi.mock('@/services/cloud/cloud-key-authorization', () => ({
  canWriteToCloud,
}))
vi.mock('@/services/cloud/ensure-current-key', () => ({
  adoptLocalKeyForMigration: vi.fn(),
}))
vi.mock('@/services/cloud/chat-codec', () => ({ processRemoteChat }))
vi.mock('@/services/storage/deleted-chats-tracker', () => ({
  deletedChatsTracker: {
    isDeleted: vi.fn(() => false),
    removeLocalDeletion: vi.fn(),
  },
}))
vi.mock('@/services/cloud/streaming-tracker', () => ({
  streamingTracker: {
    isStreaming: vi.fn(() => false),
    onStreamEnd: vi.fn(),
  },
}))
vi.mock('@/services/cloud/sync-health', () => ({
  reportChatSynced: vi.fn(),
  reportChatSyncFailed,
  reportChatSyncRecovered: vi.fn(),
  reportKeyActionRequired,
  reportSyncPaused: vi.fn(),
}))
vi.mock('@/utils/error-handling', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarning: vi.fn(),
}))

describe('CloudSyncService revision coordinator routing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: {
        request: vi.fn(async (...args: unknown[]) => {
          const operation = args[2] as () => Promise<unknown>
          return operation()
        }),
      },
    })
    localStorage.setItem(AUTH_ACTIVE_USER_ID, 'user-1')
    localStorage.setItem(SETTINGS_CLOUD_SYNC_ENABLED, 'true')
    isAuthenticated.mockResolvedValue(true)
    clearRevisionSyncState.mockResolvedValue(undefined)
    canWriteToCloud.mockResolvedValue(false)
    finalizeUpload.mockResolvedValue(undefined)
    getPendingUploadChats.mockResolvedValue([])
    applyRemoteChatIfFresh.mockResolvedValue({ applied: true })
    getAllChats.mockResolvedValue([])
    deleteStoredChat.mockResolvedValue(undefined)
    clearRevisionCheckpoint.mockResolvedValue(undefined)
    drainChatRevisionSync.mockResolvedValue({
      uploaded: 1,
      downloaded: 2,
      errors: [],
    })
  })

  it('routes smart sync through the account-wide coordinator', async () => {
    const result = await new CloudSyncService().smartSync('project-1')

    expect(result).toEqual({ uploaded: 1, downloaded: 2, errors: [] })
    expect(navigator.locks.request).toHaveBeenCalledWith(
      CROSS_TAB_SYNC_LOCK,
      expect.objectContaining(CROSS_TAB_SYNC_LOCK_OPTIONS),
      expect.any(Function),
    )
    expect(drainChatRevisionSync).toHaveBeenCalledTimes(1)
    expect(drainChatRevisionSync.mock.calls[0][1]).toBe('user-1')
  })

  it('fails closed when authenticated account identity is unavailable', async () => {
    localStorage.removeItem(AUTH_ACTIVE_USER_ID)

    await expect(new CloudSyncService().smartSync()).rejects.toThrow(
      'Authenticated user ID is unavailable',
    )
    expect(drainChatRevisionSync).not.toHaveBeenCalled()
  })

  it('does not contact the coordinator while unauthenticated', async () => {
    isAuthenticated.mockResolvedValue(false)

    await expect(new CloudSyncService().smartSync()).resolves.toEqual({
      uploaded: 0,
      downloaded: 0,
      errors: [],
    })
    expect(drainChatRevisionSync).not.toHaveBeenCalled()
  })

  it('clears durable revision state on account change', () => {
    const service = new CloudSyncService()
    service.resetForAccountChange()

    expect(clearRevisionSyncState).toHaveBeenCalledTimes(1)
  })

  it('expires an account operation across an A-to-B-to-A transition', () => {
    const service = new CloudSyncService()
    const guard = service.createAccountOperationGuard()

    localStorage.setItem(AUTH_ACTIVE_USER_ID, 'user-2')
    service.resetForAccountChange()
    localStorage.setItem(AUTH_ACTIVE_USER_ID, 'user-1')
    service.resetForAccountChange()

    expect(guard.isCurrent()).toBe(false)
    expect(guard.assertCurrent).toThrow('Cloud account changed')
  })

  it.each(['queued', 'direct'])(
    'notifies the UI after a %s upload has finalized its sync metadata',
    async (mode) => {
      vi.useFakeTimers()
      const notify = vi.fn()
      const unsubscribe = chatEvents.on(notify)
      try {
        canWriteToCloud.mockResolvedValue(true)
        const chat = {
          id: 'chat-1',
          syncUserId: 'user-1',
          title: 'New chat',
          locallyModified: true,
          pendingUpload: 1,
          syncedAt: 0,
          syncVersion: 0,
          updatedAt: '2026-01-01T00:00:00Z',
          messages: [{ role: 'user', content: 'Hello' }],
        }
        getChat.mockResolvedValue(chat)
        uploadChat.mockResolvedValue({
          syncVersion: 1,
          rewrites: [],
          projectIntentIncluded: false,
        })
        finalizeUpload.mockImplementation(async () => {
          chat.locallyModified = false
          chat.pendingUpload = 0
          chat.syncedAt = Date.now()
          chat.syncVersion = 1
        })
        const service = new CloudSyncService()
        const pending = Promise.allSettled([
          mode === 'queued'
            ? service.backupChatAndWait(chat.id)
            : service.backupChatNow(chat.id),
        ])
        await vi.runAllTimersAsync()
        expect(await pending).toEqual([
          { status: 'fulfilled', value: undefined },
        ])
        expect(chat.syncedAt).toBeGreaterThan(0)
        expect(notify).toHaveBeenCalledExactlyOnceWith({
          reason: 'sync',
          ids: [],
        })
      } finally {
        unsubscribe()
        vi.useRealTimers()
      }
    },
  )

  it('holds project deletion until an existing direct upload finishes', async () => {
    canWriteToCloud.mockResolvedValue(true)
    const chat = {
      id: 'chat-1',
      projectId: 'project-1',
      syncUserId: 'user-1',
      locallyModified: true,
      updatedAt: '2026-01-01T00:00:00Z',
      messages: [{ role: 'user', content: 'hello' }],
    }
    getChat.mockResolvedValue(chat)
    let finishUpload!: () => void
    uploadChat.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishUpload = () =>
            resolve({
              syncVersion: 1,
              rewrites: [],
              projectIntentIncluded: true,
            })
        }),
    )
    const service = new CloudSyncService()
    const upload = service.backupChatNow('chat-1')
    await vi.waitFor(() => expect(uploadChat).toHaveBeenCalledOnce())

    const deletion = vi.fn(async () => {})
    const barrier = service.withProjectUploadBarrier('project-1', deletion)
    await Promise.resolve()
    expect(deletion).not.toHaveBeenCalled()

    finishUpload()
    await upload
    await barrier
    expect(deletion).toHaveBeenCalledOnce()
  })

  it('blocks queued project upload preparation during deletion', async () => {
    canWriteToCloud.mockResolvedValue(true)
    const chat = {
      id: 'chat-1',
      projectId: 'project-1',
      syncUserId: 'user-1',
      locallyModified: true,
      updatedAt: '2026-01-01T00:00:00Z',
      messages: [{ role: 'user', content: 'hello' }],
    }
    getChat.mockResolvedValue(chat)
    let finishDeletion!: () => void
    const service = new CloudSyncService()
    const barrier = service.withProjectUploadBarrier(
      'project-1',
      () =>
        new Promise<void>((resolve) => {
          finishDeletion = resolve
        }),
    )
    await vi.waitFor(() => expect(finishDeletion).toBeTypeOf('function'))

    await service.backupChat('chat-1')
    await Promise.resolve()
    expect(uploadChat).not.toHaveBeenCalled()
    getChat.mockResolvedValue(null)
    finishDeletion()
    await barrier
    await service.waitForAllUploads()

    expect(uploadChat).not.toHaveBeenCalled()
  })

  it('waits for an old coordinator before clearing its checkpoint', async () => {
    let finishSync!: () => void
    drainChatRevisionSync.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishSync = () => resolve({ uploaded: 0, downloaded: 0, errors: [] })
        }),
    )
    const service = new CloudSyncService()
    const sync = service.smartSync()
    await vi.waitFor(() => expect(drainChatRevisionSync).toHaveBeenCalled())

    const clear = service.clearSyncStatus()
    expect(clearRevisionSyncState).not.toHaveBeenCalled()
    finishSync()
    await sync.catch(() => undefined)
    await clear

    expect(clearRevisionSyncState).toHaveBeenCalledTimes(1)
  })

  it('does not enqueue a prior-account chat for upload', async () => {
    canWriteToCloud.mockResolvedValue(true)
    getChat.mockResolvedValue({
      id: 'old-chat',
      syncUserId: 'user-0',
      locallyModified: true,
      messages: [{ role: 'user', content: 'old' }],
    })
    const service = new CloudSyncService()

    await service.backupChat('old-chat')
    await service.waitForAllUploads()

    expect(uploadChat).not.toHaveBeenCalled()
  })

  it('aborts an upload when the active account changes before finalization', async () => {
    canWriteToCloud.mockResolvedValue(true)
    getChat.mockResolvedValue({
      id: 'chat-1',
      syncUserId: 'user-1',
      locallyModified: true,
      pendingUpload: 1,
      updatedAt: '2026-01-01T00:00:00Z',
      messages: [{ role: 'user', content: 'hello' }],
    })
    uploadChat.mockImplementationOnce(async () => {
      localStorage.setItem(AUTH_ACTIVE_USER_ID, 'user-2')
      return { syncVersion: 2, rewrites: [], projectIntentIncluded: false }
    })

    await expect(
      new CloudSyncService().backupChatNow('chat-1'),
    ).rejects.toThrow('Cloud account changed during synchronization')
    expect(finalizeUpload).not.toHaveBeenCalled()
  })

  it('counts an unsynced upload only after its clean state is observed', async () => {
    canWriteToCloud.mockResolvedValue(true)
    const pendingChat = {
      id: 'chat-1',
      syncUserId: 'user-1',
      locallyModified: true,
      pendingUpload: 1,
      updatedAt: '2026-01-01T00:00:00Z',
      messages: [{ role: 'user', content: 'hello' }],
    }
    getPendingUploadChats.mockResolvedValue([pendingChat])
    getChat
      .mockResolvedValueOnce(pendingChat)
      .mockResolvedValueOnce({ ...pendingChat, pendingUpload: 0 })
      .mockResolvedValueOnce(pendingChat)
    uploadChat.mockResolvedValue({
      syncVersion: 2,
      rewrites: [],
      projectIntentIncluded: false,
    })

    await expect(new CloudSyncService().backupUnsyncedChats()).resolves.toEqual(
      {
        uploaded: 0,
        downloaded: 0,
        errors: [expect.stringContaining('Chat upload did not finalize')],
      },
    )
  })

  it('resolves an upload conflict by applying the winning remote chat', async () => {
    canWriteToCloud.mockResolvedValue(true)
    const local = {
      id: 'chat-1',
      syncUserId: 'user-1',
      locallyModified: true,
      pendingUpload: 1,
      syncVersion: 1,
      clock: 1,
      writer: 'device-a',
      clockVersion: 1,
      updatedAt: '2026-01-01T00:00:00Z',
      messages: [{ role: 'user', content: 'local' }],
    }
    const remote = {
      ...local,
      locallyModified: false,
      pendingUpload: 0,
      syncVersion: 2,
      clock: 2,
      writer: 'device-b',
      clockVersion: 2,
      updatedAt: '2026-01-02T00:00:00Z',
    }
    getChat.mockResolvedValue(local)
    uploadChat.mockRejectedValueOnce(
      new SyncEnclaveError('conflict', 409, 'SYNC_CONFLICT'),
    )
    downloadChat.mockResolvedValue(remote)

    const service = new CloudSyncService()
    await service.backupChat('chat-1')
    await service.waitForAllUploads()

    expect(applyRemoteChatIfFresh).toHaveBeenCalledWith(
      expect.objectContaining({
        chat: remote,
        syncVersion: 2,
        allowLocallyModified: true,
      }),
    )
  })

  it('prevents a pagination write after the active account changes', async () => {
    listChats.mockResolvedValue({
      conversations: [{ id: 'chat-1', syncVersion: 1, updatedAt: '' }],
      hasMore: false,
    })
    downloadChats.mockResolvedValue([
      { status: 'ok', id: 'chat-1', syncVersion: 1, content: '{}' },
    ])
    processRemoteChat.mockImplementationOnce(async () => {
      localStorage.setItem(AUTH_ACTIVE_USER_ID, 'user-2')
      return { chat: { id: 'chat-1', messages: [] } }
    })

    await expect(
      new CloudSyncService().fetchAndStorePage({ limit: 10 }),
    ).rejects.toThrow('Cloud account changed during synchronization')
    expect(applyRemoteChatIfFresh).not.toHaveBeenCalled()
  })

  it('initializes pagination metadata at the hydration boundary', async () => {
    const conversations = Array.from({ length: 50 }, (_, index) => ({
      id: `chat-${index}`,
      syncVersion: index + 1,
      updatedAt: `2026-01-${String(index + 1).padStart(2, '0')}T00:00:00Z`,
    }))
    listChats
      .mockResolvedValueOnce({
        conversations,
        hasMore: true,
        nextContinuationToken: 'page-2',
      })
      .mockResolvedValueOnce({
        conversations: [
          {
            id: 'uncached-chat',
            syncVersion: 51,
            updatedAt: '2025-12-31T00:00:00Z',
          },
        ],
        hasMore: false,
      })
    getChat.mockImplementation(async (id: string) => {
      const entry = conversations.find((chat) => chat.id === id)!
      return {
        ...entry,
        syncUserId: 'user-1',
        messages: [],
      }
    })

    await expect(
      new CloudSyncService().initializeChatPaginationCursor(),
    ).resolves.toEqual({ hasMore: true, nextToken: 'page-2' })
    expect(listChats).toHaveBeenCalledWith({
      limit: 50,
      continuationToken: undefined,
    })
    expect(downloadChats).not.toHaveBeenCalled()
    expect(processRemoteChat).not.toHaveBeenCalled()
  })

  it('hydrates missing and stale chats before returning the boundary cursor', async () => {
    const metadata = [
      {
        id: 'current-chat',
        syncVersion: 1,
        updatedAt: '2026-01-03T00:00:00Z',
      },
      {
        id: 'missing-chat',
        syncVersion: 2,
        updatedAt: '2026-01-02T00:00:00Z',
      },
      {
        id: 'stale-chat',
        syncVersion: 3,
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ]
    const localChats = new Map<string, Record<string, unknown>>([
      ['current-chat', { ...metadata[0], syncUserId: 'user-1', messages: [] }],
      [
        'stale-chat',
        { ...metadata[2], syncVersion: 2, syncUserId: 'user-1', messages: [] },
      ],
    ])
    listChats
      .mockResolvedValueOnce({
        conversations: metadata,
        hasMore: true,
        nextContinuationToken: 'page-2',
      })
      .mockResolvedValueOnce({
        conversations: [
          {
            id: 'uncached-chat',
            syncVersion: 4,
            updatedAt: '2025-12-31T00:00:00Z',
          },
        ],
        hasMore: false,
      })
    downloadChats.mockResolvedValue([
      { status: 'ok', ...metadata[1], content: '{"id":"missing-chat"}' },
      { status: 'ok', ...metadata[2], content: '{"id":"stale-chat"}' },
    ])
    getChat.mockImplementation(async (id: string) => localChats.get(id))
    processRemoteChat.mockImplementation(async ({ id, syncVersion }) => ({
      chat: { id, syncVersion, syncUserId: 'user-1', messages: [] },
    }))
    applyRemoteChatIfFresh.mockImplementation(async ({ chat }) => {
      localChats.set(chat.id, chat)
      return { applied: true }
    })

    await expect(
      new CloudSyncService().initializeChatPaginationCursor(),
    ).resolves.toEqual({ hasMore: true, nextToken: 'page-2' })
    expect(downloadChats).toHaveBeenCalledWith(['missing-chat', 'stale-chat'])
    expect(processRemoteChat).toHaveBeenCalledTimes(2)
  })

  it('skips fully cached metadata pages before fetching unseen history', async () => {
    const cachedChats = new Map<string, Record<string, unknown>>()
    const boundary = Array.from({ length: 50 }, (_, index) => ({
      id: `boundary-${index}`,
      syncVersion: index + 1,
      updatedAt: `2026-01-${String(index + 1).padStart(2, '0')}T00:00:00Z`,
    }))
    const cachedPage = Array.from({ length: 20 }, (_, index) => ({
      id: `cached-history-${index}`,
      syncVersion: index + 51,
      updatedAt: `2025-12-${String(index + 1).padStart(2, '0')}T00:00:00Z`,
    }))
    for (const entry of [...boundary, ...cachedPage]) {
      cachedChats.set(entry.id, {
        ...entry,
        syncUserId: 'user-1',
        messages: [],
      })
    }
    const unseen = {
      id: 'first-unseen-chat',
      syncVersion: 71,
      updatedAt: '2025-11-30T00:00:00Z',
    }
    listChats
      .mockResolvedValueOnce({
        conversations: boundary,
        hasMore: true,
        nextContinuationToken: 'cached-page',
      })
      .mockResolvedValueOnce({
        conversations: cachedPage,
        hasMore: true,
        nextContinuationToken: 'unseen-page',
      })
      .mockResolvedValueOnce({
        conversations: [unseen],
        hasMore: false,
      })
      .mockResolvedValueOnce({
        conversations: [unseen],
        hasMore: false,
      })
    downloadChats.mockResolvedValue([
      { status: 'ok', ...unseen, content: '{}' },
    ])
    getChat.mockImplementation(async (id: string) => cachedChats.get(id))
    processRemoteChat.mockResolvedValue({
      chat: { ...unseen, syncUserId: 'user-1', messages: [] },
    })

    const service = new CloudSyncService()
    await expect(service.initializeChatPaginationCursor()).resolves.toEqual({
      hasMore: true,
      nextToken: 'unseen-page',
    })
    await expect(
      service.fetchAndStorePage({
        limit: 20,
        continuationToken: 'unseen-page',
      }),
    ).resolves.toEqual({
      hasMore: false,
      nextToken: undefined,
      saved: 1,
      unavailable: [],
    })

    expect(downloadChats).toHaveBeenCalledTimes(1)
    expect(downloadChats).toHaveBeenCalledWith([unseen.id])
    expect(listChats).toHaveBeenNthCalledWith(2, {
      limit: PAGINATION.CURSOR_SCAN_PAGE_SIZE,
      continuationToken: 'cached-page',
    })
    expect(listChats).toHaveBeenNthCalledWith(3, {
      limit: PAGINATION.CURSOR_SCAN_PAGE_SIZE,
      continuationToken: 'unseen-page',
    })
    expect(listChats).toHaveBeenNthCalledWith(4, {
      limit: 20,
      continuationToken: 'unseen-page',
    })
  })

  it('skips metadata pages that carry only deletions', async () => {
    const chat = {
      id: 'older-chat',
      syncVersion: 3,
      updatedAt: '2026-01-01T00:00:00Z',
      projectId: null,
    }
    listChats
      .mockResolvedValueOnce({
        conversations: [],
        hasMore: true,
        nextContinuationToken: 'tombstones-2',
      })
      .mockResolvedValueOnce({
        conversations: [],
        hasMore: true,
        nextContinuationToken: 'tombstones-3',
      })
      .mockResolvedValueOnce({
        conversations: [chat],
        hasMore: false,
      })
    downloadChats.mockResolvedValue([{ status: 'ok', ...chat, content: '{}' }])
    processRemoteChat.mockResolvedValue({
      chat: { ...chat, syncUserId: 'user-1', messages: [] },
    })
    getChat.mockResolvedValue(undefined)

    await expect(
      new CloudSyncService().fetchAndStorePage({
        limit: 20,
        continuationToken: 'tombstones-1',
      }),
    ).resolves.toEqual({
      hasMore: false,
      nextToken: undefined,
      saved: 1,
      unavailable: [],
    })
    expect(listChats).toHaveBeenCalledTimes(3)
    expect(listChats).toHaveBeenNthCalledWith(3, {
      limit: 20,
      continuationToken: 'tombstones-3',
    })
    expect(processRemoteChat).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'older-chat' }),
      expect.objectContaining({ projectId: null }),
    )
  })

  it('rejects a non-advancing metadata cursor', async () => {
    const boundary = [
      {
        id: 'boundary-chat',
        syncVersion: 1,
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ]
    listChats
      .mockResolvedValueOnce({
        conversations: boundary,
        hasMore: true,
        nextContinuationToken: 'repeated-page',
      })
      .mockResolvedValue({
        conversations: [],
        hasMore: true,
        nextContinuationToken: 'repeated-page',
      })
    getChat.mockImplementation(async () => ({
      ...boundary[0],
      syncUserId: 'user-1',
      messages: [],
    }))

    await expect(
      new CloudSyncService().initializeChatPaginationCursor(),
    ).rejects.toThrow('Cloud pagination cursor did not advance')
    expect(listChats).toHaveBeenCalledTimes(2)
  })

  it('rejects a cursor cycle that spans cached metadata pages', async () => {
    const cached = new Map<string, Record<string, unknown>>()
    const page = (id: string) => ({
      id,
      syncVersion: 1,
      updatedAt: '2026-01-01T00:00:00Z',
    })
    for (const id of ['boundary-chat', 'cached-a', 'cached-b']) {
      cached.set(id, { ...page(id), syncUserId: 'user-1', messages: [] })
    }
    listChats
      .mockResolvedValueOnce({
        conversations: [page('boundary-chat')],
        hasMore: true,
        nextContinuationToken: 'page-a',
      })
      .mockResolvedValueOnce({
        conversations: [page('cached-a')],
        hasMore: true,
        nextContinuationToken: 'page-b',
      })
      .mockResolvedValueOnce({
        conversations: [page('cached-b')],
        hasMore: true,
        nextContinuationToken: 'page-a',
      })
    getChat.mockImplementation(async (id: string) => cached.get(id))

    await expect(
      new CloudSyncService().initializeChatPaginationCursor(),
    ).rejects.toThrow('Cloud pagination cursor did not advance')
    expect(listChats).toHaveBeenCalledTimes(3)
  })

  it('withholds a cursor when a boundary mutation is not fully stored', async () => {
    listChats.mockResolvedValue({
      conversations: [
        {
          id: 'new-boundary-chat',
          syncVersion: 2,
          updatedAt: '2026-01-02T00:00:00Z',
        },
      ],
      hasMore: true,
      nextContinuationToken: 'page-2',
    })
    getChat.mockResolvedValue(undefined)
    downloadChats.mockResolvedValue([
      { status: 'ok', id: 'new-boundary-chat', syncVersion: 2, content: '{}' },
    ])
    processRemoteChat.mockResolvedValue({
      chat: { id: 'new-boundary-chat', syncVersion: 2, messages: [] },
    })
    applyRemoteChatIfFresh.mockResolvedValue({ applied: false })

    await expect(
      new CloudSyncService().initializeChatPaginationCursor(),
    ).rejects.toMatchObject({
      code: 'REMOTE_CHAT_PAGE_INCOMPLETE',
      chatId: 'new-boundary-chat',
      stage: 'boundary',
    })
  })

  it('rejects a pagination cursor from a previous account', async () => {
    listChats.mockImplementationOnce(async () => {
      localStorage.setItem(AUTH_ACTIVE_USER_ID, 'user-2')
      return {
        conversations: [],
        hasMore: true,
        nextContinuationToken: 'stale-page-2',
      }
    })

    await expect(
      new CloudSyncService().initializeChatPaginationCursor(),
    ).rejects.toThrow('Cloud account changed during synchronization')
  })

  it('keeps paginating past chats the enclave cannot return', async () => {
    listChats.mockResolvedValue({
      conversations: [
        {
          id: 'gone-chat',
          syncVersion: 1,
          updatedAt: '2026-01-03T00:00:00Z',
        },
        {
          id: 'locked-chat',
          syncVersion: 2,
          updatedAt: '2026-01-02T00:00:00Z',
        },
        {
          id: 'readable-chat',
          syncVersion: 3,
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ],
      hasMore: true,
      nextContinuationToken: 'page-3',
    })
    downloadChats.mockResolvedValue([
      { status: 'unavailable', id: 'gone-chat', code: 'NOT_FOUND' },
      { status: 'unavailable', id: 'locked-chat', code: 'UNKNOWN_KEY' },
      { status: 'ok', id: 'readable-chat', syncVersion: 3, content: '{}' },
    ])
    processRemoteChat.mockResolvedValue({
      chat: { id: 'readable-chat', syncVersion: 3, messages: [] },
    })
    getChat.mockResolvedValue(undefined)

    await expect(
      new CloudSyncService().fetchAndStorePage({
        limit: 20,
        continuationToken: 'page-2',
      }),
    ).resolves.toEqual({
      hasMore: true,
      nextToken: 'page-3',
      saved: 1,
      unavailable: [
        { id: 'gone-chat', code: 'NOT_FOUND' },
        { id: 'locked-chat', code: 'UNKNOWN_KEY' },
      ],
    })
    expect(applyRemoteChatIfFresh).toHaveBeenCalledOnce()
    expect(reportKeyActionRequired).toHaveBeenCalledWith('key-recovery')
  })

  it('does not block the boundary on a chat the enclave cannot return', async () => {
    const readable = {
      id: 'readable-chat',
      syncVersion: 1,
      updatedAt: '2026-01-02T00:00:00Z',
    }
    listChats
      .mockResolvedValueOnce({
        conversations: [
          readable,
          {
            id: 'locked-chat',
            syncVersion: 2,
            updatedAt: '2026-01-01T00:00:00Z',
          },
        ],
        hasMore: true,
        nextContinuationToken: 'page-2',
      })
      .mockResolvedValueOnce({
        conversations: [
          {
            id: 'uncached-chat',
            syncVersion: 3,
            updatedAt: '2025-12-31T00:00:00Z',
          },
        ],
        hasMore: false,
      })
    const localChats = new Map<string, Record<string, unknown>>()
    getChat.mockImplementation(async (id: string) => localChats.get(id))
    downloadChats.mockResolvedValue([
      { status: 'ok', ...readable, content: '{}' },
      { status: 'unavailable', id: 'locked-chat', code: 'UNKNOWN_KEY' },
    ])
    processRemoteChat.mockResolvedValue({
      chat: { ...readable, syncUserId: 'user-1', messages: [] },
    })
    applyRemoteChatIfFresh.mockImplementation(async ({ chat }) => {
      localChats.set(chat.id, chat)
      return { applied: true }
    })

    await expect(
      new CloudSyncService().initializeChatPaginationCursor(),
    ).resolves.toEqual({ hasMore: true, nextToken: 'page-2' })
  })

  it('keeps paginating after an invalid chat fails to decode', async () => {
    listChats.mockResolvedValue({
      conversations: [
        {
          id: 'invalid-chat',
          syncVersion: 2,
          updatedAt: '2026-01-02T00:00:00Z',
        },
        {
          id: 'readable-chat',
          syncVersion: 3,
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ],
      hasMore: true,
      nextContinuationToken: 'page-3',
    })
    downloadChats.mockResolvedValue([
      { status: 'ok', id: 'invalid-chat', syncVersion: 2, content: 'invalid' },
      { status: 'ok', id: 'readable-chat', syncVersion: 3, content: '{}' },
    ])
    processRemoteChat
      .mockRejectedValueOnce(new Error('invalid chat'))
      .mockResolvedValueOnce({
        chat: { id: 'readable-chat', syncVersion: 3, messages: [] },
      })
    getChat.mockResolvedValue(undefined)

    await expect(
      new CloudSyncService().fetchAndStorePage({
        limit: 20,
        continuationToken: 'page-2',
      }),
    ).resolves.toEqual({
      hasMore: true,
      nextToken: 'page-3',
      saved: 1,
      unavailable: [],
    })
    expect(reportChatSyncFailed).toHaveBeenCalledWith(
      'invalid-chat',
      "This chat couldn't be read",
    )
  })

  it('does not block the pagination boundary on an invalid chat', async () => {
    listChats
      .mockResolvedValueOnce({
        conversations: [
          {
            id: 'invalid-chat',
            syncVersion: 2,
            updatedAt: '2026-01-02T00:00:00Z',
          },
        ],
        hasMore: true,
        nextContinuationToken: 'page-2',
      })
      .mockResolvedValueOnce({
        conversations: [
          {
            id: 'uncached-chat',
            syncVersion: 3,
            updatedAt: '2026-01-01T00:00:00Z',
          },
        ],
        hasMore: false,
      })
    getChat.mockResolvedValue(undefined)
    downloadChats.mockResolvedValue([
      { status: 'ok', id: 'invalid-chat', syncVersion: 2, content: 'invalid' },
    ])
    processRemoteChat.mockRejectedValue(new Error('invalid chat'))

    await expect(
      new CloudSyncService().initializeChatPaginationCursor(),
    ).resolves.toEqual({ hasMore: true, nextToken: 'page-2' })
  })

  it('retains the page cursor for retry when storage fails', async () => {
    listChats.mockResolvedValue({
      conversations: [
        {
          id: 'chat-1',
          syncVersion: 2,
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ],
      hasMore: false,
    })
    downloadChats.mockResolvedValue([
      { status: 'ok', id: 'chat-1', syncVersion: 2, content: '{}' },
    ])
    processRemoteChat.mockResolvedValue({
      chat: { id: 'chat-1', syncVersion: 2, messages: [] },
    })
    getChat.mockResolvedValue(undefined)
    applyRemoteChatIfFresh
      .mockRejectedValueOnce(new Error('storage failed'))
      .mockResolvedValueOnce({ applied: true })

    const service = new CloudSyncService()
    await expect(
      service.fetchAndStorePage({
        limit: 20,
        continuationToken: 'page-2',
      }),
    ).rejects.toMatchObject({
      code: 'REMOTE_CHAT_PAGE_INCOMPLETE',
      chatId: 'chat-1',
      stage: 'storage',
    })
    await expect(
      service.fetchAndStorePage({
        limit: 20,
        continuationToken: 'page-2',
      }),
    ).resolves.toEqual({
      hasMore: false,
      nextToken: undefined,
      saved: 1,
      unavailable: [],
    })
    expect(listChats).toHaveBeenCalledTimes(2)
    expect(listChats).toHaveBeenNthCalledWith(2, {
      limit: 20,
      continuationToken: 'page-2',
    })
  })

  it('rejects an incomplete export page instead of falling back locally', async () => {
    listChats.mockResolvedValue({
      conversations: [{ id: 'corrupt-chat', syncVersion: 1, updatedAt: '' }],
      hasMore: false,
    })
    downloadChats.mockResolvedValue([
      { status: 'ok', id: 'corrupt-chat', syncVersion: 1, content: '{}' },
    ])
    processRemoteChat.mockRejectedValueOnce(new Error('invalid ciphertext'))

    await expect(
      new CloudSyncService().loadChatsWithPagination({
        limit: 10,
        loadLocal: true,
      }),
    ).rejects.toThrow('Remote chat page is incomplete')
    expect(getAllChats).not.toHaveBeenCalled()
  })

  it('passes list metadata into chats decoded for export', async () => {
    listChats.mockResolvedValue({
      conversations: [
        {
          id: 'imported-chat',
          syncVersion: 1,
          updatedAt: '2026-01-02T00:00:00Z',
          projectId: 'project-1',
        },
      ],
      hasMore: false,
    })
    downloadChats.mockResolvedValue([
      { status: 'ok', id: 'imported-chat', syncVersion: 1, content: '{}' },
    ])
    processRemoteChat.mockResolvedValueOnce({
      chat: { id: 'imported-chat', syncVersion: 1, messages: [] },
    })

    await new CloudSyncService().loadChatsWithPagination({ limit: 10 })

    expect(processRemoteChat).toHaveBeenCalledWith(
      {
        id: 'imported-chat',
        plaintext: '{}',
        syncVersion: 1,
        formatVersion: 2,
        updatedAt: '2026-01-02T00:00:00Z',
      },
      { projectId: 'project-1' },
    )
  })

  it('continues decryption recovery after an individual eviction fails', async () => {
    getAllChats
      .mockResolvedValueOnce([
        { id: 'failed-1', decryptionFailed: true },
        { id: 'failed-2', decryptionFailed: true },
      ])
      .mockResolvedValueOnce([])
    deleteStoredChat
      .mockRejectedValueOnce(new Error('storage unavailable'))
      .mockResolvedValueOnce(undefined)

    await expect(
      new CloudSyncService().retryDecryptionWithNewKey(),
    ).resolves.toBe(2)
    expect(clearRevisionCheckpoint).toHaveBeenCalledOnce()
    expect(drainChatRevisionSync).toHaveBeenCalledOnce()
  })
})

describe('CloudSyncService forkChat', () => {
  const syncedSource = {
    id: 'chat-source',
    syncUserId: 'user-1',
    title: 'Trip planning',
    locallyModified: false,
    syncedAt: 10,
    syncVersion: 3,
    updatedAt: '2026-01-01T00:00:00Z',
    messages: [
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'two' },
    ],
  }
  const remoteFork = {
    ...syncedSource,
    id: 'chat-fork',
    title: 'Trip planning (fork)',
    syncVersion: 1,
    messages: syncedSource.messages.slice(0, 1),
  }

  const forkSource = () =>
    new CloudSyncService().forkChat({
      sourceId: 'chat-source',
      targetId: 'chat-fork',
      messageCount: 1,
      title: 'Trip planning (fork)',
    })

  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.setItem(AUTH_ACTIVE_USER_ID, 'user-1')
    localStorage.setItem(SETTINGS_CLOUD_SYNC_ENABLED, 'true')
    isAuthenticated.mockResolvedValue(true)
    canWriteToCloud.mockResolvedValue(true)
    getChat.mockResolvedValue(syncedSource)
    forkCloudChat.mockResolvedValue({ syncVersion: 1 })
    downloadChat.mockResolvedValue(remoteFork)
    applyRemoteChatIfFresh.mockResolvedValue({ applied: true })
  })

  it('flushes the source, forks on the enclave, and stores the pulled row as a new chat', async () => {
    const notify = vi.fn()
    const unsubscribe = chatEvents.on(notify)
    try {
      const fork = await forkSource()

      expect(fork).toBe(remoteFork)
      expect(forkCloudChat).toHaveBeenCalledWith({
        sourceId: 'chat-source',
        targetId: 'chat-fork',
        messageCount: 1,
        title: 'Trip planning (fork)',
        createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        idempotencyKey: expect.any(String),
      })
      expect(downloadChat).toHaveBeenCalledWith('chat-fork')
      expect(applyRemoteChatIfFresh).toHaveBeenCalledWith(
        expect.objectContaining({
          chat: remoteFork,
          syncVersion: 1,
          expectedLocalUpdatedAt: null,
          userId: 'user-1',
        }),
      )
      expect(notify).toHaveBeenCalledWith({
        reason: 'sync',
        ids: ['chat-fork'],
      })
      expect(uploadChat).not.toHaveBeenCalled()
    } finally {
      unsubscribe()
    }
  })

  it('uploads pending local edits before asking the enclave to fork', async () => {
    const dirty = { ...syncedSource, locallyModified: true, pendingUpload: 1 }
    getChat.mockResolvedValue(dirty)
    uploadChat.mockResolvedValue({
      syncVersion: 4,
      rewrites: [],
      projectIntentIncluded: false,
    })
    finalizeUpload.mockImplementation(async () => {
      dirty.locallyModified = false
      dirty.pendingUpload = 0
    })

    await new CloudSyncService().forkChat({
      sourceId: 'chat-source',
      targetId: 'chat-fork',
      messageCount: 1,
      title: 'Trip planning (fork)',
    })

    expect(uploadChat).toHaveBeenCalledTimes(1)
    expect(uploadChat.mock.invocationCallOrder[0]).toBeLessThan(
      forkCloudChat.mock.invocationCallOrder[0],
    )
  })

  it('requires authentication even when the source is clean', async () => {
    isAuthenticated.mockResolvedValue(false)

    await expect(forkSource()).rejects.toThrow(
      'Authentication required for cloud sync',
    )

    expect(forkCloudChat).not.toHaveBeenCalled()
  })

  it('requires key authorization even when the source is clean', async () => {
    canWriteToCloud.mockResolvedValue(false)

    await expect(forkSource()).rejects.toThrow(
      'Cloud sync key is not authorized',
    )

    expect(forkCloudChat).not.toHaveBeenCalled()
  })

  it('refuses to fork a chat that belongs to another account', async () => {
    getChat.mockResolvedValue({ ...syncedSource, syncUserId: 'user-2' })

    await expect(forkSource()).rejects.toThrow(
      'Chat does not belong to the active account',
    )

    expect(forkCloudChat).not.toHaveBeenCalled()
  })

  it('fails when the source chat is missing locally', async () => {
    getChat.mockResolvedValue(null)

    await expect(forkSource()).rejects.toThrow('Chat not found')

    expect(forkCloudChat).not.toHaveBeenCalled()
  })

  it('fails when the fork cannot be pulled back after the enclave created it', async () => {
    downloadChat.mockResolvedValue(null)

    await expect(forkSource()).rejects.toThrow(
      'Forked chat was not found after creation: chat-fork',
    )

    expect(forkCloudChat).toHaveBeenCalledTimes(1)
    expect(applyRemoteChatIfFresh).not.toHaveBeenCalled()
  })

  it('aborts if the source is still dirty after the flush', async () => {
    const dirty = { ...syncedSource, locallyModified: true, pendingUpload: 1 }
    getChat.mockResolvedValue(dirty)
    uploadChat.mockResolvedValue({
      syncVersion: 4,
      rewrites: [],
      projectIntentIncluded: false,
    })
    // An edit lands during the upload, so the row stays locally modified.
    finalizeUpload.mockResolvedValue(undefined)

    await expect(forkSource()).rejects.toThrow(
      'Chat changed while preparing to fork',
    )

    expect(forkCloudChat).not.toHaveBeenCalled()
  })

  it('stops before storing the fork when the account changes mid-request', async () => {
    const notify = vi.fn()
    const unsubscribe = chatEvents.on(notify)
    try {
      forkCloudChat.mockImplementation(async () => {
        localStorage.setItem(AUTH_ACTIVE_USER_ID, 'user-2')
        return { syncVersion: 1 }
      })

      await expect(forkSource()).rejects.toThrow('Cloud account changed')

      expect(applyRemoteChatIfFresh).not.toHaveBeenCalled()
      expect(notify).not.toHaveBeenCalled()
    } finally {
      unsubscribe()
    }
  })

  it('fails without touching the enclave when pending edits cannot be synced', async () => {
    getChat.mockResolvedValue({ ...syncedSource, locallyModified: true })
    canWriteToCloud.mockResolvedValue(false)

    await expect(forkSource()).rejects.toThrow(
      'Cloud sync key is not authorized',
    )

    expect(forkCloudChat).not.toHaveBeenCalled()
    expect(applyRemoteChatIfFresh).not.toHaveBeenCalled()
  })

  it('surfaces a failure when the fork cannot be stored locally', async () => {
    applyRemoteChatIfFresh.mockResolvedValue({ applied: false })

    await expect(forkSource()).rejects.toThrow(
      'Forked chat could not be stored locally: chat-fork',
    )
  })
})
