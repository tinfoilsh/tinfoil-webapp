import type { operations } from './openapi'
import { ROUTES } from './protocol'
import type { HarnessAPI } from './runtime'
import type { ThreadSummary } from './types'

// The harness searches the stored chats of an account, by title and
// content, from an index it builds as chats change. A page holds the chats
// found, how many more match that cannot be opened, and whether the index is
// still being built, so results may be missing.
export type SearchPage =
  operations['search']['responses'][200]['content']['application/json']

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

// Chats read at a time to find the most recent ones outside any project.
const RECENT_LIMIT = 100

// The account's latest `count` stored chats outside any project, read page
// by page from its chats in every project and none.
export async function latestChatsOutsideProjects(
  api: HarnessAPI,
  count: number,
  signal?: AbortSignal,
) {
  const found: ThreadSummary[] = []
  // A page that names a cursor already read ends the scan.
  const read = new Set<string>()
  let cursor: string | null = null
  do {
    if (cursor) read.add(cursor)
    const page: { threads: ThreadSummary[]; nextCursor: string | null } =
      await api.post(
        ROUTES.list,
        { limit: RECENT_LIMIT, ...(cursor ? { cursor } : {}) },
        { signal },
      )
    found.push(...page.threads.filter((thread) => !thread.projectId))
    cursor = page.nextCursor
  } while (cursor && !read.has(cursor) && found.length < count)
  return found.slice(0, count)
}
