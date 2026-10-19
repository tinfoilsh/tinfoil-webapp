import { useChatSearch } from '@/hooks/use-chat-search'
import type { ChatSearchOutcome } from '@/services/cloud/chat-search'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const searchSyncedChats = vi.fn()
const resolveSearchResultChats = vi.fn()

vi.mock('@/services/cloud/chat-search', () => ({
  searchSyncedChats: (...args: unknown[]) => searchSyncedChats(...args),
  resolveSearchResultChats: (...args: unknown[]) =>
    resolveSearchResultChats(...args),
}))

vi.mock('@/utils/error-handling', () => ({
  logError: vi.fn(),
}))

function indexingOutcome(
  reindexSettled: ChatSearchOutcome['reindexSettled'] = new Promise(() => {}),
): ChatSearchOutcome {
  return {
    results: [],
    totalIndexed: 0,
    indexing: true,
    available: true,
    reindexSettled,
  }
}

function readyOutcome(): ChatSearchOutcome {
  return {
    results: [],
    totalIndexed: 3,
    indexing: false,
    available: true,
    reindexSettled: null,
  }
}

async function flushDebounce() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(400)
  })
}

describe('useChatSearch', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    searchSyncedChats.mockReset()
    resolveSearchResultChats.mockReset()
    resolveSearchResultChats.mockResolvedValue([])
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('hides the old query results as soon as the user edits the search', async () => {
    searchSyncedChats.mockResolvedValue(readyOutcome())
    resolveSearchResultChats
      .mockResolvedValueOnce([
        { id: 'old', title: 'Old result', messageCount: 2 },
      ])
      .mockResolvedValueOnce([
        { id: 'new', title: 'New result', messageCount: 2 },
      ])
    const { result, rerender } = renderHook(
      ({ term }) => useChatSearch(term, true),
      {
        initialProps: { term: 'old' },
      },
    )
    await flushDebounce()
    expect(result.current.results[0].id).toBe('old')
    rerender({ term: 'new' })
    expect(result.current.results).toEqual([])
    expect(result.current.isSearching).toBe(true)
    await flushDebounce()
    expect(result.current.results[0].id).toBe('new')
    expect(result.current.isSearching).toBe(false)
    rerender({ term: '' })
    expect(result.current.results).toEqual([])
    expect(result.current.isSearching).toBe(false)
  })

  it('hides project hits immediately when the allowed search scope changes', async () => {
    searchSyncedChats.mockResolvedValue(readyOutcome())
    resolveSearchResultChats
      .mockResolvedValueOnce([
        {
          id: 'project-chat',
          title: 'Project result',
          projectId: 'p1',
          messageCount: 2,
        },
      ])
      .mockResolvedValueOnce([])
    const { result, rerender } = renderHook(
      ({ premium }) => useChatSearch('result', true, premium),
      {
        initialProps: { premium: true },
      },
    )
    await flushDebounce()
    expect(result.current.results).toHaveLength(1)
    rerender({ premium: false })
    expect(result.current.results).toEqual([])
    await flushDebounce()
    expect(resolveSearchResultChats).toHaveBeenLastCalledWith([], false)
    expect(result.current.results).toEqual([])
  })

  it('clears the indexing flag when a later search run fails', async () => {
    searchSyncedChats.mockResolvedValueOnce(indexingOutcome())
    const { result, rerender } = renderHook(
      ({ term }) => useChatSearch(term, true),
      { initialProps: { term: 'duc' } },
    )
    await flushDebounce()
    expect(result.current.isIndexing).toBe(true)

    searchSyncedChats.mockRejectedValueOnce(new Error('enclave timeout'))
    rerender({ term: 'duck' })
    expect(result.current.isIndexing).toBe(true)
    await flushDebounce()

    expect(result.current.isSearching).toBe(false)
    expect(result.current.isIndexing).toBe(false)
    expect(result.current.failed).toBe(true)
    expect(result.current.results).toEqual([])
  })

  it('clears the indexing flag when resolving hits fails after needs_reindex', async () => {
    searchSyncedChats.mockResolvedValueOnce(indexingOutcome())
    resolveSearchResultChats.mockRejectedValueOnce(new Error('pull failed'))
    const { result } = renderHook(() => useChatSearch('duck', true))
    await flushDebounce()

    expect(result.current.isSearching).toBe(false)
    expect(result.current.isIndexing).toBe(false)
    expect(result.current.failed).toBe(true)
  })

  it.each(['failed', 'skipped'] as const)(
    'marks the search failed without re-querying when the rebuild is %s',
    async (settled) => {
      searchSyncedChats.mockResolvedValueOnce(
        indexingOutcome(Promise.resolve(settled)),
      )
      const { result } = renderHook(() => useChatSearch('duck', true))
      await flushDebounce()

      expect(result.current.isIndexing).toBe(false)
      expect(result.current.failed).toBe(true)
      await flushDebounce()
      expect(searchSyncedChats).toHaveBeenCalledTimes(1)
    },
  )

  it('re-queries after a completed rebuild and publishes the refreshed hits', async () => {
    searchSyncedChats
      .mockResolvedValueOnce(indexingOutcome(Promise.resolve('completed')))
      .mockResolvedValueOnce(readyOutcome())
    const rebuiltHits = [
      { id: 'rebuilt', title: 'Rebuilt result', messageCount: 2 },
    ]
    resolveSearchResultChats
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(rebuiltHits)
    const { result } = renderHook(() => useChatSearch('duck', true))
    await flushDebounce()
    await flushDebounce()

    expect(searchSyncedChats).toHaveBeenCalledTimes(2)
    expect(searchSyncedChats).toHaveBeenNthCalledWith(1, 'duck', 20)
    expect(searchSyncedChats).toHaveBeenNthCalledWith(2, 'duck', 20)
    expect(result.current.results).toEqual(rebuiltHits)
    expect(result.current.isSearching).toBe(false)
    expect(result.current.isIndexing).toBe(false)
    expect(result.current.failed).toBe(false)
  })

  it('ignores a completed rebuild after the search term changes', async () => {
    let finishRebuild!: (outcome: 'completed') => void
    const rebuild = new Promise<'completed'>((resolve) => {
      finishRebuild = resolve
    })
    const currentHits = [
      { id: 'current', title: 'Current result', messageCount: 2 },
    ]
    searchSyncedChats
      .mockResolvedValueOnce(indexingOutcome(rebuild))
      .mockResolvedValue(readyOutcome())
    resolveSearchResultChats
      .mockResolvedValueOnce([])
      .mockResolvedValue(currentHits)
    const { result, rerender } = renderHook(
      ({ term }) => useChatSearch(term, true),
      { initialProps: { term: 'old' } },
    )
    await flushDebounce()
    expect(result.current.isIndexing).toBe(true)
    rerender({ term: 'current' })
    await flushDebounce()
    expect(result.current.results).toEqual(currentHits)
    await act(async () => finishRebuild('completed'))
    await flushDebounce()
    expect(searchSyncedChats).toHaveBeenCalledTimes(2)
    expect(searchSyncedChats).toHaveBeenLastCalledWith('current', 20)
    expect(result.current.results).toEqual(currentHits)
    expect(result.current.isSearching).toBe(false)
    expect(result.current.isIndexing).toBe(false)
  })

  it('clears a previous failure when the term changes and the new run succeeds', async () => {
    searchSyncedChats
      .mockRejectedValueOnce(new Error('enclave timeout'))
      .mockResolvedValueOnce(readyOutcome())
    const recoveredHits = [
      { id: 'recovered', title: 'Recovered result', messageCount: 2 },
    ]
    resolveSearchResultChats.mockResolvedValueOnce(recoveredHits)
    const { result, rerender } = renderHook(
      ({ term }) => useChatSearch(term, true),
      { initialProps: { term: 'duc' } },
    )
    await flushDebounce()
    expect(result.current.failed).toBe(true)

    rerender({ term: 'duck' })
    await flushDebounce()
    expect(result.current.failed).toBe(false)
    expect(searchSyncedChats).toHaveBeenLastCalledWith('duck', 20)
    expect(result.current.results).toEqual(recoveredHits)
    expect(result.current.isSearching).toBe(false)
  })
})
