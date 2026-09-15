import { GENUI_WIDGETS } from '@/components/chat/genui/registry'
import type { Chat } from '@/components/chat/types'
import { ENCRYPTION_KEY_CHANGED_EVENT } from '@/services/encryption/encryption-service'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type SetStateAction,
} from 'react'
import { OptimisticStore } from './optimistic-store'
import { useHarness } from './provider'
import { initialChat, reduceEvent, type ChatState } from './reducer'
import { reportHarnessError, type HarnessAPI } from './runtime'
import { HarnessError } from './sse'
import type { Thread, ThreadSummary, Turn } from './types'
import { messageView, threadView } from './view-model'

const emptyData = () => ({
  state: initialChat(),
  threads: [] as ThreadSummary[],
  cursor: null as string | null,
  historyLoaded: false,
})
type ThreadData = ReturnType<typeof emptyData>
const histories = new WeakMap<
  HarnessAPI,
  Map<string, { data: OptimisticStore<ThreadData>; signal: AbortSignal }>
>()
function historyFor(api: HarnessAPI, projectId?: string | null) {
  let scopes = histories.get(api)
  if (!scopes) {
    scopes = new Map()
    histories.set(api, scopes)
  }
  const scope = projectId ?? ''
  const cached = scopes.get(scope)
  if (cached && !cached.signal.aborted) return cached.data
  const data = new OptimisticStore(emptyData())
  const signal = api.signal()
  signal.addEventListener('abort', () => data.reset(emptyData()), {
    once: true,
  })
  scopes.set(scope, { data, signal })
  return data
}
function invalidateOtherHistories(
  api: HarnessAPI,
  current: OptimisticStore<ThreadData>,
) {
  for (const cached of histories.get(api)?.values() ?? []) {
    if (cached.data !== current) cached.data.hasLoaded = false
  }
}

export function useThread(
  initialId?: string | null,
  projectId?: string | null,
  initiallyTemporary = false,
) {
  const { api, session, profile, keyReady } = useHarness()
  const data = useMemo(
    () => historyFor(api, projectId),
    // Reconnect to the new cache after a key change invalidates the old one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, projectId, keyReady],
  )
  const { state, threads, cursor, historyLoaded } = useSyncExternalStore(
    data.subscribe,
    data.getSnapshot,
    data.getSnapshot,
  )
  const setState = useCallback(
    (update: SetStateAction<ChatState>) =>
      data.set((value) => ({
        ...value,
        state: typeof update === 'function' ? update(value.state) : update,
      })),
    [data],
  )
  const current = useRef(state)
  current.current = data.getConfirmed().state
  const [id, setId] = useState<string | null>(null)
  const idRef = useRef(id)
  idRef.current = id
  const [temporary, setTemporary] = useState(initiallyTemporary || !api.userId)
  const [model, setModel] = useState('')
  const [presetId, setPresetId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const followers = useRef(new Set<AbortController>())
  const generation = useRef(0)
  const historyGeneration = useRef(0)
  const starting = useRef(false)
  const pending = useRef<Turn | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const storageKey = `harness-run:${api.userId ?? 'anonymous'}`
  const contentKey = () => api.key()
  const report = useCallback(
    (cause: unknown) => {
      if (
        api.lifetime.signal.aborted ||
        (cause instanceof DOMException && cause.name === 'AbortError')
      )
        return
      if (!mounted.current) {
        reportHarnessError(cause)
        return
      }
      if (cause instanceof HarnessError) {
        const next = {
          ...current.current,
          error: cause.detail,
        }
        current.current = next
        setState(next)
      }
      setError(
        cause instanceof Error
          ? cause.message
          : 'The connection failed. Reconnect to continue.',
      )
    },
    [api, setState],
  )
  const refresh = useCallback(
    async (next?: string) => {
      if (!api.userId || !keyReady) return
      const version = ++historyGeneration.current
      await data.read(
        async () => {
          const result = await api.post<{
            threads: ThreadSummary[]
            nextCursor: string | null
          }>('/v1/threads/list', { cursor: next, projectId, limit: 100 })
          if (version !== historyGeneration.current)
            throw new DOMException('History changed', 'AbortError')
          const previous = data.getConfirmed()
          return {
            ...previous,
            threads: next
              ? [
                  ...previous.threads,
                  ...result.threads.filter(
                    (t) => !previous.threads.some((p) => p.id === t.id),
                  ),
                ]
              : result.threads,
            cursor: result.nextCursor,
            historyLoaded: true,
          }
        },
        api.signal(),
        (current, incoming) => {
          if (version !== historyGeneration.current)
            throw new DOMException('History changed', 'AbortError')
          data.hasLoaded = true
          return { ...incoming, state: current.state }
        },
      )
      invalidateOtherHistories(api, data)
    },
    [api, data, keyReady, projectId],
  )
  const reset = useCallback(() => {
    generation.current++
    for (const controller of followers.current) controller.abort()
    followers.current.clear()
    current.current = initialChat()
    setState(current.current)
    idRef.current = null
    setId(null)
    setError('')
    starting.current = false
    pending.current = null
  }, [setState])
  async function stream(
    path: '/v1/threads/turn' | '/v1/threads/follow',
    input: Turn | { key?: string; threadId: string; runId: string },
    lastEventId?: number,
    previousMessages?: ChatState['messages'],
  ) {
    const controller = new AbortController()
    followers.current.add(controller)
    const version = generation.current
    let runId = 'runId' in input ? input.runId : undefined
    let succeeded = false
    let receivedMessages = false
    try {
      for await (const frame of api.client.events(
        path,
        input,
        api.signal(controller.signal),
        lastEventId,
      )) {
        if (version !== generation.current) break
        runId = frame.event.runId ?? runId
        const next = reduceEvent(current.current, frame, runId)
        if (frame.event.type === 'MESSAGES_SNAPSHOT') receivedMessages = true
        if (
          frame.event.type === 'RUN_ERROR' &&
          previousMessages &&
          !receivedMessages
        )
          next.messages = previousMessages
        current.current = next
        setState(next)
        if (frame.event.type === 'RUN_FINISHED')
          succeeded = frame.event.metadata?.cancelled !== true
        if (frame.event.type === 'RUN_STARTED') {
          data.hasLoaded = false
          invalidateOtherHistories(api, data)
          pending.current = null
          starting.current = false
          initial.current = frame.event.threadId!
          setId(frame.event.threadId!)
          idRef.current = frame.event.threadId!
          try {
            sessionStorage.setItem(
              storageKey,
              JSON.stringify({
                threadId: frame.event.threadId,
                runId,
                temporary,
              }),
            )
          } catch {
            /* routing hints are optional */
          }
        }
        if (
          frame.event.type === 'RUN_FINISHED' ||
          frame.event.type === 'RUN_ERROR'
        )
          void (api.userId ? refresh() : api.refresh()).catch(report)
      }
    } catch (cause) {
      if (!controller.signal.aborted && version === generation.current) {
        current.current = {
          ...current.current,
          status: 'error',
          messages:
            previousMessages && !receivedMessages
              ? previousMessages
              : current.current.messages,
        }
        setState(current.current)
        report(cause)
      }
    } finally {
      followers.current.delete(controller)
    }
    return succeeded && version === generation.current
  }
  async function open(threadId: string) {
    reset()
    const version = generation.current
    const cached = threads.find((thread) => thread.id === threadId)
    setId(threadId)
    idRef.current = threadId
    setTemporary(false)
    if (cached) {
      setState(initialChat({ ...cached, messages: [], hasOlder: false }))
      setModel(cached.model)
    }
    setLoading(true)
    try {
      const thread = await api.post<Thread>('/v1/threads/get', { id: threadId })
      if (version !== generation.current) return
      const next = initialChat(thread)
      current.current = next
      setState(next)
      setId(thread.id)
      idRef.current = thread.id
      setTemporary(false)
      setModel(thread.model)
      setPresetId(thread.presetId ?? null)
      if (thread.activeRun)
        void stream('/v1/threads/follow', {
          key: api.key(),
          threadId,
          runId: thread.activeRun.runId,
        })
    } finally {
      if (version === generation.current) setLoading(false)
    }
  }
  const initial = useRef<string | null>(null)
  useEffect(() => {
    if (session && !model)
      setModel(profile.selectedModel || session.defaultModel)
  }, [session, profile.selectedModel, model])
  useEffect(() => {
    const history = historyGeneration
    if (
      !historyLoaded ||
      !data.hasLoaded ||
      data.getSnapshot().threads.some((thread) => thread.activeRun)
    )
      void refresh().catch(report)
    return () => {
      history.current++
    }
  }, [data, historyLoaded, refresh, report])
  useEffect(() => {
    if (
      !initialId ||
      !keyReady ||
      initial.current === initialId ||
      idRef.current === initialId
    )
      return
    initial.current = initialId
    void open(initialId).catch(report)
    // Opening a route must not run again when its stream updates the view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialId, keyReady])
  useEffect(() => {
    const clear = () => {
      reset()
      historyGeneration.current++
      data.reset(emptyData())
      initial.current = null
      try {
        sessionStorage.removeItem(storageKey)
      } catch {
        /* optional routing hint */
      }
    }
    window.addEventListener(ENCRYPTION_KEY_CHANGED_EVENT, clear)
    return () => {
      window.removeEventListener(ENCRYPTION_KEY_CHANGED_EVENT, clear)
      reset()
    }
  }, [data, reset, storageKey])
  useEffect(() => {
    if (initialId || !session || (api.userId && !keyReady)) return
    try {
      const receipt = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null')
      if (
        typeof receipt?.threadId !== 'string' ||
        typeof receipt?.runId !== 'string'
      )
        return
      if (receipt.temporary) {
        setTemporary(true)
        setId(receipt.threadId)
        void stream('/v1/threads/follow', {
          key: api.key(),
          threadId: receipt.threadId,
          runId: receipt.runId,
        })
      }
    } catch {
      /* discard invalid routing hints */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, keyReady, !!session])
  function send(fields: Partial<Turn> = {}) {
    if (!idRef.current && starting.current) return
    setError('')
    const input: Turn = {
      key: contentKey(),
      threadId: idRef.current,
      clientRequestId: crypto.randomUUID(),
      kind: 'send',
      ephemeral: temporary,
      projectId: idRef.current ? undefined : projectId,
      presetId: idRef.current ? undefined : presetId,
      widgets: GENUI_WIDGETS.map((widget) => widget.name).filter((name) =>
        session?.widgets.includes(name),
      ),
      options: {
        model,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
      ...fields,
    }
    const previousMessages =
      input.kind === 'edit' || input.kind === 'regenerate'
        ? current.current.messages
        : undefined
    pending.current = { ...input, key: undefined }
    if (!idRef.current) starting.current = true
    if (
      current.current.status !== 'streaming' &&
      current.current.status !== 'queued'
    ) {
      let messages = current.current.messages
      if (input.kind === 'send') {
        messages = [
          ...messages,
          {
            id: `pending_${input.clientRequestId}`,
            role: 'user',
            content: input.content,
            quote: input.quote,
            createdAt: new Date().toISOString(),
          },
        ]
      } else if (input.kind === 'edit' || input.kind === 'regenerate') {
        const index = messages.findIndex(
          (message) => message.id === input.messageId,
        )
        if (index >= 0)
          messages =
            input.kind === 'edit'
              ? [
                  ...messages.slice(0, index),
                  { ...messages[index], content: input.content },
                ]
              : messages.slice(0, index)
      }
      current.current = {
        ...current.current,
        messages,
        status: 'streaming',
        error: undefined,
      }
      setState(current.current)
    }
    return stream('/v1/threads/turn', input, undefined, previousMessages)
  }
  async function update(threadId: string, patch: Record<string, unknown>) {
    const change = (
      value: ReturnType<typeof data.getSnapshot>,
      fields: Record<string, unknown>,
    ) => ({
      ...value,
      threads: value.threads.map((thread) =>
        thread.id === threadId ? { ...thread, ...fields } : thread,
      ),
      state:
        value.state.snapshot.thread?.id === threadId
          ? {
              ...value.state,
              snapshot: {
                ...value.state.snapshot,
                thread: { ...value.state.snapshot.thread, ...fields },
              },
            }
          : value.state,
    })
    const optimistic: Record<string, unknown> = {
      ...patch,
      ...(typeof patch.title === 'string' ? { titleState: 'manual' } : {}),
    }
    await data.mutate(
      (value) => change(value, optimistic),
      () =>
        api.post<ThreadSummary>('/v1/threads/update', {
          id: threadId,
          ...patch,
        }),
      api.signal(),
      (value, saved) =>
        change(
          value,
          Object.fromEntries(
            Object.keys(optimistic).map((key) => [
              key,
              (saved as unknown as Record<string, unknown>)[key] ??
                optimistic[key],
            ]),
          ),
        ),
    )
    invalidateOtherHistories(api, data)
  }
  async function remove(threadId: string) {
    const signal = api.signal()
    const previous = current.current
    const selected = idRef.current === threadId
    if (selected) reset()
    const version = generation.current
    try {
      await data.mutate(
        (value) => ({
          ...value,
          threads: value.threads.filter((thread) => thread.id !== threadId),
        }),
        () => api.post('/v1/threads/delete', { id: threadId }),
        signal,
      )
      invalidateOtherHistories(api, data)
    } catch (cause) {
      if (selected && version === generation.current && !signal.aborted) {
        current.current = previous
        setState(previous)
        setId(threadId)
        idRef.current = threadId
      }
      throw cause
    }
  }
  async function reconnect() {
    setError('')
    const runId =
      current.current.runId ?? current.current.snapshot.thread?.activeRun?.runId
    if (idRef.current && runId)
      return stream(
        '/v1/threads/follow',
        { key: contentKey(), threadId: idRef.current, runId },
        current.current.cursors[runId],
      )
    if (pending.current)
      return stream('/v1/threads/turn', {
        ...pending.current,
        key: contentKey(),
      })
    if (initialId) return open(initialId)
  }
  async function older() {
    if (!id) return
    const version = generation.current
    const thread = await api.post<Thread>('/v1/threads/get', {
      id,
      before: state.messages[0]?.id,
    })
    if (version === generation.current)
      setState((previous) => ({
        ...previous,
        messages: [
          ...thread.messages.filter(
            (m) => !previous.messages.some((p) => p.id === m.id),
          ),
          ...previous.messages,
        ],
        hasOlder: thread.hasOlder,
      }))
  }
  function queueAction(
    path: string,
    input: Record<string, unknown>,
    apply: (state: ChatState) => ChatState,
  ) {
    const version = generation.current
    const signal = api.signal()
    const body = { key: contentKey(), threadId: idRef.current, ...input }
    return data.mutate(
      (value) =>
        version === generation.current
          ? { ...value, state: apply(value.state) }
          : value,
      () => api.post(path, body, signal, false),
      signal,
    )
  }
  const running = state.status === 'streaming' || state.status === 'queued'
  const messages = state.messages.map((m, index) =>
    messageView(m, running && index === state.messages.length - 1),
  )
  const summary = state.snapshot.thread
  const chat: Chat = summary
    ? {
        ...threadView(summary, messages),
        isTemporary: temporary,
        presetId: presetId ?? undefined,
      }
    : {
        id: id ?? '',
        title: 'New Chat',
        messages,
        createdAt: new Date(),
        isBlankChat: !id,
        isTemporary: temporary,
        model,
        projectId: projectId ?? undefined,
        presetId: presetId ?? undefined,
      }
  return {
    api,
    state,
    chat,
    threads: projectId
      ? threads.filter((thread) => thread.projectId === projectId)
      : threads,
    chats: threads
      .filter((thread) => !projectId || thread.projectId === projectId)
      .map((t) => threadView(t)),
    model: state.snapshot.thread?.model ?? model,
    setModel,
    presetId:
      state.snapshot.thread && Object.hasOwn(state.snapshot.thread, 'presetId')
        ? ((state.snapshot.thread as Thread).presetId ?? null)
        : presetId,
    setPresetId,
    temporary,
    setTemporary,
    loading,
    error: error || state.error?.message || '',
    report,
    open,
    send,
    update,
    remove,
    refresh,
    reconnect,
    older,
    hasOlder: state.hasOlder,
    cursor,
    running,
    newChat: () => {
      initial.current = null
      reset()
      try {
        sessionStorage.removeItem(storageKey)
      } catch {
        /* optional */
      }
    },
    cancel: () =>
      queueAction(
        '/v1/threads/cancel',
        {
          runId:
            current.current.snapshot.thread?.activeRun?.runId ??
            current.current.runId,
        },
        (state) => ({ ...state, status: 'idle' }),
      ),
    sendQueued: (queueId: string) =>
      queueAction('/v1/threads/queue/send', { queueId }, (state) => ({
        ...state,
        snapshot: {
          ...state.snapshot,
          queue: state.snapshot.queue.filter(
            (item) => item.queueId !== queueId,
          ),
        },
      })),
    removeQueued: (queueId: string) =>
      queueAction('/v1/threads/queue/remove', { queueId }, (state) => ({
        ...state,
        snapshot: {
          ...state.snapshot,
          queue: state.snapshot.queue.filter(
            (item) => item.queueId !== queueId,
          ),
        },
      })),
    dismissError: () => {
      setError('')
      setState((previous) => ({ ...previous, error: undefined }))
    },
  }
}
