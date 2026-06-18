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

  const handleQueryRef = useRef(handleQuery)
  const isRateLimitedRef = useRef(isRateLimited)
  const onBeforeDispatchRef = useRef(onBeforeDispatch)
  const onRateLimitedRef = useRef(onRateLimited)
  useEffect(() => {
    handleQueryRef.current = handleQuery
    isRateLimitedRef.current = isRateLimited
    onBeforeDispatchRef.current = onBeforeDispatch
    onRateLimitedRef.current = onRateLimited
  })

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
  useEffect(() => {
    if (!isRateLimited()) {
      rateLimitPromptShownRef.current = false
    }
  })

  // One single-flight pump per chat. Dispatch always targets the chat on
  // screen (handleQuery is bound to it), so the pump only proceeds while
  // its chat is active and stops otherwise, leaving the queue to resume
  // when the chat is reopened.
  const pumpRunningRef = useRef<Set<string>>(new Set())

  const runPump = useCallback(
    async (id: string): Promise<void> => {
      if (id == null) return
      if (pumpRunningRef.current.has(id)) return
      pumpRunningRef.current.add(id)
      try {
        while (getQueue(id).length > 0) {
          // Only the chat on screen can dispatch; pause otherwise.
          if (id !== currentChatIdRef.current) return
          await waitForIdle()
          if (id !== currentChatIdRef.current) return

          if (isRateLimitedRef.current()) {
            if (!rateLimitPromptShownRef.current) {
              rateLimitPromptShownRef.current = true
              onRateLimitedRef.current?.()
            }
            return
          }
          rateLimitPromptShownRef.current = false

          const [next, ...rest] = getQueue(id)
          if (!next) break
          setQueueFor(id, rest)
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
        pumpRunningRef.current.delete(id)
        // If something was enqueued while the pump was tearing down and the
        // chat is still active, restart it on the next tick.
        if (id === currentChatIdRef.current && getQueue(id).length > 0) {
          queueMicrotask(() => {
            void runPump(id)
          })
        }
      }
    },
    [getQueue, setQueueFor, waitForIdle],
  )

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

  // Sync the rendered queue to the active chat and resume draining it (e.g.
  // messages left in sessionStorage, or queued while the chat was in the
  // background). Runs on mount and on every chat switch.
  useEffect(() => {
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
