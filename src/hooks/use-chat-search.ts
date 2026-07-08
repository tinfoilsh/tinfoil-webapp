import {
  ensureSearchIndex,
  resolveSearchResultChats,
  searchSyncedChats,
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
export function useChatSearch(term: string, enabled: boolean): ChatSearchState {
  const trimmed = term.trim()
  const active = enabled && trimmed.length > 0

  const [results, setResults] = useState<SearchResultChat[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [isIndexing, setIsIndexing] = useState(false)
  const [available, setAvailable] = useState(true)
  const [refreshNonce, setRefreshNonce] = useState(0)

  useEffect(() => {
    if (!active) {
      setResults([])
      setIsSearching(false)
      setIsIndexing(false)
      return
    }
    // Set on cleanup so completions from a superseded term (or an
    // unmounted component) know they lost the race and must not set
    // state or schedule a refresh.
    let cancelled = false
    setIsSearching(true)
    const run = async () => {
      try {
        const outcome = await searchSyncedChats(trimmed, SEARCH_RESULT_LIMIT)
        if (cancelled) return
        setAvailable(outcome.available)
        setIsIndexing(outcome.indexing)
        const chats = await resolveSearchResultChats(outcome.results)
        if (cancelled) return
        setResults(chats)
        setIsSearching(false)
        if (outcome.indexing) {
          void ensureSearchIndex().then(() => {
            if (!cancelled) setRefreshNonce((n) => n + 1)
          })
        }
      } catch (err) {
        if (cancelled) return
        logError('chat search failed', err, {
          component: 'useChatSearch',
          action: 'search',
        })
        setResults([])
        setIsSearching(false)
      }
    }
    const timer = setTimeout(() => void run(), SEARCH_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [trimmed, active, refreshNonce])

  return { results, isSearching, isIndexing, available }
}
