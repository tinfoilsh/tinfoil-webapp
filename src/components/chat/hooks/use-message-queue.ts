import { MESSAGE_QUEUE_PREFIX } from '@/constants/storage-keys'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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

function removeFromStorage(key: string | null): void {
  if (!key || !isBrowser) return
  try {
    window.sessionStorage.removeItem(key)
  } catch {
    /* noop */
  }
}

/**
 * Holds user messages submitted while the assistant is busy and dispatches
 * them one-at-a-time through a single async pump.
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
  const initialKey = useMemo(() => storageKeyFor(chatId), [chatId])

  const [queue, setQueue] = useState<QueuedMessage[]>(() =>
    loadFromStorage(initialKey),
  )
  const queueRef = useRef<QueuedMessage[]>(queue)
  const currentKeyRef = useRef<string | null>(initialKey)

  const writeQueue = useCallback(
    (updater: (prev: QueuedMessage[]) => QueuedMessage[]) => {
      const next = updater(queueRef.current)
      queueRef.current = next
      setQueue(next)
      writeToStorage(currentKeyRef.current, next)
    },
    [],
  )

  // Handle chat-id changes: migrate pending items to the new key, or load
  // the new chat's stored queue if we have nothing pending.
  useEffect(() => {
    const nextKey = storageKeyFor(chatId)
    if (nextKey === currentKeyRef.current) return

    const previousKey = currentKeyRef.current
    currentKeyRef.current = nextKey

    if (queueRef.current.length > 0) {
      removeFromStorage(previousKey)
      writeToStorage(nextKey, queueRef.current)
      return
    }

    const loaded = loadFromStorage(nextKey)
    queueRef.current = loaded
    setQueue(loaded)
  }, [chatId])

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

  // Live mirror of `loadingState`, used by the pump to gate the next
  // dispatch on the chat actually being idle.
  const loadingStateRef = useRef<LoadingState>(loadingState)
  // Pending resolvers for `waitForIdle`. Resolved whenever the chat
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

  // Single-flight pump. While running, it owns the dispatch lifecycle and
  // drains the queue one message at a time. Awaiting `handleQuery`'s
  // promise is the only serialization signal we trust — it resolves
  // exactly once, when the stream we kicked off completes (success,
  // error, or abort).
  const pumpRunningRef = useRef(false)

  const runPump = useCallback(async (): Promise<void> => {
    if (pumpRunningRef.current) return
    pumpRunningRef.current = true
    try {
      while (queueRef.current.length > 0) {
        await waitForIdle()

        if (isRateLimitedRef.current()) {
          if (!rateLimitPromptShownRef.current) {
            rateLimitPromptShownRef.current = true
            onRateLimitedRef.current?.()
          }
          return
        }
        rateLimitPromptShownRef.current = false

        const [next, ...rest] = queueRef.current
        if (!next) break
        writeQueue(() => rest)
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
      pumpRunningRef.current = false
      // If something was enqueued while the pump was tearing down,
      // restart it on the next tick.
      if (queueRef.current.length > 0) {
        queueMicrotask(() => {
          void runPump()
        })
      }
    }
  }, [waitForIdle, writeQueue])

  const submit = useCallback(
    (input: QueueSubmitInput): void => {
      const item: QueuedMessage = {
        id: generateQueuedId(),
        text: input.text,
        attachments:
          input.attachments && input.attachments.length > 0
            ? input.attachments
            : undefined,
        quote: input.quote ?? undefined,
      }
      writeQueue((prev) => [...prev, item])
      void runPump()
    },
    [writeQueue, runPump],
  )

  // Restart the pump if there's something queued (e.g. left over in
  // sessionStorage from a previous session) and we're idle on mount or
  // after a chat switch.
  useEffect(() => {
    if (queue.length > 0 && !pumpRunningRef.current) {
      void runPump()
    }
  }, [queue, runPump])

  const removeQueuedMessage = useCallback(
    (id: string): void => {
      writeQueue((prev) => prev.filter((item) => item.id !== id))
    },
    [writeQueue],
  )

  return { queuedMessages: queue, submit, removeQueuedMessage }
}
