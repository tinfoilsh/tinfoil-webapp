import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockSearchQuery = vi.fn()
const mockSearchReindex = vi.fn()
const mockSearchReindexStatus = vi.fn()
const mockPull = vi.fn()
const mockGetChat = vi.fn()
const mockHasPrimaryKey = vi.fn()

vi.mock('@/services/sync-enclave/sync-api', async () => {
  const actual: any = await vi.importActual('@/services/sync-enclave/sync-api')
  return {
    ...actual,
    searchQuery: (...args: any[]) => mockSearchQuery(...args),
    searchReindex: (...args: any[]) => mockSearchReindex(...args),
    searchReindexStatus: (...args: any[]) => mockSearchReindexStatus(...args),
    pull: (...args: any[]) => mockPull(...args),
  }
})

vi.mock('@/services/cloud/cek-encoding', () => ({
  hasPrimaryKey: () => mockHasPrimaryKey(),
  requirePrimaryKeyB64: () => 'primary-b64',
  pullKey: () => [{ key: 'primary-b64' }],
}))

vi.mock('@/services/storage/chat-storage', () => ({
  chatStorage: {
    getChat: (...args: any[]) => mockGetChat(...args),
  },
}))

async function importChatSearch() {
  return import('@/services/cloud/chat-search')
}

function runningStatus() {
  return {
    job_id: 'job-1',
    status: 'running',
    indexed: 0,
    failed: 0,
    total_indexed: 0,
    partial: false,
  }
}

function completedStatus() {
  return {
    job_id: 'job-1',
    status: 'completed',
    indexed: 4,
    failed: 0,
    total_indexed: 4,
    partial: false,
  }
}

describe('chat-search', () => {
  beforeEach(() => {
    // Reset module state (the shared in-flight reindex promise) so
    // tests cannot observe each other's poll loops.
    vi.resetModules()
    vi.clearAllMocks()
    mockHasPrimaryKey.mockReturnValue(true)
    mockGetChat.mockResolvedValue(null)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('reports unavailable when no primary key is loaded', async () => {
    mockHasPrimaryKey.mockReturnValue(false)
    const search = await importChatSearch()
    const outcome = await search.searchSyncedChats('ducks')
    expect(outcome).toEqual({
      results: [],
      totalIndexed: 0,
      indexing: false,
      available: false,
    })
    expect(mockSearchQuery).not.toHaveBeenCalled()
  })

  it('maps a 503 from the enclave to unavailable instead of throwing', async () => {
    const { SyncEnclaveError } =
      await import('@/services/sync-enclave/sync-api')
    mockSearchQuery.mockRejectedValue(
      new SyncEnclaveError('search backend not configured', 503, 'INTERNAL'),
    )
    const search = await importChatSearch()
    const outcome = await search.searchSyncedChats('ducks')
    expect(outcome.available).toBe(false)
    expect(outcome.results).toEqual([])
  })

  it('rethrows transient errors so callers can distinguish them', async () => {
    const { SyncEnclaveError } =
      await import('@/services/sync-enclave/sync-api')
    mockSearchQuery.mockRejectedValue(
      new SyncEnclaveError('embedding service failed', 502, 'UPSTREAM'),
    )
    const search = await importChatSearch()
    await expect(search.searchSyncedChats('ducks')).rejects.toThrow(
      /embedding service failed/,
    )
  })

  it('returns ranked results and passes key + limit to the enclave', async () => {
    mockSearchQuery.mockResolvedValue({
      results: [
        { id: 'b', score: 2 },
        { id: 'a', score: 1 },
      ],
      total_indexed: 9,
    })
    const search = await importChatSearch()
    const outcome = await search.searchSyncedChats('duck pond', 7)
    expect(outcome).toEqual({
      results: [
        { id: 'b', score: 2 },
        { id: 'a', score: 1 },
      ],
      totalIndexed: 9,
      indexing: false,
      available: true,
    })
    expect(mockSearchQuery).toHaveBeenCalledWith({
      keyB64: 'primary-b64',
      query: 'duck pond',
      limit: 7,
    })
    expect(mockSearchReindex).not.toHaveBeenCalled()
  })

  it('kicks one shared reindex when queries report needs_reindex and polls it to completion', async () => {
    vi.useFakeTimers()
    mockSearchQuery.mockResolvedValue({
      results: [],
      total_indexed: 0,
      needs_reindex: true,
    })
    mockSearchReindex.mockResolvedValue(runningStatus())
    mockSearchReindexStatus
      .mockResolvedValueOnce(runningStatus())
      .mockResolvedValueOnce(completedStatus())

    const search = await importChatSearch()
    const [first, second] = await Promise.all([
      search.searchSyncedChats('ducks'),
      search.searchSyncedChats('taxes'),
    ])
    expect(first.indexing).toBe(true)
    expect(second.indexing).toBe(true)

    const settled = search.ensureSearchIndex()
    await vi.advanceTimersByTimeAsync(2_000)
    await vi.advanceTimersByTimeAsync(2_000)
    await expect(settled).resolves.toBe('completed')

    expect(mockSearchReindex).toHaveBeenCalledTimes(1)
    expect(mockSearchReindex).toHaveBeenCalledWith([{ key: 'primary-b64' }])
    expect(mockSearchReindexStatus).toHaveBeenCalledTimes(2)
  })

  it('does not poll when the kickoff already reports a terminal status', async () => {
    mockSearchReindex.mockResolvedValue(completedStatus())
    const search = await importChatSearch()
    await expect(search.ensureSearchIndex()).resolves.toBe('completed')
    expect(mockSearchReindexStatus).not.toHaveBeenCalled()
  })

  it('puts kicks on cooldown after a failed run instead of looping rebuilds', async () => {
    vi.useFakeTimers()
    mockSearchReindex.mockResolvedValue({
      ...runningStatus(),
      status: 'failed',
      error: 'embedding service failed',
    })
    const search = await importChatSearch()
    await expect(search.ensureSearchIndex()).resolves.toBe('failed')
    expect(mockSearchReindex).toHaveBeenCalledTimes(1)

    await expect(search.ensureSearchIndex()).resolves.toBe('skipped')
    expect(mockSearchReindex).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(search.SEARCH_REINDEX_FAILURE_COOLDOWN_MS)
    mockSearchReindex.mockResolvedValue(completedStatus())
    await expect(search.ensureSearchIndex()).resolves.toBe('completed')
    expect(mockSearchReindex).toHaveBeenCalledTimes(2)
  })

  it('resolves as failed when the rebuild kick throws', async () => {
    mockSearchReindex.mockRejectedValue(new Error('network down'))
    const search = await importChatSearch()
    await expect(search.ensureSearchIndex()).resolves.toBe('failed')
  })

  it('resolves result titles locally first, pulls the rest, and preserves ranking', async () => {
    mockGetChat.mockImplementation(async (id: string) =>
      id === 'a'
        ? {
            id: 'a',
            title: 'Local pond notes',
            updatedAt: '2026-07-01T00:00:00Z',
            messages: [{}, {}],
          }
        : null,
    )
    mockPull.mockResolvedValue({
      items: [
        {
          id: 'b',
          ok: true,
          plaintext: JSON.stringify({
            title: 'Remote tax chat',
            messages: [{ role: 'user', content: 'tax return time' }],
            createdAt: '2026-06-01T00:00:00Z',
          }),
        },
        { id: 'c', ok: false, code: 'NOT_FOUND' },
      ],
    })
    const search = await importChatSearch()
    const chats = await search.resolveSearchResultChats([
      { id: 'b', score: 3 },
      { id: 'a', score: 2 },
      { id: 'c', score: 1 },
    ])
    expect(chats.map((c) => c.id)).toEqual(['b', 'a'])
    expect(chats[0].title).toBe('Remote tax chat')
    expect(chats[0].messageCount).toBe(1)
    expect(chats[1].title).toBe('Local pond notes')
    expect(chats[1].messageCount).toBe(2)
    expect(mockPull).toHaveBeenCalledWith({
      scope: 'chat',
      ids: ['b', 'c'],
      keys: [{ key: 'primary-b64' }],
    })
  })

  it('skips the pull entirely when every result resolves locally', async () => {
    mockGetChat.mockResolvedValue({
      id: 'a',
      title: 'Local',
      updatedAt: '2026-07-01T00:00:00Z',
      messages: [],
    })
    const search = await importChatSearch()
    const chats = await search.resolveSearchResultChats([{ id: 'a', score: 1 }])
    expect(chats).toHaveLength(1)
    expect(mockPull).not.toHaveBeenCalled()
  })
})
