import { useHarness } from '@/services/harness/provider'
import type { ThreadSummary } from '@/services/harness/types'
import { useEffect, useState } from 'react'
export function useChatSearch(
  term: string,
  enabled: boolean,
  includeProjectChats = true,
) {
  const { api, keyReady } = useHarness()
  const [results, setResults] = useState<
    (ThreadSummary & { score?: number })[]
  >([])
  const [isSearching, setIsSearching] = useState(false)
  const [failed, setFailed] = useState(false)
  const [isIndexing, setIsIndexing] = useState(false)
  const available = !!api.userId && keyReady
  useEffect(() => {
    const controller = new AbortController()
    setResults([])
    setFailed(false)
    if (!term.trim() || !enabled || !available) {
      setIsSearching(false)
      return
    }
    setIsSearching(true)
    const timer = setTimeout(() => {
      void api
        .post<{
          results: (ThreadSummary & { score?: number })[]
          indexing: boolean
        }>(
          '/v1/threads/search',
          { query: term.trim(), limit: 20 },
          controller.signal,
        )
        .then((page) => {
          if (!controller.signal.aborted) {
            setIsIndexing(page.indexing)
            setResults(
              page.results.filter((t) => includeProjectChats || !t.projectId),
            )
          }
        })
        .catch(() => {
          if (!controller.signal.aborted) setFailed(true)
        })
        .finally(() => {
          if (!controller.signal.aborted) setIsSearching(false)
        })
    }, 250)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [api, available, enabled, includeProjectChats, term])
  return { results, isSearching, failed, available, isIndexing }
}
