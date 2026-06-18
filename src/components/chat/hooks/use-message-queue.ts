import { MESSAGE_QUEUE_PREFIX } from '@/constants/storage-keys'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Attachment, LoadingState, Message, QueuedMessage } from '../types'

type HandleQuery = (
  query: string,
  attachments?: Attachment[],
  systemPromptOverride?: string,
  baseMessages?: Message[],
  quote?: string,
) => void | Promise<unknown>

export type QueueSubmitInput = {
  text: string
  attachments?: Attachment[]
  quote?: string
}

type UseMessageQueueArgs = {
  chatId: string | null | undefined
  loadingState: LoadingState
  handleQuery: HandleQuery
  isRateLimited: () => boolean
  onBeforeDispatch?: () => void
  onRateLimited?: () => void
}

type UseMessageQueueReturn = {
  queuedMessages: QueuedMessage[]
  submit: (input: QueueSubmitInput) => void
  removeQueuedMessage: (id: string) => void
}

const isBrowser = typeof window !== 'undefined'

function storageKeyFor(chatId: string | null | undefined): string | null {
  return chatId ? `${MESSAGE_QUEUE_PREFIX}${chatId}` : null
}

function generateQueuedId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `queued-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function loadFromStorage(key: string | null): QueuedMessage[] {
  if (!key || !isBrowser) return []
  try {
    const raw = window.sessionStorage.getItem(key)
    if (!raw) return []
    const parsed = JSON.parse(raw) as QueuedMessage[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeToStorage(key: string | null, queue: QueuedMessage[]): void {
  if (!key || !isBrowser) return
  try {
    if (queue.length === 0) {
      window.sessionStorage.removeItem(key)
    } else {
      window.sessionStorage.setItem(key, JSON.stringify(queue))
    }
  } catch {
    /* sessionStorage may be unavailable or full; queue stays in memory */
  }
}

/**
 * Holds user messages submitted while the assistant is busy and dispatches
 * them one-at-a-time per chat.
 *
 * Concurrency model:
 *
 *   Each chat owns its own queue and its own single-flight pump, so a
 *   conversation that is streaming never blocks a different conversation
 *   from sending. `handleQuery` always targets the chat on screen, so a
 *   pump only dispatches while its chat is the active one; a backgrounded
 *   chat keeps its queued messages and resumes draining when reopened.
 *
 * Why a pump instead of an effect-per-tick:
 *
 *   `loadingState` is shared between the in-flight stream and the queue.
 *   Cancelling a stream (Stop button) runs a chain of cleanup code in
 *   `handleQuery`'s catch/finally and the streaming processor's finally
 *   that asynchronously calls `setLoadingState('idle')` AFTER the queue
 *   has already kicked off the next dispatch. An effect that drains on
 *   every `loading → idle` transition mistakes that stale cleanup for
 *   "my dispatch finished" and fires the next one in parallel.
 *
 *   The pump avoids that race entirely: it owns the dispatch lifecycle
 *   end-to-end. It awaits `handleQuery`'s returned promise — which only
 *   settles when the stream we kicked off truly completes — and only
 *   then loops to the next message. Stale `loadingState` writes from a
 *   previously-cancelled stream can't trigger anything because nothing
 *   observes them.
 */
export function useMessageQueue({
  chatId,
  loadingState,
  handleQuery,
  isRateLimited,
  onBeforeDispatch,
  onRateLimited,
}: UseMessageQueueArgs): UseMessageQueueReturn {
  // Per-chat queues so several conversations can hold pending messages at
  // once. Hydrated lazily from sessionStorage on first access.
  const queuesRef = useRef<Map<string, QueuedMessage[]>>(new Map())

  const getQueue = useCallback(
    (id: string | null | undefined): QueuedMessage[] => {
      // Only null/undefined means "no chat". A blank chat has an empty
      // string id (see createBlankChat) and is a valid, queueable target;
      // its messages live in memory only since storageKeyFor('') is null.
      if (id == null) return []
      let q = queuesRef.current.get(id)
      if (!q) {
        q = loadFromStorage(storageKeyFor(id))
        queuesRef.current.set(id, q)
      }
      return q
    },
    [],
  )

  // Mirror of the active chat id for reads inside stable callbacks.
  const currentChatIdRef = useRef<string | null | undefined>(chatId)
  currentChatIdRef.current = chatId

  // Rendered queue tracks the chat on screen.
  const [queue, setQueue] = useState<QueuedMessage[]>(() => getQueue(chatId))

  const setQueueFor = useCallback((id: string, next: QueuedMessage[]) => {
    queuesRef.current.set(id, next)
    writeToStorage(storageKeyFor(id), next)
    if (id === currentChatIdRef.current) setQueue(next)
  }, [])

  // Latest-value mirrors so the async pump always calls the current
  // handlers (in particular handleQuery, which is bound to the chat on
  // screen) without being re-created on every render. Assigned during
  // render so they can never be stale relative to currentChatIdRef when the
  // pump dispatches in a microtask (an effect would lag a paint behind).
  const handleQueryRef = useRef(handleQuery)
  const isRateLimitedRef = useRef(isRateLimited)
  const onBeforeDispatchRef = useRef(onBeforeDispatch)
  const onRateLimitedRef = useRef(onRateLimited)
  handleQueryRef.current = handleQuery
  isRateLimitedRef.current = isRateLimited
  onBeforeDispatchRef.current = onBeforeDispatch
  onRateLimitedRef.current = onRateLimited

  // Live mirror of the active chat's `loadingState`, used by the pump to
  // gate the next dispatch on that chat actually being idle.
  const loadingStateRef = useRef<LoadingState>(loadingState)
  // Pending resolvers for `waitForIdle`. Resolved whenever the active chat
  // transitions to `'idle'`.
  const idleWaitersRef = useRef<Array<() => void>>([])
  useEffect(() => {
    loadingStateRef.current = loadingState
    if (loadingState === 'idle' && idleWaitersRef.current.length > 0) {
      const waiters = idleWaitersRef.current
      idleWaitersRef.current = []
      for (const resolve of waiters) resolve()
    }
  }, [loadingState])

  const waitForIdle = useCallback((): Promise<void> => {
    if (loadingStateRef.current === 'idle') return Promise.resolve()
    return new Promise<void>((resolve) => {
      idleWaitersRef.current.push(resolve)
    })
  }, [])

  // Rate-limit prompt latch: show at most once per exhaustion window.
  const rateLimitPromptShownRef = useRef(false)

  // One single-flight pump per chat. Dispatch always targets the chat on
  // screen (handleQuery is bound to it), so the pump only proceeds while
  // its chat is active and stops otherwise, leaving the queue to resume
  // when the chat is reopened.
  // Active pumps keyed by their current chat id. Each holds a mutable `id`
  // so a blank chat's pump can follow the conversion to a real id (see the
  // re-key in the chat-sync effect) instead of staying parked on the shared
  // blank id ('') and blocking the next new chat.
  const pumpsRef = useRef<Map<string, { id: string }>>(new Map())

  const runPump = useCallback(
    async (startId: string): Promise<void> => {
      if (startId == null) return
      if (pumpsRef.current.has(startId)) return
      const pump = { id: startId }
      pumpsRef.current.set(startId, pump)
      try {
        while (getQueue(pump.id).length > 0) {
          // Only the chat on screen can dispatch; pause otherwise.
          if (pump.id !== currentChatIdRef.current) return
          await waitForIdle()
          if (pump.id !== currentChatIdRef.current) return

          if (isRateLimitedRef.current()) {
            if (!rateLimitPromptShownRef.current) {
              rateLimitPromptShownRef.current = true
              onRateLimitedRef.current?.()
            }
            return
          }
          rateLimitPromptShownRef.current = false

          const [next, ...rest] = getQueue(pump.id)
          if (!next) break
          setQueueFor(pump.id, rest)
          onBeforeDispatchRef.current?.()

          try {
            const result = handleQueryRef.current(
              next.text,
              next.attachments,
              undefined,
              undefined,
              next.quote,
            )
            if (
              result &&
              typeof (result as Promise<unknown>).then === 'function'
            ) {
              await (result as Promise<unknown>)
            }
          } catch {
            /* errors are surfaced by the chat itself; keep draining */
          }
        }
      } finally {
        if (pumpsRef.current.get(pump.id) === pump) {
          pumpsRef.current.delete(pump.id)
        }
        // If something was enqueued while the pump was tearing down and the
        // chat is still active, restart it on the next tick. Skip while
        // rate-limited so we don't busy-spin; the rate-limit effect resumes
        // the queue once the limit clears.
        if (
          pump.id === currentChatIdRef.current &&
          getQueue(pump.id).length > 0 &&
          !isRateLimitedRef.current()
        ) {
          queueMicrotask(() => {
            void runPump(pump.id)
          })
        }
      }
    },
    [getQueue, setQueueFor, waitForIdle],
  )

  // When the rate limit clears, reset the one-shot prompt latch and resume
  // the active chat's queue (the pump bails out while rate-limited rather
  // than busy-waiting). Runs whenever the rate-limit predicate changes.
  useEffect(() => {
    if (!isRateLimited()) {
      rateLimitPromptShownRef.current = false
      const id = currentChatIdRef.current
      if (id != null && getQueue(id).length > 0) {
        void runPump(id)
      }
    }
  }, [isRateLimited, getQueue, runPump])

  const submit = useCallback(
    (input: QueueSubmitInput): void => {
      const id = currentChatIdRef.current
      if (id == null) return
      const item: QueuedMessage = {
        id: generateQueuedId(),
        text: input.text,
        attachments:
          input.attachments && input.attachments.length > 0
            ? input.attachments
            : undefined,
        quote: input.quote ?? undefined,
      }
      setQueueFor(id, [...getQueue(id), item])
      void runPump(id)
    },
    [getQueue, setQueueFor, runPump],
  )

  // Tracks the previously-rendered chat id so we can detect a blank chat
  // being converted to a real id (a brand-new conversation getting its
  // server/local id on its first message).
  const prevChatIdRef = useRef<string | null | undefined>(chatId)

  // Sync the rendered queue to the active chat and resume draining it (e.g.
  // messages left in sessionStorage, or queued while the chat was in the
  // background). Runs on mount and on every chat switch.
  useEffect(() => {
    const prev = prevChatIdRef.current
    prevChatIdRef.current = chatId

    // Blank chats all share the empty-string id. When one converts to a
    // real id, re-key its in-flight pump and queue so the freed blank id is
    // immediately available to the next new chat. Only blank ('') ids are
    // transient and reused this way, so this never fires on a plain switch
    // between existing chats.
    if (
      prev === '' &&
      chatId != null &&
      chatId !== '' &&
      pumpsRef.current.has('')
    ) {
      const pump = pumpsRef.current.get('')
      const pending = queuesRef.current.get('')
      if (pending && pending.length > 0) {
        queuesRef.current.set(chatId, [
          ...(queuesRef.current.get(chatId) ?? []),
          ...pending,
        ])
        writeToStorage(storageKeyFor(chatId), queuesRef.current.get(chatId)!)
      }
      queuesRef.current.delete('')
      if (pump) {
        pump.id = chatId
        pumpsRef.current.delete('')
        pumpsRef.current.set(chatId, pump)
      }
    }

    setQueue(getQueue(chatId))
    if (chatId != null && getQueue(chatId).length > 0) {
      void runPump(chatId)
    }
  }, [chatId, getQueue, runPump])

  const removeQueuedMessage = useCallback(
    (queuedId: string): void => {
      const id = currentChatIdRef.current
      if (id == null) return
      setQueueFor(
        id,
        getQueue(id).filter((item) => item.id !== queuedId),
      )
    },
    [getQueue, setQueueFor],
  )

  return { queuedMessages: queue, submit, removeQueuedMessage }
}
