import { chatEvents } from '@/services/storage/chat-events'
import { logError } from '@/utils/error-handling'
import { useCallback, useEffect, useState } from 'react'
import {
  clearChatListCache,
  readChatListCache,
  removeCachedChat,
  writeChatListCache,
} from './chat-list-cache'
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

interface CloudListState {
  projectId: string | null
  loaded: boolean
  error: string | null
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
    const cached = cloud ? readChatListCache(api.userId, projectId) : undefined
    const scope = { projectId: projectId ?? null, restored: cloud }
    const cloudThreads = createStore<ThreadSummary[]>(cached?.threads ?? [])
    const deviceThreads = createStore<ThreadSummary[]>([])
    const pinnedThreads = createStore<ThreadSummary[]>(cached?.pinned ?? [])
    const cursor = createStore<string | null>(null)
    const loadState = createStore<CloudListState>({
      projectId: scope.projectId,
      loaded: false,
      error: null,
    })
    const cloudEdits = editsOf(cloudThreads)
    const pinnedEdits = editsOf(pinnedThreads)
    // Counts listings of the stored chats apart from the open chat, so that
    // opening a chat keeps the list and only the latest listing applies.
    const listing = { version: 0 }
    const persist = () => {
      if (!api.cloud || api.lifetime.signal.aborted || !scope.restored) return
      writeChatListCache(api.userId, scope.projectId, {
        threads: cloudThreads.get(),
        pinned: pinnedThreads.get(),
      })
    }
    return {
      cloudThreads,
      deviceThreads,
      pinnedThreads,
      cursor,
      loadState,
      listing,
      persist,
      restore(projectId: string | null | undefined) {
        const next = projectId ?? null
        if (scope.restored && scope.projectId === next) return
        listing.version++
        scope.projectId = next
        scope.restored = true
        loadState.set({ projectId: next, loaded: false, error: null })
        const cached = readChatListCache(api.userId, next)
        cloudThreads.set(cached?.threads ?? [])
        pinnedThreads.set(cached?.pinned ?? [])
        cursor.set(null)
      },
      cloud: {
        add(summary: ThreadSummary) {
          listing.version++
          if (!scope.projectId || scope.projectId === summary.projectId)
            cloudEdits.add(summary)
          if (summary.pinned) pinnedEdits.add(summary)
          persist()
        },
        replace(summary: ThreadSummary) {
          listing.version++
          if (!scope.projectId || scope.projectId === summary.projectId)
            cloudEdits.replace(summary)
          else cloudEdits.remove(summary.id)
          if (summary.pinned) pinnedEdits.add(summary)
          else pinnedEdits.remove(summary.id)
          persist()
        },
        remove(id: string) {
          listing.version++
          cloudEdits.remove(id)
          pinnedEdits.remove(id)
          removeCachedChat(api.userId, id)
          persist()
        },
      },
      device: editsOf(deviceThreads),
      // The stored chats are not listed, as once cloud sync is off.
      clearCloud({
        confirmedEmpty = false,
      }: { confirmedEmpty?: boolean } = {}) {
        listing.version++
        scope.restored = false
        loadState.set({
          projectId: scope.projectId,
          loaded: confirmedEmpty,
          error: null,
        })
        clearChatListCache(api.userId)
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
      if (!cloud) return
      lists.restore(projectId)
      if (!keyReady) return
      const version = next ? lists.listing.version : ++lists.listing.version
      if (lists.loadState.get().error) {
        lists.loadState.set({
          projectId: projectId ?? null,
          loaded: false,
          error: null,
        })
      }
      try {
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
        lists.persist()
        lists.loadState.set({
          projectId: projectId ?? null,
          loaded: true,
          error: null,
        })
      } catch (cause) {
        if (
          version !== lists.listing.version ||
          api.lifetime.signal.aborted ||
          (cause instanceof DOMException && cause.name === 'AbortError')
        )
          return
        lists.loadState.set({
          projectId: projectId ?? null,
          loaded: true,
          error:
            cause instanceof Error ? cause.message : 'Unable to load chats.',
        })
        throw cause
      }
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
  const loadState = useStore(lists.loadState)
  const currentScope = loadState.projectId === (projectId ?? null)
  return {
    ...lists,
    cloudListed: useStore(lists.cloudThreads),
    pinnedListed: useStore(lists.pinnedThreads),
    deviceListed: useStore(lists.deviceThreads),
    nextCursor: useStore(lists.cursor),
    loading: cloud && (!currentScope || !loadState.loaded),
    error: cloud && currentScope ? loadState.error : null,
    refresh,
  }
}

export type ChatList = ReturnType<typeof useChatList>
