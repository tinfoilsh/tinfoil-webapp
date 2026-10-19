import { MESSAGE_QUEUE_PREFIX } from '@/constants/storage-keys'
import { useCallback, useEffect, useRef, useState } from 'react'
import { isBlankQueueId } from '../message-queue-identity'
import type { Attachment, LoadingState, Message, QueuedMessage } from '../types'
import type { ChatDispatchResult } from './use-chat-messaging'

type HandleQuery = (
  query: string,
  attachments?: Attachment[],
  systemPromptOverride?: string,
  baseMessages?: Message[],
  quote?: string,
  onReadyForNextMessage?: () => void,
) => void | ChatDispatchResult | Promise<void | ChatDispatchResult>

export type QueueSubmitInput = {
  text: string
  attachments?: Attachment[]
  quote?: string
}

type UseMessageQueueArgs = {
  chatId: string | null | undefined
  queueId?: string | null
  persistQueue?: boolean
  loadingState: LoadingState
  handleQuery: HandleQuery
  isRateLimited: () => boolean
  isDispatchBlocked?: () => boolean
  dispatchBlocked?: boolean
  onRateLimited?: () => void
  cancelGeneration?: (chatId?: string) => void | Promise<void>
}

type UseMessageQueueReturn = {
  queuedMessages: QueuedMessage[]
  submit: (input: QueueSubmitInput) => void
  removeQueuedMessage: (id: string) => void
  clearQueuedMessages: () => void
  sendQueuedMessage: (id: string) => void
  notifyGenerationCancelled: (chatId: string) => void
}

export class QueueIdentifierUnavailableError extends Error {
  constructor() {
    super('Secure queue identifier generation is unavailable')
    this.name = 'QueueIdentifierUnavailableError'
  }
}

const isBrowser = typeof window !== 'undefined'

function storageKeyFor(
  queueId: string | null | undefined,
  persistQueue: boolean,
): string | null {
  return persistQueue && queueId && !isBlankQueueId(queueId)
    ? `${MESSAGE_QUEUE_PREFIX}${queueId}`
    : null
}

function generateQueuedId(): string {
  if (
    typeof crypto === 'undefined' ||
    typeof crypto.randomUUID !== 'function'
  ) {
    throw new QueueIdentifierUnavailableError()
  }
  return crypto.randomUUID()
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
 *   end-to-end. It awaits either `handleQuery`'s returned promise or its
 *   explicit ready-for-next-message signal, emitted after the response is
 *   fully visible. Stale `loadingState` writes from a previously-cancelled
 *   stream can't trigger anything because nothing observes them.
 *
 * Cancellation (Stop button):
 *
 *   A cancelled stream's promise is not guaranteed to settle (cleanup can
 *   hang), which would wedge the pump forever. Callers report explicit
 *   cancellations via `notifyGenerationCancelled(chatId)`; the pump races
 *   its dispatch await against that signal, abandons the dead promise,
 *   and resumes draining once the chat settles back to idle. This is an
 *   explicit structured signal, not a `loadingState` heuristic, so stale
 *   idle writes still can't cause a parallel dispatch.
 */
export function useMessageQueue({
  chatId,
  queueId = chatId,
  persistQueue = true,
  loadingState,
  handleQuery,
  isRateLimited,
  isDispatchBlocked,
  dispatchBlocked = false,
  onRateLimited,
  cancelGeneration,
}: UseMessageQueueArgs): UseMessageQueueReturn {
  // Per-chat queues so several conversations can hold pending messages at
  // once. Hydrated lazily from sessionStorage on first access.
  const queuesRef = useRef<Map<string, QueuedMessage[]>>(new Map())
  const persistentQueueIdsRef = useRef<Map<string, boolean>>(new Map())
  if (queueId != null) {
    persistentQueueIdsRef.current.set(queueId, persistQueue)
  }

  const getQueue = useCallback(
    (id: string | null | undefined): QueuedMessage[] => {
      // Only null/undefined means "no chat". A blank chat has an empty
      // string id (see createBlankChat) and is a valid, queueable target;
      // its messages live in memory only since storageKeyFor('') is null.
      if (id == null) return []
      let q = queuesRef.current.get(id)
      if (!q) {
        q = loadFromStorage(
          storageKeyFor(id, persistentQueueIdsRef.current.get(id) !== false),
        )
        queuesRef.current.set(id, q)
      }
      return q
    },
    [],
  )

  // Mirror of the active chat id for reads inside stable callbacks.
  const currentChatIdRef = useRef<string | null | undefined>(chatId)
  currentChatIdRef.current = chatId
  const currentQueueIdRef = useRef<string | null | undefined>(queueId)
  currentQueueIdRef.current = queueId

  // Rendered queue tracks the chat on screen.
  const [queue, setQueue] = useState<QueuedMessage[]>(() => getQueue(queueId))

  const setQueueFor = useCallback((id: string, next: QueuedMessage[]) => {
    queuesRef.current.set(id, next)
    const shouldPersist = persistentQueueIdsRef.current.get(id) !== false
    writeToStorage(storageKeyFor(id, shouldPersist), next)
    if (!shouldPersist) {
      writeToStorage(storageKeyFor(id, true), [])
    }
    if (id === currentQueueIdRef.current) setQueue(next)
  }, [])

  // Latest-value mirrors so the async pump always calls the current
  // handlers (in particular handleQuery, which is bound to the chat on
  // screen) without being re-created on every render. Assigned during
  // render so they can never be stale relative to currentChatIdRef when the
  // pump dispatches in a microtask (an effect would lag a paint behind).
  const handleQueryRef = useRef(handleQuery)
  const isRateLimitedRef = useRef(isRateLimited)
  const isDispatchBlockedRef = useRef(isDispatchBlocked)
  const onRateLimitedRef = useRef(onRateLimited)
  const cancelGenerationRef = useRef(cancelGeneration)
  handleQueryRef.current = handleQuery
  isRateLimitedRef.current = isRateLimited
  isDispatchBlockedRef.current = isDispatchBlocked
  onRateLimitedRef.current = onRateLimited
  cancelGenerationRef.current = cancelGeneration

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

  // Resolvers armed while a pump awaits a dispatch, keyed by chat id.
  // Fired by `notifyGenerationCancelled` so a cancelled stream whose
  // promise never settles can't wedge the pump.
  const cancelWaitersRef = useRef<Map<string, Set<() => void>>>(new Map())

  const notifyGenerationCancelled = useCallback((id: string): void => {
    const queueKey =
      id === currentChatIdRef.current ? currentQueueIdRef.current : id
    if (queueKey == null) return
    const waiters = cancelWaitersRef.current.get(queueKey)
    if (!waiters) return
    cancelWaitersRef.current.delete(queueKey)
    for (const resolve of waiters) resolve()
  }, [])

  // Resolves when the given chat's generation is explicitly cancelled.
  // `arm` registers the resolver; callers must `disarm` after the race so
  // abandoned resolvers don't accumulate.
  const armCancelWaiter = useCallback(
    (id: string): { promise: Promise<void>; disarm: () => void } => {
      let resolver!: () => void
      const promise = new Promise<void>((resolve) => {
        resolver = resolve
      })
      let set = cancelWaitersRef.current.get(id)
      if (!set) {
        set = new Set()
        cancelWaitersRef.current.set(id, set)
      }
      set.add(resolver)
      // Scan every entry rather than only `id`: a blank chat's waiters get
      // re-keyed to the real id mid-dispatch (see the chat-sync effect).
      const disarm = () => {
        for (const [key, current] of cancelWaitersRef.current) {
          if (current.delete(resolver) && current.size === 0) {
            cancelWaitersRef.current.delete(key)
          }
        }
      }
      return { promise, disarm }
    },
    [],
  )

  // One single-flight pump per chat. Dispatch always targets the chat on
  // screen (handleQuery is bound to it), so the pump only proceeds while
  // its chat is active and stops otherwise, leaving the queue to resume
  // when the chat is reopened.
  // Active pumps keyed by their current chat id. Each holds a mutable `id`
  // so a blank chat's pump can follow the conversion to a real id (see the
  // re-key in the chat-sync effect) instead of staying parked on the shared
  // blank id ('') and blocking the next new chat.
  const pumpsRef = useRef<Map<string, { id: string }>>(new Map())
  const rejectedQueuesRef = useRef<Set<string>>(new Set())
  const blockedQueuesRef = useRef<Set<string>>(new Set())

  const runPump = useCallback(
    async (startId: string): Promise<void> => {
      if (startId == null) return
      if (
        rejectedQueuesRef.current.has(startId) ||
        blockedQueuesRef.current.has(startId)
      )
        return
      if (pumpsRef.current.has(startId)) return
      const pump = { id: startId }
      pumpsRef.current.set(startId, pump)
      let rejectedBeforeDispatch = false
      try {
        while (getQueue(pump.id).length > 0) {
          // Only the chat on screen can dispatch; pause otherwise.
          if (pump.id !== currentQueueIdRef.current) return
          await waitForIdle()
          if (pump.id !== currentQueueIdRef.current) return

          if (isRateLimitedRef.current()) {
            if (!rateLimitPromptShownRef.current) {
              rateLimitPromptShownRef.current = true
              onRateLimitedRef.current?.()
            }
            return
          }
          rateLimitPromptShownRef.current = false
          if (isDispatchBlockedRef.current?.()) return

          const [next, ...rest] = getQueue(pump.id)
          if (!next) break
          setQueueFor(pump.id, rest)

          try {
            let markReadyForNextMessage!: () => void
            const readyForNextMessage = new Promise<void>((resolve) => {
              markReadyForNextMessage = resolve
            })
            const result = handleQueryRef.current(
              next.text,
              next.attachments,
              undefined,
              undefined,
              next.quote,
              markReadyForNextMessage,
            )
            let dispatchResult: void | ChatDispatchResult = undefined
            if (
              result &&
              typeof (result as Promise<unknown>).then === 'function'
            ) {
              // Race the dispatch against an explicit cancellation signal:
              // a cancelled stream's promise may never settle, and without
              // the race the pump would wedge on it and stop draining.
              const cancelWaiter = armCancelWaiter(pump.id)
              try {
                const settled = await Promise.race([
                  (result as Promise<void | ChatDispatchResult>)
                    .then((value) => ({ type: 'result' as const, value }))
                    .catch(() => ({ type: 'error' as const })),
                  cancelWaiter.promise.then(() => ({
                    type: 'cancelled' as const,
                  })),
                  readyForNextMessage.then(() => ({
                    type: 'ready' as const,
                  })),
                ])
                if (settled.type === 'result') {
                  dispatchResult = settled.value
                }
              } finally {
                cancelWaiter.disarm()
              }
            } else {
              dispatchResult = result as void | ChatDispatchResult
            }
            if (
              dispatchResult?.status === 'not-started' &&
              dispatchResult.reason !== 'chat-deleted'
            ) {
              setQueueFor(pump.id, [next, ...getQueue(pump.id)])
              if (dispatchResult.reason === 'chat-unavailable') {
                rejectedQueuesRef.current.add(pump.id)
              } else {
                blockedQueuesRef.current.add(pump.id)
              }
              rejectedBeforeDispatch = true
              return
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
          pump.id === currentQueueIdRef.current &&
          getQueue(pump.id).length > 0 &&
          !rejectedBeforeDispatch &&
          !isRateLimitedRef.current() &&
          !isDispatchBlockedRef.current?.()
        ) {
          queueMicrotask(() => {
            void runPump(pump.id)
          })
        }
      }
    },
    [getQueue, setQueueFor, waitForIdle, armCancelWaiter],
  )

  // When the rate limit clears, reset the one-shot prompt latch and resume
  // the active chat's queue (the pump bails out while rate-limited rather
  // than busy-waiting). Runs whenever the rate-limit predicate changes.
  useEffect(() => {
    if (!isRateLimited()) {
      rateLimitPromptShownRef.current = false
      const id = currentQueueIdRef.current
      if (id != null && getQueue(id).length > 0) {
        void runPump(id)
      }
    }
  }, [isRateLimited, getQueue, runPump])

  const previousDispatchBlockedRef = useRef(dispatchBlocked)
  useEffect(() => {
    const wasBlocked = previousDispatchBlockedRef.current
    previousDispatchBlockedRef.current = dispatchBlocked
    if (dispatchBlocked) return
    const id = currentQueueIdRef.current
    if (id != null && getQueue(id).length > 0) {
      if (wasBlocked) blockedQueuesRef.current.delete(id)
      void runPump(id)
    }
  }, [dispatchBlocked, getQueue, runPump])

  const submit = useCallback(
    (input: QueueSubmitInput): void => {
      const id = currentQueueIdRef.current
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
      rejectedQueuesRef.current.delete(id)
      blockedQueuesRef.current.delete(id)
      setQueueFor(id, [...getQueue(id), item])
      void runPump(id)
    },
    [getQueue, setQueueFor, runPump],
  )

  // Tracks the previously-rendered chat id so we can detect a blank chat
  // being converted to a real id (a brand-new conversation getting its
  // server/local id on its first message).
  const prevChatIdRef = useRef<string | null | undefined>(chatId)
  const prevQueueIdRef = useRef<string | null | undefined>(queueId)
  const prevPersistQueueRef = useRef(persistQueue)

  // Sync the rendered queue to the active chat and resume draining it (e.g.
  // messages left in sessionStorage, or queued while the chat was in the
  // background). Runs on mount and on every chat switch.
  useEffect(() => {
    const prev = prevChatIdRef.current
    const previousQueueId = prevQueueIdRef.current
    const previousPersistQueue = prevPersistQueueRef.current
    prevChatIdRef.current = chatId
    prevQueueIdRef.current = queueId
    prevPersistQueueRef.current = persistQueue

    if (queueId != null && !persistQueue) {
      writeToStorage(storageKeyFor(queueId, true), [])
    }

    if (
      previousQueueId != null &&
      !previousPersistQueue &&
      (previousQueueId !== queueId || persistQueue)
    ) {
      queuesRef.current.delete(previousQueueId)
      persistentQueueIdsRef.current.delete(previousQueueId)
      rejectedQueuesRef.current.delete(previousQueueId)
      blockedQueuesRef.current.delete(previousQueueId)
      writeToStorage(storageKeyFor(previousQueueId, true), [])
    }

    // Blank chats all share the empty-string id. When one converts to a
    // real id, re-key its in-flight pump and queue so the freed blank id is
    // immediately available to the next new chat. Only blank ('') ids are
    // transient and reused this way, so this never fires on a plain switch
    // between existing chats.
    if (
      prev === '' &&
      previousQueueId != null &&
      chatId != null &&
      chatId !== '' &&
      pumpsRef.current.has(previousQueueId)
    ) {
      const pump = pumpsRef.current.get(previousQueueId)
      const pending = queuesRef.current.get(previousQueueId)
      if (pending && pending.length > 0) {
        queuesRef.current.set(chatId, [
          ...(queuesRef.current.get(chatId) ?? []),
          ...pending,
        ])
        writeToStorage(
          storageKeyFor(
            chatId,
            persistentQueueIdsRef.current.get(chatId) !== false,
          ),
          queuesRef.current.get(chatId)!,
        )
      }
      queuesRef.current.delete(previousQueueId)
      if (pump) {
        pump.id = chatId
        pumpsRef.current.delete(previousQueueId)
        pumpsRef.current.set(chatId, pump)
      }
      // Follow the conversion for armed cancel waiters too, so a Stop on
      // the (now real) chat still unwedges a dispatch started while blank.
      const cancelWaiters = cancelWaitersRef.current.get(previousQueueId)
      if (cancelWaiters) {
        cancelWaitersRef.current.delete(previousQueueId)
        const existing = cancelWaitersRef.current.get(chatId)
        if (existing) {
          for (const waiter of cancelWaiters) existing.add(waiter)
        } else {
          cancelWaitersRef.current.set(chatId, cancelWaiters)
        }
      }
    }

    setQueue(getQueue(queueId))
    if (queueId != null && getQueue(queueId).length > 0) {
      void runPump(queueId)
    }
  }, [chatId, queueId, persistQueue, getQueue, runPump])

  const removeQueuedMessage = useCallback(
    (queuedId: string): void => {
      const id = currentQueueIdRef.current
      if (id == null) return
      setQueueFor(
        id,
        getQueue(id).filter((item) => item.id !== queuedId),
      )
    },
    [getQueue, setQueueFor],
  )

  const clearQueuedMessages = useCallback((): void => {
    const id = currentQueueIdRef.current
    if (id == null) return
    setQueueFor(id, [])
  }, [setQueueFor])

  // Explicit "send now" for a single queued message: promote it to the
  // front of the queue and let the pump dispatch it, so every send stays
  // serialized and the rest of the queue keeps draining afterwards. The
  // cancel signal unwedges a pump parked on a dead dispatch (making the
  // button work even then), and when the chat is still busy the active
  // stream is cancelled so the promoted message goes out as soon as the
  // chat settles back to idle. Dispatching straight into a busy chat is
  // never attempted since handleQuery's busy guard would silently drop
  // the message.
  const sendQueuedMessage = useCallback(
    (queuedId: string): void => {
      const id = currentQueueIdRef.current
      if (id == null) return
      const currentQueue = getQueue(id)
      const item = currentQueue.find((m) => m.id === queuedId)
      if (!item) return

      setQueueFor(id, [item, ...currentQueue.filter((m) => m.id !== queuedId)])
      rejectedQueuesRef.current.delete(id)
      blockedQueuesRef.current.delete(id)
      notifyGenerationCancelled(id)
      if (loadingStateRef.current !== 'idle') {
        void cancelGenerationRef.current?.(
          currentChatIdRef.current ?? undefined,
        )
      }
      void runPump(id)
    },
    [getQueue, setQueueFor, runPump, notifyGenerationCancelled],
  )

  return {
    queuedMessages: queue,
    submit,
    removeQueuedMessage,
    clearQueuedMessages,
    sendQueuedMessage,
    notifyGenerationCancelled,
  }
}
