import { chatEvents } from '@/services/storage/chat-events'
import { logError } from '@/utils/error-handling'
import { useCallback, useEffect, useState } from 'react'
import type { LocalThreadStore } from './local-threads'
import { ROUTES } from './protocol'
import type { HarnessAPI } from './runtime'
import { createStore, useStore, type Store } from './store'
import type { ListEdits } from './thread-store'
import type { ThreadSummary } from './types'

// Chats listed per request; more load with the cursor the last page ends at.
const PAGE_SIZE = 100

interface CloudPage {
  threads: ThreadSummary[]
  pinned?: ThreadSummary[] | null
  nextCursor: string | null
}

const editsOf = (store: Store<ThreadSummary[]>): ListEdits => ({
  add: (summary) =>
    store.update((listed) => [
      summary,
      ...listed.filter((thread) => thread.id !== summary.id),
    ]),
  replace: (summary) =>
    store.update((listed) =>
      listed.map((thread) => (thread.id === summary.id ? summary : thread)),
    ),
  remove: (threadId) =>
    store.update((listed) => listed.filter((thread) => thread.id !== threadId)),
})

// The chats the sidebar lists: the harness's stored chats with cloud sync,
// page by page, and the chats this device keeps, read again as they change.
export function useChatList({
  api,
  cloud,
  keyReady,
  projectId,
  device,
  report,
  revision,
}: {
  api: HarnessAPI
  cloud: boolean
  keyReady: boolean
  projectId?: string | null
  device: LocalThreadStore
  report(cause: unknown): void
  revision?: string
}) {
  const [lists] = useState(() => {
    const cloudThreads = createStore<ThreadSummary[]>([])
    const deviceThreads = createStore<ThreadSummary[]>([])
    const pinnedThreads = createStore<ThreadSummary[]>([])
    const cursor = createStore<string | null>(null)
    const cloudEdits = editsOf(cloudThreads)
    const pinnedEdits = editsOf(pinnedThreads)
    // Counts listings of the stored chats apart from the open chat, so that
    // opening a chat keeps the list and only the latest listing applies.
    const listing = { version: 0 }
    return {
      cloudThreads,
      deviceThreads,
      pinnedThreads,
      cursor,
      listing,
      cloud: {
        add(summary: ThreadSummary) {
          cloudEdits.add(summary)
          if (summary.pinned) pinnedEdits.add(summary)
        },
        replace(summary: ThreadSummary) {
          cloudEdits.replace(summary)
          if (summary.pinned) pinnedEdits.add(summary)
          else pinnedEdits.remove(summary.id)
        },
        remove(id: string) {
          cloudEdits.remove(id)
          pinnedEdits.remove(id)
        },
      },
      device: editsOf(deviceThreads),
      // The stored chats are not listed, as once cloud sync is off.
      clearCloud() {
        listing.version++
        cloudThreads.set([])
        pinnedThreads.set([])
        cursor.set(null)
      },
      isOnDevice: (threadId: string) =>
        deviceThreads.get().some((thread) => thread.id === threadId),
    }
  })
  const refresh = useCallback(
    async (next?: string) => {
      if (!cloud || !keyReady) return
      const version = next ? lists.listing.version : ++lists.listing.version
      const wanted = next
        ? PAGE_SIZE
        : Math.max(PAGE_SIZE, lists.cloudThreads.get().length)
      const result: CloudPage = { threads: [], nextCursor: next ?? null }
      do {
        const page: CloudPage = await api.post<CloudPage>(ROUTES.list, {
          cursor: result.nextCursor ?? undefined,
          projectId,
          limit: PAGE_SIZE,
        })
        if (page.pinned) result.pinned = page.pinned
        result.threads.push(
          ...page.threads.filter(
            (thread) => !result.threads.some((seen) => seen.id === thread.id),
          ),
        )
        if (page.nextCursor === result.nextCursor) break
        result.nextCursor = page.nextCursor
      } while (
        !next &&
        result.nextCursor &&
        result.threads.length < wanted &&
        version === lists.listing.version
      )
      if (version !== lists.listing.version) return
      lists.cloudThreads.update((previous) =>
        next
          ? [
              ...previous,
              ...result.threads.filter(
                (thread) => !previous.some((p) => p.id === thread.id),
              ),
            ]
          : result.threads,
      )
      lists.cursor.set(result.nextCursor)
      if (!next) lists.pinnedThreads.set(result.pinned ?? [])
    },
    [api, cloud, keyReady, projectId, lists],
  )
  useEffect(() => {
    void refresh().catch(report)
  }, [refresh, report, revision])
  useEffect(() => {
    let sequence = 0
    const load = () => {
      const request = ++sequence
      void device
        .list()
        .then((list) => {
          if (request === sequence) lists.deviceThreads.set(list)
        })
        .catch((cause) =>
          logError('Failed to list local chats', cause, {
            component: 'useChatList',
            action: 'listLocal',
          }),
        )
    }
    load()
    return chatEvents.on(load)
  }, [device, lists])
  return {
    ...lists,
    cloudListed: useStore(lists.cloudThreads),
    pinnedListed: useStore(lists.pinnedThreads),
    deviceListed: useStore(lists.deviceThreads),
    nextCursor: useStore(lists.cursor),
    refresh,
  }
}

export type ChatList = ReturnType<typeof useChatList>
