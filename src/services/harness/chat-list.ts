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
import type { ListEdits, ThreadPatch } from './thread-store'
import type { ThreadSummary } from './types'

// Chats listed per request; more load with the cursor the last page ends at.
const PAGE_SIZE = 100
const DEVICE_LIST_FAILED = 'The chats on this device could not be read.'

interface CloudPage {
  threads: ThreadSummary[]
  pinned?: ThreadSummary[] | null
  nextCursor: string | null
}

interface CloudListState {
  projectId: string | null
  loaded: boolean
  error: string | null
  retryCursor?: string
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

// A change the user made to a listed chat that its store has not answered:
// the chat left out of the lists, or listed with a new title or favorite
// state. A chat pinned joins the favorites as the stored chats listed it.
interface PendingChange {
  threadId: string
  removed?: boolean
  title?: string
  pinned?: boolean
  favorite?: ThreadSummary
}

type Listing = 'stored' | 'favorites' | 'device'

// A list with a change that is still saving shown in it. A chat on this
// device takes only its new title, as only a stored chat is a favorite.
function withChange(
  listed: ThreadSummary[],
  { threadId, removed, title, pinned, favorite }: PendingChange,
  listing: Listing,
): ThreadSummary[] {
  const at = listed.findIndex((thread) => thread.id === threadId)
  if (removed || (listing === 'favorites' && pinned === false))
    return at < 0 ? listed : listed.filter((thread) => thread.id !== threadId)
  const fields: Partial<ThreadSummary> = {
    ...(title !== undefined ? { title, titleState: 'manual' as const } : {}),
    ...(pinned !== undefined && listing !== 'device' ? { pinned } : {}),
  }
  if (at < 0)
    return listing === 'favorites' && pinned && favorite
      ? [...listed, { ...favorite, ...fields }]
      : listed
  if (!Object.keys(fields).length) return listed
  return listed.map((thread, index) =>
    index === at ? { ...thread, ...fields } : thread,
  )
}

// A list as it was last read or changed, which renders and is read with
// the changes still saving shown in it.
function showingPending(
  initial: ThreadSummary[],
  show: (listed: ThreadSummary[]) => ThreadSummary[],
): Store<ThreadSummary[]> & { reshow(): void } {
  let listed = initial
  const shown = createStore(show(listed))
  const set = (next: ThreadSummary[]) => {
    listed = next
    shown.set(show(listed))
  }
  return {
    get: shown.get,
    subscribe: shown.subscribe,
    set,
    update: (change) => set(change(listed)),
    // Shows the list again as the changes still saving now change it.
    reshow: () => shown.set(show(listed)),
  }
}

// The chats the sidebar lists: the harness's stored chats with cloud sync,
// page by page, and the chats this device keeps, read again as they change.
export function useChatList({
  api,
  cloud,
  keyReady,
  projectId,
  device,
  revision,
}: {
  api: HarnessAPI
  cloud: boolean
  keyReady: boolean
  projectId?: string | null
  device: LocalThreadStore
  revision?: string
}) {
  const [lists] = useState(() => {
    const cached = cloud ? readChatListCache(api.userId, projectId) : undefined
    const scope = { projectId: projectId ?? null, restored: cloud }
    // The changes the user made that their stores have not answered, in
    // the order they were made. Every list shows them over what it read.
    const pending = new Set<PendingChange>()
    const showing = (listing: Listing) => (listed: ThreadSummary[]) =>
      [...pending].reduce(
        (shown, change) => withChange(shown, change, listing),
        listed,
      )
    const cloudThreads = showingPending(
      cached?.threads ?? [],
      showing('stored'),
    )
    const deviceThreads = showingPending([], showing('device'))
    const deviceFailure = createStore<string | null>(null)
    const pinnedThreads = showingPending(
      cached?.pinned ?? [],
      showing('favorites'),
    )
    const cursor = createStore<string | null>(null)
    const edits = createStore(0)
    const loadState = createStore<CloudListState>({
      projectId: scope.projectId,
      loaded: false,
      error: null,
    })
    const cloudEdits = editsOf(cloudThreads)
    // The favorites in the order they were pinned, as the harness lists
    // them: a new one is the last, and one already listed keeps its place.
    const pinnedEdits: ListEdits = {
      ...editsOf(pinnedThreads),
      add: (summary) =>
        pinnedThreads.update((listed) =>
          listed.some((thread) => thread.id === summary.id)
            ? listed.map((thread) =>
                thread.id === summary.id ? summary : thread,
              )
            : [...listed, summary],
        ),
    }
    // Counts listings of the stored chats apart from the open chat, so that
    // opening a chat keeps the list and only the latest listing applies.
    const listing = { version: 0 }
    // Counts listings of the chats this device keeps; the latest applies.
    const deviceListing = { version: 0 }
    const persist = () => {
      if (!api.cloud || api.lifetime.signal.aborted || !scope.restored) return
      writeChatListCache(api.userId, scope.projectId, {
        threads: cloudThreads.get(),
        pinned: pinnedThreads.get(),
      })
    }
    // Shows a change before its store answers, and returns what settles
    // it. The lists then show what they read; a change the store saved
    // also settles the earlier changes of the same settings of the chat.
    const showPending = (change: PendingChange) => {
      const reshow = () => {
        cloudThreads.reshow()
        pinnedThreads.reshow()
        deviceThreads.reshow()
        persist()
      }
      pending.add(change)
      reshow()
      return (saved: boolean) => {
        if (!pending.has(change)) return
        for (const earlier of pending) {
          if (earlier === change) break
          if (!saved || earlier.threadId !== change.threadId) continue
          if (change.title !== undefined) delete earlier.title
          if (change.pinned !== undefined) delete earlier.pinned
          if (
            !earlier.removed &&
            earlier.title === undefined &&
            earlier.pinned === undefined
          )
            pending.delete(earlier)
        }
        pending.delete(change)
        reshow()
      }
    }
    return {
      cloudThreads,
      deviceThreads,
      deviceFailure,
      pinnedThreads,
      cursor,
      edits,
      loadState,
      listing,
      deviceListing,
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
          if (!loadState.get().loaded) edits.update((version) => version + 1)
        },
        replace(summary: ThreadSummary) {
          listing.version++
          if (!scope.projectId || scope.projectId === summary.projectId)
            cloudEdits.replace(summary)
          else cloudEdits.remove(summary.id)
          if (summary.pinned) pinnedEdits.add(summary)
          else pinnedEdits.remove(summary.id)
          persist()
          if (!loadState.get().loaded) edits.update((version) => version + 1)
        },
        remove(id: string) {
          listing.version++
          cloudEdits.remove(id)
          pinnedEdits.remove(id)
          removeCachedChat(api.userId, id)
          persist()
          if (!loadState.get().loaded) edits.update((version) => version + 1)
        },
        // A stored chat as the open chat's run reports it, which is newer
        // than the listed copy: a new chat joins the list, and a chat whose
        // reply goes on stays marked running until the list is read again.
        // The listed favorites still decide whether it is one.
        reported(summary: ThreadSummary) {
          listing.version++
          const pinned = pinnedThreads
            .get()
            .some((thread) => thread.id === summary.id)
          const shown = { ...summary, pinned }
          if (!scope.projectId || scope.projectId === summary.projectId)
            cloudEdits.add(shown)
          if (pinned) pinnedEdits.replace(shown)
          persist()
          if (!loadState.get().loaded) edits.update((version) => version + 1)
        },
      },
      device: editsOf(deviceThreads),
      // Shows a new title or favorite state of a chat until its store
      // answers, and returns what settles it with whether the store saved
      // it. Only a stored chat is a favorite.
      preview(threadId: string, { title, pinned }: ThreadPatch) {
        if (title === undefined && pinned === undefined) return () => {}
        return showPending({
          threadId,
          title,
          pinned,
          favorite: cloudThreads.get().find((thread) => thread.id === threadId),
        })
      },
      // Leaves a chat out of the lists until its store answers its
      // deletion, and returns what settles it.
      previewRemoval(threadId: string) {
        const settle = showPending({ threadId, removed: true })
        return () => settle(false)
      },
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
        api.reportSynced()
      } catch (cause) {
        if (
          version !== lists.listing.version ||
          api.lifetime.signal.aborted ||
          (cause instanceof DOMException && cause.name === 'AbortError')
        )
          return
        api.reportSyncFailed()
        lists.loadState.set({
          projectId: projectId ?? null,
          loaded: true,
          retryCursor: next,
          error:
            cause instanceof Error ? cause.message : 'Unable to load chats.',
        })
        throw cause
      }
    },
    [api, cloud, keyReady, projectId, lists],
  )
  // Reads the list again. A failure shows in the list, which offers a retry.
  const reload = useCallback(
    (next?: string) => {
      void refresh(next).catch((cause) =>
        logError('Failed to list chats', cause, {
          component: 'useChatList',
          action: 'refresh',
        }),
      )
    },
    [refresh],
  )
  const editVersion = useStore(lists.edits)
  useEffect(() => {
    reload()
  }, [reload, revision, editVersion])
  // Reads the chats this device keeps again. A failure shows in the list,
  // which offers a retry.
  const loadDevice = useCallback(() => {
    const request = ++lists.deviceListing.version
    void device
      .list()
      .then((list) => {
        if (request !== lists.deviceListing.version) return
        lists.deviceThreads.set(list)
        lists.deviceFailure.set(null)
      })
      .catch((cause) => {
        logError('Failed to list local chats', cause, {
          component: 'useChatList',
          action: 'listLocal',
        })
        if (request === lists.deviceListing.version)
          lists.deviceFailure.set(DEVICE_LIST_FAILED)
      })
  }, [device, lists])
  useEffect(() => {
    loadDevice()
    return chatEvents.on(loadDevice)
  }, [loadDevice])
  const loadState = useStore(lists.loadState)
  const currentScope = loadState.projectId === (projectId ?? null)
  return {
    ...lists,
    cloudListed: useStore(lists.cloudThreads),
    pinnedListed: useStore(lists.pinnedThreads),
    deviceListed: useStore(lists.deviceThreads),
    deviceError: useStore(lists.deviceFailure),
    retryDevice: loadDevice,
    nextCursor: useStore(lists.cursor),
    loading: cloud && (!currentScope || !loadState.loaded),
    error: cloud && currentScope ? loadState.error : null,
    refresh,
    reload: () => reload(),
    retry: () => reload(lists.loadState.get().retryCursor),
  }
}

export type ChatList = ReturnType<typeof useChatList>
