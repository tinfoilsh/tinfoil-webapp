import { useHarness } from '@/services/harness/provider'
import type { HarnessAPI } from '@/services/harness/runtime'
import {
  latestChatsOutsideProjects,
  searchChats,
} from '@/services/harness/search'
import type { ThreadSummary } from '@/services/harness/types'
import { logError } from '@/utils/error-handling'
import { useEffect, useState } from 'react'
const SEARCH_DEBOUNCE_MS = 250
// While the harness builds its index, the search runs again after a wait
// that doubles up to a limit, a bounded number of times.
const INDEX_POLL_FIRST_WAIT_MS = 1000
const INDEX_POLL_MAX_WAIT_MS = 16_000
const INDEX_POLL_MAX_ATTEMPTS = 6
export function useChatSearch(
  term: string,
  enabled: boolean,
  includeProjectChats = true,
) {
  const { api, keyReady } = useHarness()
  // The results, with the search they answer: a render after the term
  // changes shows none of the previous term's rows.
  const [outcome, setOutcome] = useState<{
    query: string
    includeProjectChats: boolean
    results: (ThreadSummary & { score?: number })[]
    failed: boolean
  } | null>(null)
  const [isIndexing, setIsIndexing] = useState(false)
  const available = !!api.userId && keyReady
  const query = term.trim()
  const active = !!query && enabled && available
  useEffect(() => {
    const controller = new AbortController()
    if (!active) {
      setOutcome(null)
      setIsIndexing(false)
      return
    }
    let timer: ReturnType<typeof setTimeout>
    const run = (attempt: number) => {
      void searchChats(api, query, controller.signal)
        .then((page) => {
          if (controller.signal.aborted) return
          setIsIndexing(page.indexing)
          setOutcome({
            query,
            includeProjectChats,
            results: page.results.filter(
              (t) => includeProjectChats || !t.projectId,
            ),
            failed: false,
          })
          if (page.indexing && attempt < INDEX_POLL_MAX_ATTEMPTS)
            timer = setTimeout(
              () => run(attempt + 1),
              Math.min(
                INDEX_POLL_FIRST_WAIT_MS * 2 ** attempt,
                INDEX_POLL_MAX_WAIT_MS,
              ),
            )
        })
        .catch((cause) => {
          if (controller.signal.aborted) return
          logError('Failed to search chats', cause, {
            component: 'useChatSearch',
            action: 'search',
          })
          // A failed search cannot report a finished rebuild, so clear the
          // indexing flag rather than leaving "building index" up. A search
          // run again while the index builds keeps the results it had.
          setIsIndexing(false)
          setOutcome((previous) => ({
            query,
            includeProjectChats,
            results: attempt > 0 && previous ? previous.results : [],
            failed: true,
          }))
        })
    }
    timer = setTimeout(() => run(0), SEARCH_DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [api, active, includeProjectChats, query])
  const current =
    active &&
    outcome?.query === query &&
    outcome.includeProjectChats === includeProjectChats
      ? outcome
      : null
  return {
    results: current?.results ?? [],
    isSearching: active && !current,
    failed: !!current?.failed,
    available,
    isIndexing: active && isIndexing,
  }
}

const NO_CHATS: ThreadSummary[] = []

// The latest `count` stored chats outside any project, for a search opened
// in a project, whose chat list holds only that project's chats.
export function useChatsOutsideProjects(enabled: boolean, count: number) {
  const { api, keyReady } = useHarness()
  const [listed, setListed] = useState<{
    api: HarnessAPI
    threads: ThreadSummary[]
  } | null>(null)
  const active = enabled && !!api.userId && keyReady
  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    void latestChatsOutsideProjects(api, count, controller.signal)
      .then((threads) => {
        if (controller.signal.aborted) return
        setListed({ api, threads })
      })
      .catch((cause) => {
        if (controller.signal.aborted) return
        logError('Failed to list chats outside projects', cause, {
          component: 'useChatsOutsideProjects',
          action: 'list',
        })
      })
    return () => controller.abort()
  }, [api, active, count])
  return active && listed?.api === api ? listed.threads : NO_CHATS
}
