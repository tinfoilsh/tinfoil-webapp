import { ERROR_ACTIONS, ERROR_CODES } from '@/services/harness/protocol'
import { useHarness } from '@/services/harness/provider'
import type { HarnessAPI } from '@/services/harness/runtime'
import {
  latestChatsOutsideProjects,
  searchChats,
} from '@/services/harness/search'
import { HarnessError } from '@/services/harness/sse'
import type { HarnessErrorBody, ThreadSummary } from '@/services/harness/types'
import { logError } from '@/utils/error-handling'
import { useEffect, useState } from 'react'
const SEARCH_DEBOUNCE_MS = 250
// While the harness builds its index, the search runs again after a wait
// that doubles up to a limit, a bounded number of times.
const INDEX_POLL_FIRST_WAIT_MS = 1000
const INDEX_POLL_MAX_WAIT_MS = 16_000
const INDEX_POLL_MAX_ATTEMPTS = 6
// Why a search that never reached the chat service failed.
const NOT_REACHED: HarnessErrorBody = {
  code: ERROR_CODES.connection,
  action: ERROR_ACTIONS.retry,
  message: 'The chat service could not be reached.',
}
export function useChatSearch(
  term: string,
  enabled: boolean,
  includeProjectChats = true,
) {
  const { api, keyReady } = useHarness()
  // The results, with the search they answer: a render after the term
  // changes, or after the search is run again, shows none of the previous
  // search's rows.
  const [outcome, setOutcome] = useState<{
    query: string
    includeProjectChats: boolean
    retries: number
    results: ThreadSummary[]
    unreadable: number
    failure: HarnessErrorBody | null
  } | null>(null)
  // How many times the user ran the search again after it failed.
  const [retries, setRetries] = useState(0)
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
            retries,
            results: page.results.filter(
              (t) => includeProjectChats || !t.projectId,
            ),
            unreadable: page.unreadable,
            failure: null,
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
            retries,
            results: attempt > 0 && previous ? previous.results : [],
            unreadable: attempt > 0 && previous ? previous.unreadable : 0,
            failure: cause instanceof HarnessError ? cause.detail : NOT_REACHED,
          }))
        })
    }
    timer = setTimeout(() => run(0), SEARCH_DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [api, active, includeProjectChats, query, retries])
  const current =
    active &&
    outcome?.query === query &&
    outcome.includeProjectChats === includeProjectChats &&
    outcome.retries === retries
      ? outcome
      : null
  return {
    results: current?.results ?? [],
    // Matching chats the harness could not open, left out of results.
    unreadable: current?.unreadable ?? 0,
    isSearching: active && !current,
    failure: current?.failure ?? null,
    retry: () => setRetries((count) => count + 1),
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
