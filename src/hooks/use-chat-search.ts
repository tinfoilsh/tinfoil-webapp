import { useHarness } from '@/services/harness/provider'
import { searchChats } from '@/services/harness/search'
import type { ThreadSummary } from '@/services/harness/types'
import { useEffect, useState } from 'react'
const SEARCH_DEBOUNCE_MS = 250
const INDEX_POLL_INTERVAL_MS = 1000
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
    const run = () => {
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
          if (page.indexing) timer = setTimeout(run, INDEX_POLL_INTERVAL_MS)
        })
        .catch(() => {
          if (controller.signal.aborted) return
          // A failed search cannot report a finished rebuild, so clear the
          // indexing flag rather than leaving "building index" up.
          setIsIndexing(false)
          setOutcome({ query, includeProjectChats, results: [], failed: true })
        })
    }
    timer = setTimeout(run, SEARCH_DEBOUNCE_MS)
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
