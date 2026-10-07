import { ingestRemoteChats } from '@/services/cloud/chat-ingestion'
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  getChat,
  applyRemoteChatIfFresh,
  processRemoteChat,
  emit,
  fetchRawChatContent,
  reportChatSyncRecovered,
} = vi.hoisted(() => ({
  getChat: vi.fn(),
  applyRemoteChatIfFresh: vi.fn(),
  processRemoteChat: vi.fn(),
  emit: vi.fn(),
  fetchRawChatContent: vi.fn(),
  reportChatSyncRecovered: vi.fn(),
}))

vi.mock('@/services/storage/indexed-db', () => ({
  indexedDBStorage: { getChat, applyRemoteChatIfFresh },
}))
vi.mock('@/services/cloud/chat-codec', () => ({ processRemoteChat }))
vi.mock('@/services/storage/chat-events', () => ({ chatEvents: { emit } }))
vi.mock('@/services/cloud/cloud-storage', () => ({
  cloudStorage: { fetchRawChatContent },
}))
vi.mock('@/services/cloud/sync-health', () => ({ reportChatSyncRecovered }))

describe('ingestRemoteChats', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getChat.mockResolvedValue(null)
    processRemoteChat.mockResolvedValue({
      chat: { id: 'chat-1', messages: [], syncVersion: 2 },
    })
    applyRemoteChatIfFresh.mockResolvedValue({ applied: true })
  })

  it('durably applies decoded content and emits its saved ID', async () => {
    Object.defineProperty(window, 'indexedDB', {
      configurable: true,
      value: indexedDB,
    })
    const { indexedDBStorage } = await vi.importActual<
      typeof import('@/services/storage/indexed-db')
    >('@/services/storage/indexed-db')
    const codec = await vi.importActual<
      typeof import('@/services/cloud/chat-codec')
    >('@/services/cloud/chat-codec')
    getChat.mockImplementation(indexedDBStorage.getChat.bind(indexedDBStorage))
    processRemoteChat.mockImplementation(codec.processRemoteChat)
    let finishCommit!: () => void
    const commit = new Promise<void>((resolve) => {
      finishCommit = resolve
    })
    applyRemoteChatIfFresh.mockImplementation(
      async (
        options: Parameters<typeof indexedDBStorage.applyRemoteChatIfFresh>[0],
      ) => {
        await commit
        return indexedDBStorage.applyRemoteChatIfFresh(options)
      },
    )
    const pending = ingestRemoteChats([
      {
        id: 'chat-1',
        content: JSON.stringify({
          title: 'Durable content',
          messages: [{ role: 'user', content: 'Stored body' }],
        }),
        syncVersion: 2,
      },
    ])
    await vi.waitFor(() =>
      expect(applyRemoteChatIfFresh).toHaveBeenCalledOnce(),
    )
    expect(await indexedDBStorage.getChat('chat-1')).toBeNull()
    expect(emit).not.toHaveBeenCalled()
    finishCommit()
    const result = await pending
    expect(await indexedDBStorage.getChat('chat-1')).toMatchObject({
      title: 'Durable content',
      messages: [{ role: 'user', content: 'Stored body' }],
      syncVersion: 2,
      pendingUpload: 0,
    })

    expect(result).toEqual({
      savedIds: ['chat-1'],
      downloaded: 1,
      errors: [],
    })
    expect(applyRemoteChatIfFresh).toHaveBeenCalledWith(
      expect.objectContaining({
        syncVersion: 2,
        expectedLocalUpdatedAt: null,
      }),
    )
    expect(emit).toHaveBeenCalledWith({ reason: 'sync', ids: ['chat-1'] })
    expect(reportChatSyncRecovered).toHaveBeenCalledWith('chat-1')
    emit.mockClear()
    applyRemoteChatIfFresh.mockRejectedValueOnce(new Error('Commit failed'))
    const failed = await ingestRemoteChats([
      { id: 'chat-2', content: JSON.stringify({ messages: [] }) },
    ])
    expect(failed.savedIds).toEqual([])
    expect(failed.errors).toMatchObject([
      { chatId: 'chat-2', stage: 'storage' },
    ])
    expect(emit).not.toHaveBeenCalled()
  })

  it('falls back when an entry has undefined project metadata', async () => {
    await ingestRemoteChats(
      [{ id: 'chat-1', content: '{}', projectId: undefined }],
      { projectId: 'fallback-project' },
    )

    expect(processRemoteChat).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ projectId: 'fallback-project' }),
    )
  })

  it('uses authoritative project metadata from fetched content', async () => {
    fetchRawChatContent.mockResolvedValue({
      plaintext: '{}',
      formatVersion: 2,
      syncVersion: 2,
      projectIdSet: true,
      projectId: null,
    })

    await ingestRemoteChats([{ id: 'chat-1' }], {
      fetchMissingContent: true,
      projectId: 'stale-project',
    })

    expect(processRemoteChat).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ projectId: null }),
    )
  })
})
