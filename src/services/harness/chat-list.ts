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
}: {
  api: HarnessAPI
  cloud: boolean
  keyReady: boolean
  projectId?: string | null
  device: LocalThreadStore
  report(cause: unknown): void
}) {
  const [lists] = useState(() => {
    const cloudThreads = createStore<ThreadSummary[]>([])
    const deviceThreads = createStore<ThreadSummary[]>([])
    // Counts listings of the stored chats apart from the open chat, so that
    // opening a chat keeps the list and only the latest listing applies.
    const listing = { version: 0 }
    return {
      cloudThreads,
      deviceThreads,
      cursor: createStore<string | null>(null),
      listing,
      cloud: editsOf(cloudThreads),
      device: editsOf(deviceThreads),
      // The stored chats are not listed, as once cloud sync is off.
      clearCloud() {
        listing.version++
        cloudThreads.set([])
      },
      isOnDevice: (threadId: string) =>
        deviceThreads.get().some((thread) => thread.id === threadId),
    }
  })
  const refresh = useCallback(
    async (next?: string) => {
      if (!cloud || !keyReady) return
      const version = next ? lists.listing.version : ++lists.listing.version
      const result = await api.post<CloudPage>(ROUTES.list, {
        cursor: next,
        projectId,
        limit: PAGE_SIZE,
      })
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
    },
    [api, cloud, keyReady, projectId, lists],
  )
  useEffect(() => {
    void refresh().catch(report)
  }, [refresh, report])
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
    deviceListed: useStore(lists.deviceThreads),
    nextCursor: useStore(lists.cursor),
    refresh,
  }
}

export type ChatList = ReturnType<typeof useChatList>
