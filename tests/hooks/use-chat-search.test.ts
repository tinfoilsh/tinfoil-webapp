import {
  AUTH_ACTIVE_USER_ID,
  USER_ENCRYPTION_KEY,
} from '@/constants/storage-keys'
import { useChatSearch } from '@/hooks/use-chat-search'
import type { HarnessClient } from '@/services/harness/client'
import { activateAPI, HarnessAPI, publish } from '@/services/harness/runtime'
import type { ThreadSummary } from '@/services/harness/types'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { testSession } from '../harness-fixture'

const ACCOUNT_KEY = `key_${'ar'.repeat(32)}`
const ACCOUNT_KEY_B64 = 'ERERERERERERERERERERERERERERERERERERERERERE='

type SearchPage = {
  results: Partial<ThreadSummary>[]
  indexing: boolean
}

const search =
  vi.fn<(input: unknown, signal: AbortSignal) => Promise<SearchPage>>()
let release: () => void

function page(ids: string[], options: Partial<SearchPage> = {}): SearchPage {
  return {
    results: ids.map((id) => ({ id, title: `${id} result`, projectId: null })),
    indexing: false,
    ...options,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

async function flushDebounce() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  localStorage.setItem(AUTH_ACTIVE_USER_ID, 'user_1')
  localStorage.setItem(USER_ENCRYPTION_KEY, ACCOUNT_KEY)
  search.mockReset().mockRejectedValue(new Error('Unexpected search request'))
  const client = {
    post: vi.fn(async (path: string, input: unknown, signal: AbortSignal) => {
      if (path !== '/v1/threads/search')
        throw new Error(`Unexpected request: ${path}`)
      return search(input, signal)
    }),
  }
  release = activateAPI(
    new HarnessAPI(client as unknown as HarnessClient, 'user_1'),
  )
  publish({ session: testSession, keyReady: true })
})

afterEach(() => {
  release()
  vi.useRealTimers()
})

describe('useChatSearch', () => {
  it('searches the harness with the trimmed term after the debounce', async () => {
    search.mockResolvedValueOnce(page(['duck']))
    const { result } = renderHook(() => useChatSearch('  duck  ', true))
    expect(result.current.isSearching).toBe(true)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200)
    })
    expect(search).not.toHaveBeenCalled()

    await flushDebounce()
    expect(search).toHaveBeenCalledExactlyOnceWith(
      { key: ACCOUNT_KEY_B64, query: 'duck', limit: 20 },
      expect.any(AbortSignal),
    )
    expect(result.current.results.map((thread) => thread.id)).toEqual(['duck'])
    expect(result.current.isSearching).toBe(false)
  })

  it('hides the old query results as soon as the user edits the search', async () => {
    search
      .mockResolvedValueOnce(page(['old']))
      .mockResolvedValueOnce(page(['new']))
    const { result, rerender } = renderHook(
      ({ term }) => useChatSearch(term, true),
      { initialProps: { term: 'old' } },
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
    expect(search).toHaveBeenCalledTimes(2)
  })

  it('never renders the previous term results for a new term', async () => {
    search
      .mockResolvedValueOnce(page(['old']))
      .mockResolvedValueOnce(page(['new']))
    const renders: { term: string; ids: string[]; isSearching: boolean }[] = []
    const { rerender } = renderHook(
      ({ term }) => {
        const state = useChatSearch(term, true)
        renders.push({
          term,
          ids: state.results.map((thread) => thread.id),
          isSearching: state.isSearching,
        })
        return state
      },
      { initialProps: { term: 'old' } },
    )
    await flushDebounce()
    expect(renders.at(-1)).toEqual({
      term: 'old',
      ids: ['old'],
      isSearching: false,
    })

    rerender({ term: 'new' })
    await flushDebounce()

    const forNewTerm = renders.filter((render) => render.term === 'new')
    expect(forNewTerm[0]).toEqual({ term: 'new', ids: [], isSearching: true })
    expect(forNewTerm.filter((render) => render.ids.includes('old'))).toEqual(
      [],
    )
    expect(forNewTerm.at(-1)).toEqual({
      term: 'new',
      ids: ['new'],
      isSearching: false,
    })
  })

  it('hides project hits immediately when the allowed search scope changes', async () => {
    const mixed = {
      results: [
        { id: 'project-chat', title: 'Project result', projectId: 'p1' },
        { id: 'plain-chat', title: 'Plain result', projectId: null },
      ],
      indexing: false,
    }
    search.mockResolvedValueOnce(mixed).mockResolvedValueOnce(mixed)
    const { result, rerender } = renderHook(
      ({ premium }) => useChatSearch('result', true, premium),
      { initialProps: { premium: true } },
    )
    await flushDebounce()
    expect(result.current.results.map((thread) => thread.id)).toEqual([
      'project-chat',
      'plain-chat',
    ])
    rerender({ premium: false })
    expect(result.current.results).toEqual([])
    await flushDebounce()
    expect(result.current.results.map((thread) => thread.id)).toEqual([
      'plain-chat',
    ])
  })

  it('ignores a response for a superseded term', async () => {
    const stale = deferred<SearchPage>()
    search
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce(page(['current']))
    const { result, rerender } = renderHook(
      ({ term }) => useChatSearch(term, true),
      { initialProps: { term: 'old' } },
    )
    await flushDebounce()
    const staleSignal = search.mock.calls[0][1]
    rerender({ term: 'current' })
    expect(staleSignal.aborted).toBe(true)
    await flushDebounce()
    expect(result.current.results.map((thread) => thread.id)).toEqual([
      'current',
    ])

    await act(async () => stale.resolve(page(['old'])))
    expect(result.current.results.map((thread) => thread.id)).toEqual([
      'current',
    ])
    expect(result.current.isSearching).toBe(false)
  })

  it('clears the indexing flag when a later search fails', async () => {
    search
      .mockResolvedValueOnce(page([], { indexing: true }))
      .mockRejectedValueOnce(new Error('enclave timeout'))
    const { result, rerender } = renderHook(
      ({ term }) => useChatSearch(term, true),
      { initialProps: { term: 'duc' } },
    )
    await flushDebounce()
    expect(result.current.isIndexing).toBe(true)

    rerender({ term: 'duck' })
    expect(result.current.isIndexing).toBe(true)
    await flushDebounce()

    expect(result.current.isSearching).toBe(false)
    expect(result.current.isIndexing).toBe(false)
    expect(result.current.failed).toBe(true)
    expect(result.current.results).toEqual([])
  })

  it('clears a previous failure when the term changes and the new run succeeds', async () => {
    search
      .mockRejectedValueOnce(new Error('enclave timeout'))
      .mockResolvedValueOnce(page(['recovered']))
    const { result, rerender } = renderHook(
      ({ term }) => useChatSearch(term, true),
      { initialProps: { term: 'duc' } },
    )
    await flushDebounce()
    expect(result.current.failed).toBe(true)

    rerender({ term: 'duck' })
    expect(result.current.failed).toBe(false)
    await flushDebounce()
    expect(result.current.failed).toBe(false)
    expect(result.current.results.map((thread) => thread.id)).toEqual([
      'recovered',
    ])
    expect(result.current.isSearching).toBe(false)
  })

  it('does not search before the account key is ready', async () => {
    publish({ keyReady: false })
    const { result, rerender } = renderHook(
      ({ enabled }) => useChatSearch('duck', enabled),
      { initialProps: { enabled: true } },
    )
    await flushDebounce()
    expect(result.current.available).toBe(false)
    expect(result.current.isSearching).toBe(false)
    expect(search).not.toHaveBeenCalled()

    search.mockResolvedValueOnce(page(['duck']))
    act(() => publish({ keyReady: true }))
    rerender({ enabled: true })
    await flushDebounce()
    expect(result.current.available).toBe(true)
    expect(search).toHaveBeenCalledOnce()
  })
})
