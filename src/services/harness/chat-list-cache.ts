import {
  AUTH_ACTIVE_USER_ID,
  CLOUD_CHAT_LIST_CACHE_PREFIX,
} from '@/constants/storage-keys'
import { logError } from '@/utils/error-handling'
import { z } from 'zod'
import type { ThreadSummary } from './types'

// A summary an earlier version cached has no activity time; the chat's
// creation stands in for it.
const summarySchema = z
  .object({
    id: z.string(),
    title: z.string(),
    titleState: z.enum(['placeholder', 'generated', 'manual']),
    createdAt: z.string().nullable(),
    updatedAt: z.string().nullable(),
    activityAt: z.string().optional(),
    model: z.string(),
    projectId: z.string().nullable(),
    pinned: z.boolean(),
    webSearchEnabled: z.boolean(),
    messageCount: z.number(),
    contextUsage: z.null().default(null),
    activeRun: z.null(),
    flagged: z.boolean().optional(),
  })
  .transform((summary) => ({
    ...summary,
    activityAt: summary.activityAt ?? summary.createdAt ?? '',
  }))

const cacheSchema = z.object({
  threads: z.array(summarySchema),
  pinned: z.array(summarySchema),
})

export interface CachedChatList {
  threads: ThreadSummary[]
  pinned: ThreadSummary[]
}

const accountPrefix = (userId: string) =>
  `${CLOUD_CHAT_LIST_CACHE_PREFIX}:${encodeURIComponent(userId)}:`
const cacheKey = (userId: string, projectId?: string | null) =>
  accountPrefix(userId) + encodeURIComponent(JSON.stringify(projectId ?? null))

function cachedKeys(userId: string): string[] {
  const prefix = accountPrefix(userId)
  return Array.from({ length: localStorage.length }, (_, index) =>
    localStorage.key(index),
  ).filter((key): key is string => key !== null && key.startsWith(prefix))
}

function parse(stored: string | null): CachedChatList | undefined {
  if (!stored) return
  try {
    const parsed = cacheSchema.safeParse(JSON.parse(stored))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

export function readChatListCache(
  userId: string | null,
  projectId?: string | null,
): CachedChatList | undefined {
  if (!userId || typeof window === 'undefined') return
  try {
    if (localStorage.getItem(AUTH_ACTIVE_USER_ID) !== userId) return
    return parse(localStorage.getItem(cacheKey(userId, projectId)))
  } catch (error) {
    logError('Failed to read the cached chat list', error, {
      component: 'chatListCache',
      action: 'read',
    })
  }
}

function write(key: string, list: CachedChatList) {
  // Persist only sidebar fields. Run hints and message contents belong to
  // the live response, even if a caller supplies a complete thread.
  const summaries = (threads: ThreadSummary[]) =>
    threads.map((thread) => ({
      ...thread,
      activeRun: null,
      contextUsage: null,
    }))
  const snapshot = cacheSchema.parse({
    threads: summaries(list.threads),
    pinned: summaries(list.pinned),
  })
  localStorage.setItem(key, JSON.stringify(snapshot))
}

export function writeChatListCache(
  userId: string | null,
  projectId: string | null,
  list: CachedChatList,
) {
  if (!userId || typeof window === 'undefined') return
  try {
    if (localStorage.getItem(AUTH_ACTIVE_USER_ID) !== userId) return
    write(cacheKey(userId, projectId), list)
  } catch (error) {
    logError('Failed to cache the chat list', error, {
      component: 'chatListCache',
      action: 'write',
    })
  }
}

export function removeCachedChat(userId: string | null, id: string) {
  if (!userId || typeof window === 'undefined') return
  try {
    if (localStorage.getItem(AUTH_ACTIVE_USER_ID) !== userId) return
    for (const key of cachedKeys(userId)) {
      const list = parse(localStorage.getItem(key))
      if (!list) continue
      if (
        !list.threads.some((thread) => thread.id === id) &&
        !list.pinned.some((thread) => thread.id === id)
      )
        continue
      localStorage.removeItem(key)
      try {
        write(key, {
          threads: list.threads.filter((thread) => thread.id !== id),
          pinned: list.pinned.filter((thread) => thread.id !== id),
        })
      } catch (error) {
        logError('Failed to cache the updated chat list', error, {
          component: 'chatListCache',
          action: 'remove',
        })
      }
    }
  } catch (error) {
    logError('Failed to remove a chat from the sidebar cache', error, {
      component: 'chatListCache',
      action: 'remove',
    })
  }
}

export function clearChatListCache(userId: string | null) {
  if (!userId || typeof window === 'undefined') return
  try {
    for (const key of cachedKeys(userId)) localStorage.removeItem(key)
  } catch (error) {
    logError('Failed to clear the cached chat lists', error, {
      component: 'chatListCache',
      action: 'clear',
    })
  }
}
