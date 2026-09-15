import { GENUI_WIDGETS } from '@/components/chat/genui/registry'
import type { Chat } from '@/components/chat/types'
import { ENCRYPTION_KEY_CHANGED_EVENT } from '@/services/encryption/encryption-service'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useHarness } from './provider'
import { initialChat, reduceEvent } from './reducer'
import { HarnessError } from './sse'
import type { Thread, ThreadSummary, Turn } from './types'
import { messageView, threadView } from './view-model'

export function useThread(
  initialId?: string | null,
  projectId?: string | null,
  initiallyTemporary = false,
) {
  const { api, session, profile, keyReady } = useHarness()
  const [state, setState] = useState(initialChat)
  const current = useRef(state)
  current.current = state
  const [id, setId] = useState<string | null>(null)
  const idRef = useRef(id)
  idRef.current = id
  const [temporary, setTemporary] = useState(initiallyTemporary || !api.userId)
  const [model, setModel] = useState('')
  const [presetId, setPresetId] = useState<string | null>(null)
  const [threads, setThreads] = useState<ThreadSummary[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const followers = useRef(new Set<AbortController>())
  const generation = useRef(0)
  const starting = useRef(false)
  const pending = useRef<Turn | null>(null)
  const storageKey = `harness-run:${api.userId ?? 'anonymous'}`
  const contentKey = () => api.key()
  const report = useCallback(
    (cause: unknown) => {
      if (
        api.lifetime.signal.aborted ||
        (cause instanceof DOMException && cause.name === 'AbortError')
      )
        return
      if (cause instanceof HarnessError) {
        const next = {
          ...current.current,
          error: cause.detail,
          status: 'error' as const,
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
    [api],
  )
  const refresh = useCallback(
    async (next?: string) => {
      if (!api.userId || !keyReady) return
      const version = generation.current
      const result = await api.post<{
        threads: ThreadSummary[]
        nextCursor: string | null
      }>('/v1/threads/list', { cursor: next, projectId, limit: 100 })
      if (version !== generation.current) return
      setThreads((previous) =>
        next
          ? [
              ...previous,
              ...result.threads.filter(
                (t) => !previous.some((p) => p.id === t.id),
              ),
            ]
          : result.threads,
      )
      setCursor(result.nextCursor)
    },
    [api, keyReady, projectId],
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
  }, [])
  async function stream(
    path: '/v1/threads/turn' | '/v1/threads/follow',
    input: Turn | { key?: string; threadId: string; runId: string },
    lastEventId?: number,
  ) {
    const controller = new AbortController()
    followers.current.add(controller)
    const version = generation.current
    let runId = 'runId' in input ? input.runId : undefined
    let succeeded = false
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
        current.current = next
        setState(next)
        if (frame.event.type === 'RUN_FINISHED')
          succeeded = frame.event.metadata?.cancelled !== true
        if (frame.event.type === 'RUN_STARTED') {
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
          void refresh().catch(report)
      }
    } catch (cause) {
      if (!controller.signal.aborted && version === generation.current)
        report(cause)
    } finally {
      followers.current.delete(controller)
    }
    return succeeded && version === generation.current
  }
  async function open(threadId: string) {
    reset()
    const version = generation.current
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
    void refresh().catch(report)
  }, [refresh, report])
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
      setThreads([])
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
  }, [reset, storageKey])
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
    pending.current = { ...input, key: undefined }
    if (!idRef.current) starting.current = true
    return stream('/v1/threads/turn', input)
  }
  async function update(threadId: string, patch: Record<string, unknown>) {
    const summary = await api.post<ThreadSummary>('/v1/threads/update', {
      id: threadId,
      ...patch,
    })
    setThreads((previous) =>
      previous.map((t) => (t.id === summary.id ? summary : t)),
    )
    if (idRef.current === threadId)
      setState((previous) => ({
        ...previous,
        snapshot: { ...previous.snapshot, thread: summary },
      }))
  }
  async function remove(threadId: string) {
    await api.post('/v1/threads/delete', { id: threadId })
    setThreads((previous) => previous.filter((t) => t.id !== threadId))
    if (idRef.current === threadId) reset()
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
    threads,
    chats: threads.map((t) => threadView(t)),
    model,
    setModel,
    presetId,
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
      api.post(
        '/v1/threads/cancel',
        {
          key: contentKey(),
          threadId: id,
          runId:
            current.current.snapshot.thread?.activeRun?.runId ??
            current.current.runId,
        },
        undefined,
        false,
      ),
    sendQueued: (queueId: string) =>
      api.post(
        '/v1/threads/queue/send',
        { key: contentKey(), threadId: id, queueId },
        undefined,
        false,
      ),
    removeQueued: (queueId: string) =>
      api.post(
        '/v1/threads/queue/remove',
        { key: contentKey(), threadId: id, queueId },
        undefined,
        false,
      ),
    dismissError: () => {
      setError('')
      setState((previous) => ({ ...previous, error: undefined }))
    },
  }
}
