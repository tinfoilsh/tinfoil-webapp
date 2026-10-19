import {
  resolveSearchResultChats,
  searchSyncedChats,
  type ReindexSettleResult,
  type SearchResultChat,
} from '@/services/cloud/chat-search'
import { logError } from '@/utils/error-handling'
import { useEffect, useState } from 'react'

const SEARCH_DEBOUNCE_MS = 300
const SEARCH_RESULT_LIMIT = 20

export interface ChatSearchState {
  /** Ranked, title-resolved hits for the current term. */
  results: SearchResultChat[]
  /** True from the first keystroke until the current term's results land. */
  isSearching: boolean
  /** True while the enclave rebuilds the index; results may be partial. */
  isIndexing: boolean
  /**
   * True when the current term's search threw or the index rebuild it
   * was waiting on did not complete, so an empty result set must not
   * be presented as "no matches".
   */
  failed: boolean
  /**
   * False when server-side search cannot run (no key loaded, enclave
   * without a search backend). Callers should fall back to filtering
   * locally loaded chats by title.
   */
  available: boolean
}

/**
 * Debounced encrypted search over synced chats. When the enclave
 * reports it is rebuilding the index, the hook waits for the job to
 * settle and re-runs the current term so results fill in without any
 * user action.
 */
export function useChatSearch(
  term: string,
  enabled: boolean,
  includeProjectChats = true,
): ChatSearchState {
  const trimmed = term.trim()
  const active = enabled && trimmed.length > 0

  const [results, setResults] = useState<SearchResultChat[]>([])
  const [completedQuery, setCompletedQuery] = useState<{
    term: string
    includeProjectChats: boolean
  } | null>(null)
  const [isSearching, setIsSearching] = useState(false)
  const [isIndexing, setIsIndexing] = useState(false)
  const [failed, setFailed] = useState(false)
  const [available, setAvailable] = useState(true)
  const [refreshNonce, setRefreshNonce] = useState(0)

  useEffect(() => {
    if (!active) {
      setResults([])
      setCompletedQuery(null)
      setIsSearching(false)
      setIsIndexing(false)
      setFailed(false)
      return
    }
    // Set on cleanup so completions from a superseded term (or an
    // unmounted component) know they lost the race and must not set
    // state or schedule a refresh.
    let cancelled = false
    setIsSearching(true)
    setFailed(false)
    const run = async () => {
      try {
        const outcome = await searchSyncedChats(trimmed, SEARCH_RESULT_LIMIT)
        if (cancelled) return
        setAvailable(outcome.available)
        setIsIndexing(outcome.indexing)
        const chats = await resolveSearchResultChats(
          outcome.results,
          includeProjectChats,
        )
        if (cancelled) return
        setResults(chats)
        setCompletedQuery({ term: trimmed, includeProjectChats })
        setIsSearching(false)
        if (outcome.reindexSettled) {
          // Re-query only after a successful rebuild. Refreshing on a
          // failed or skipped settle would report needs_reindex again
          // and kick another full rebuild, looping a persistent
          // failure at full embedding cost.
          outcome.reindexSettled.then((settled: ReindexSettleResult) => {
            if (cancelled) return
            if (settled === 'completed') {
              setRefreshNonce((n) => n + 1)
            } else {
              setIsIndexing(false)
              // 'skipped' means a recent rebuild already failed and we
              // are inside its cooldown, so the index is still broken.
              setFailed(true)
            }
          })
        }
      } catch (err) {
        if (cancelled) return
        logError('chat search failed', err, {
          component: 'useChatSearch',
          action: 'search',
        })
        setResults([])
        setCompletedQuery({ term: trimmed, includeProjectChats })
        setIsSearching(false)
        // A failed run has no settle callback to clear the indexing
        // flag, so reset it here or the "building index" indicator
        // stays up until the user edits the term.
        setIsIndexing(false)
        setFailed(true)
      }
    }
    const timer = setTimeout(() => void run(), SEARCH_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [trimmed, active, includeProjectChats, refreshNonce])

  const isCurrentQuery =
    completedQuery?.term === trimmed &&
    completedQuery.includeProjectChats === includeProjectChats
  return {
    results: active && isCurrentQuery && !isSearching ? results : [],
    isSearching: active && (!isCurrentQuery || isSearching),
    isIndexing: active && isIndexing,
    failed: active && isCurrentQuery && failed,
    available,
  }
}
