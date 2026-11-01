import { ROUTES } from './protocol'
import type { HarnessAPI } from './runtime'
import type { ThreadSummary } from './types'

// The harness searches the stored chats of an account, by title and
// content, from an index it builds as chats change.
export interface SearchPage {
  results: (ThreadSummary & { score?: number })[]
  // The index is being built, so results may be missing.
  indexing: boolean
}

const SEARCH_LIMIT = 20

export const searchChats = (
  api: HarnessAPI,
  query: string,
  signal?: AbortSignal,
) =>
  api.post<SearchPage>(
    ROUTES.search,
    { query, limit: SEARCH_LIMIT },
    { signal },
  )
