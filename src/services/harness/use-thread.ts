import { GENUI_WIDGETS } from '@/components/chat/genui/registry'
import type { Chat, Attachment as UIAttachment } from '@/components/chat/types'
import { ENCRYPTION_KEY_CHANGED_EVENT } from '@/services/encryption/encryption-service'
import { chatEvents } from '@/services/storage/chat-events'
import { buildForkedChat } from '@/services/storage/chat-fork'
import { base64ToUint8Array, uint8ArrayToBase64 } from '@/utils/binary-codec'
import { logError } from '@/utils/error-handling'
import { generateReverseId } from '@/utils/reverse-id'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { turnProfile } from './local-profile'
import {
  committedReplies,
  localAttachment,
  localDocumentText,
  localThreadStore,
  localThreadView,
  memoryThreadStore,
  mergeLocalThread,
  newLocalThread,
  now,
  readLocalThread,
  shareThread,
  turnThread,
  wireMessage,
  type LocalAttachment,
  type LocalThread,
  type LocalThreadStore,
} from './local-threads'
import { useHarness } from './provider'
import { initialChat, reduceEvent, type ChatState } from './reducer'
import type { RunSpend } from './runtime'
import { MAX_SHARE_REQUEST_BYTES, requestBytes, shareTooLarge } from './shares'
import { HarnessError } from './sse'
import { useCloudSyncSetting } from './storage-mode'
import type {
  Frame,
  RateLimit,
  Thread,
  ThreadSummary,
  Turn,
  Attachment as WireAttachment,
} from './types'
import { messageView, threadView } from './view-model'

export interface ThreadRoute {
  // The route names a chat stored on this device (/chat/local/:id).
  local?: boolean
  // A new chat starts on this device, as from the sidebar's Local tab.
  newChatLocal?: boolean
}

// A run of a thread the browser stores. It keeps the transcript it sent, so
// the run's window can be merged back, and the descriptors of new uploads.
interface LocalRun {
  threadId: string
  base: LocalThread
  store: LocalThreadStore
  uploads: ReadonlyMap<string, LocalAttachment>
  runId?: string
}

type FollowInput = { key?: string; threadId: string; runId: string }

// The quota a refusal for an exhausted quota describes.
function exhaustedQuota({
  kind,
  resetsAt,
  retryAfter,
}: {
  kind?: string
  resetsAt?: string
  retryAfter?: number
}): RateLimit | undefined {
  if (kind !== 'hourly' && kind !== 'free_daily') return undefined
  const reset =
    resetsAt ||
    (retryAfter
      ? new Date(Date.now() + retryAfter * 1000).toISOString()
      : undefined)
  return {
    kind,
    maxRequests: 0,
    remaining: 0,
    ...(reset ? { resetsAt: reset } : {}),
  }
}

function runSpend(value: unknown): RunSpend | undefined {
  if (!value || typeof value !== 'object') return undefined
  const { prompt_tokens: prompt, completion_tokens: completion } =
    value as Record<string, unknown>
  return typeof prompt === 'number' && typeof completion === 'number'
    ? { prompt, completion }
    : undefined
}

function withStoredPrefix(state: ChatState, base: LocalThread): ChatState {
  if (!state.hasOlder) return state
  const index = base.messages.findIndex(
    (message) => message.id === state.messages[0]?.id,
  )
  if (index <= 0) return state
  return {
    ...state,
    messages: [
      ...base.messages.slice(0, index).map(wireMessage),
      ...state.messages,
    ],
    hasOlder: false,
  }
}

export function useThread(
  initialId?: string | null,
  projectId?: string | null,
  route: ThreadRoute = {},
) {
  const { api, session, profile, keyReady } = useHarness()
  const cloudSyncSetting = useCloudSyncSetting()
  const cloud = !!api.userId && cloudSyncSetting
  const cloudRef = useRef(cloud)
  cloudRef.current = cloud
  const profileRef = useRef(profile)
  profileRef.current = profile
  const [state, setState] = useState(initialChat)
  const current = useRef(state)
  current.current = state
  const [id, setId] = useState<string | null>(null)
  const idRef = useRef(id)
  idRef.current = id
  const [temporary, setTemporary] = useState(false)
  const temporaryRef = useRef(temporary)
  temporaryRef.current = temporary
  // Whether the open chat is a thread the browser stores: every chat of a
  // signed-out visitor or of an account without cloud sync, and chats from
  // the Local tab. A temporary chat without cloud sync is one too, with its
  // transcript held in memory.
  const [local, setLocal] = useState(
    () => !cloud || !!route.local || !!route.newChatLocal,
  )
  const localRef = useRef(local)
  localRef.current = local
  const [model, setModel] = useState('')
  const [presetId, setPresetId] = useState<string | null>(null)
  const [threads, setThreads] = useState<ThreadSummary[]>([])
  const [localThreads, setLocalThreads] = useState<ThreadSummary[]>([])
  const localIds = useRef(new Set<string>())
  localIds.current = new Set(localThreads.map((thread) => thread.id))
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [notFound, setNotFound] = useState(false)
  // A new local chat until its first save lands. Its route waits, since
  // opening the route before then would find nothing on the device.
  const [unsaved, setUnsaved] = useState<string | null>(null)
  const [error, setError] = useState('')
  // When the current error happened, so a wait the harness asks for counts
  // from then.
  const errorAt = useRef(0)
  // The kind of the last turn sent, and the reply a continuation extends.
  const lastTurn = useRef<Pick<Turn, 'kind' | 'messageId'> | null>(null)
  const followers = useRef(new Set<AbortController>())
  const localRuns = useRef(new Map<string, LocalRun>())
  const generation = useRef(0)
  const starting = useRef(false)
  const pending = useRef<{ input: Turn; run?: LocalRun } | null>(null)
  const uploads = useRef(new Map<string, LocalAttachment>())
  const images = useRef(
    new Map<string, { base64: string; mimeType?: string }>(),
  )
  const documentTexts = useRef(new Map<string, Promise<string>>())
  const store = useMemo(
    () => localThreadStore(api.userId ? 'device' : 'tab'),
    [api.userId],
  )
  const memory = useRef(memoryThreadStore())
  const storeFor = (isTemporary: boolean) =>
    isTemporary ? memory.current : store
  const runsLocally = () => localRef.current
  const storageKey = `harness-run:${api.userId ?? 'anonymous'}`
  const contentKey = () => api.key()
  const report = useCallback(
    (cause: unknown) => {
      if (
        api.lifetime.signal.aborted ||
        (cause instanceof DOMException && cause.name === 'AbortError')
      )
        return
      errorAt.current = Date.now()
      if (cause instanceof HarnessError) {
        const next = {
          ...current.current,
          error: cause.detail,
          status: 'error' as const,
        }
        current.current = next
        setState(next)
        if (cause.code === 'QUOTA_EXHAUSTED')
          api.reportRateLimit(exhaustedQuota(cause.detail))
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
      if (!cloud || !keyReady) return
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
    [api, cloud, keyReady, projectId],
  )
  const rememberImages = (thread: LocalThread) => {
    for (const message of thread.messages)
      for (const attachment of message.attachments ?? [])
        if (attachment.base64)
          images.current.set(attachment.id, {
            base64: attachment.base64,
            mimeType: attachment.mimeType,
          })
  }
  const reset = useCallback(() => {
    generation.current++
    for (const controller of followers.current) controller.abort()
    followers.current.clear()
    current.current = initialChat()
    setState(current.current)
    idRef.current = null
    setId(null)
    setError('')
    setNotFound(false)
    setUnsaved(null)
    starting.current = false
    pending.current = null
    uploads.current = new Map()
    images.current = new Map()
    documentTexts.current = new Map()
  }, [])
  // The stored transcript with what the view knows of the current run, which
  // may not be saved yet. A new chat starts from an empty thread.
  async function localTranscript(
    threadId: string,
    target: LocalThreadStore,
  ): Promise<LocalThread> {
    const stored =
      (await target.get(threadId)) ??
      newLocalThread(threadId, {
        model,
        presetId: presetId ?? undefined,
      })
    if (idRef.current !== threadId) return stored
    return mergeLocalThread(
      stored,
      {
        messages: current.current.messages,
        hasOlder: current.current.hasOlder,
      },
      {
        uploads: uploads.current,
        summary: current.current.snapshot.thread,
        updatedAt: stored.updatedAt,
      },
    )
  }
  async function persist(run: LocalRun, view: ChatState, frame: Frame) {
    const terminal =
      frame.event.type === 'RUN_FINISHED' || frame.event.type === 'RUN_ERROR'
    const saved = await run.store.update(run.threadId, (stored) =>
      mergeLocalThread(
        stored ?? run.base,
        { messages: view.messages, hasOlder: view.hasOlder },
        {
          uploads: run.uploads,
          replies: terminal ? committedReplies(frame.event.metadata) : [],
          summary: view.snapshot.thread,
        },
      ),
    )
    if (saved)
      setUnsaved((threadId) => (threadId === saved.id ? null : threadId))
    if (saved && idRef.current === run.threadId) {
      rememberImages(saved)
      // A title the user set during the run outranks the run's title.
      if (terminal && saved.titleState === 'manual')
        setState((previous) =>
          previous.snapshot.thread
            ? {
                ...previous,
                snapshot: {
                  ...previous.snapshot,
                  thread: {
                    ...previous.snapshot.thread,
                    title: saved.title,
                    titleState: saved.titleState,
                  },
                },
              }
            : previous,
        )
    }
  }
  async function stream(
    path: '/v1/threads/turn' | '/v1/threads/follow',
    input: Turn | FollowInput,
    lastEventId?: number,
    run?: LocalRun,
    quiet = false,
  ) {
    const controller = new AbortController()
    // A run the browser stores keeps reading when the view moves to another
    // chat, or the page to another route, so its reply is still saved. An
    // account change ends it with the API's lifetime.
    if (!run) followers.current.add(controller)
    const version = generation.current
    let runId = 'runId' in input ? input.runId : undefined
    let succeeded = false
    let windowed = false
    let view = current.current
    try {
      for await (const frame of api.client.events(
        path,
        input,
        api.signal(controller.signal, !run),
        lastEventId,
      )) {
        const attached = version === generation.current
        if (!attached && !run) break
        runId = frame.event.runId ?? runId
        const base = attached ? current.current : view
        let next = reduceEvent(base, frame, runId)
        const event = frame.event
        // A replayed frame leaves the view as it was.
        if (next !== base) {
          reportQuota(event)
          if (event.type === 'RUN_ERROR' && attached)
            errorAt.current = Date.now()
        }
        if (run && event.type === 'MESSAGES_SNAPSHOT')
          next = withStoredPrefix(next, run.base)
        view = next
        if (attached) {
          current.current = next
          setState(next)
        }
        const terminal =
          event.type === 'RUN_FINISHED' || event.type === 'RUN_ERROR'
        if (event.type === 'RUN_FINISHED')
          succeeded = event.metadata?.cancelled !== true
        if (event.type === 'MESSAGES_SNAPSHOT') windowed = true
        if (event.type === 'RUN_STARTED') {
          if (run) {
            if (event.threadId && event.threadId !== run.threadId) {
              run.threadId = event.threadId
              run.base = { ...run.base, id: event.threadId }
            }
            run.runId = event.runId
            localRuns.current.set(run.threadId, run)
          }
          if (attached) {
            pending.current = null
            starting.current = false
            initial.current = event.threadId!
            setId(event.threadId!)
            idRef.current = event.threadId!
            try {
              sessionStorage.setItem(
                storageKey,
                JSON.stringify({
                  threadId: event.threadId,
                  runId,
                  temporary,
                  ...(run ? { local: true } : {}),
                }),
              )
            } catch {
              /* routing hints are optional */
            }
          }
        }
        // A run has committed nothing until its first window arrives.
        if (run && windowed && (event.type === 'MESSAGES_SNAPSHOT' || terminal))
          await persist(run, next, frame).catch((cause) => {
            logError('Failed to save a local chat', cause, {
              component: 'useThread',
              action: 'persist',
            })
            if (attached)
              setError('This chat could not be saved on this device.')
          })
        if (terminal) {
          if (run && localRuns.current.get(run.threadId) === run)
            localRuns.current.delete(run.threadId)
          if (run) forgetReceipt(run.threadId)
          void (api.userId ? refresh() : api.refresh()).catch(report)
        }
      }
    } catch (cause) {
      if (!controller.signal.aborted && version === generation.current) {
        // A local thread has its id before it starts, so another message may
        // follow a turn the harness did not accept.
        if (run && !run.runId) starting.current = false
        if (quiet) forgetReceipt(run?.threadId)
        else report(cause)
      }
    } finally {
      followers.current.delete(controller)
    }
    return succeeded && version === generation.current
  }
  // The quota a run reports, and its spend once it finishes.
  function reportQuota(event: Frame['event']) {
    if (event.type === 'STATE_SNAPSHOT')
      api.reportRateLimit(event.snapshot?.rateLimit)
    else if (event.type === 'RUN_FINISHED' || event.type === 'RUN_ERROR')
      api.reportRateLimit(
        event.metadata?.rateLimit as RateLimit | undefined,
        runSpend(event.metadata?.usage),
      )
    if (event.type === 'RUN_ERROR' && event.code === 'QUOTA_EXHAUSTED')
      api.reportRateLimit(exhaustedQuota(event))
  }
  function forgetReceipt(threadId?: string) {
    try {
      const receipt = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null')
      if (receipt?.local && receipt.threadId === threadId)
        sessionStorage.removeItem(storageKey)
    } catch {
      /* optional routing hint */
    }
  }
  // Rejoins a run of a stored chat: one this page started, or one a
  // reloaded page left behind, so its reply is still saved.
  function resumeLocalRun(thread: LocalThread) {
    let runId = localRuns.current.get(thread.id)?.runId
    if (!runId)
      try {
        const receipt = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null')
        if (receipt?.local && receipt.threadId === thread.id)
          runId = receipt.runId
      } catch {
        /* discard invalid routing hints */
      }
    if (typeof runId !== 'string') return
    void stream(
      '/v1/threads/follow',
      { threadId: thread.id, runId },
      undefined,
      { threadId: thread.id, base: thread, store, uploads: new Map() },
      true,
    )
  }
  async function openLocal(threadId: string, version: number) {
    const thread = await store.get(threadId)
    if (version !== generation.current) return
    setTemporary(false)
    setLocal(true)
    if (!thread) {
      setNotFound(true)
      return
    }
    rememberImages(thread)
    const next = initialChat(localThreadView(thread))
    current.current = next
    setState(next)
    setId(thread.id)
    idRef.current = thread.id
    setModel(thread.model ?? '')
    setPresetId(thread.presetId ?? null)
    resumeLocalRun(thread)
  }
  async function open(threadId: string, options: { local?: boolean } = {}) {
    const openLocally =
      options.local ?? (!cloudRef.current || localIds.current.has(threadId))
    reset()
    const version = generation.current
    setLoading(true)
    try {
      if (openLocally) return await openLocal(threadId, version)
      const thread = await api.post<Thread>('/v1/threads/get', { id: threadId })
      if (version !== generation.current) return
      const next = initialChat(thread)
      current.current = next
      setState(next)
      setId(thread.id)
      idRef.current = thread.id
      setTemporary(false)
      setLocal(false)
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
    let sequence = 0
    const load = () => {
      const request = ++sequence
      void store
        .list()
        .then((list) => {
          if (request === sequence) setLocalThreads(list)
        })
        .catch((cause) =>
          logError('Failed to list local chats', cause, {
            component: 'useThread',
            action: 'listLocal',
          }),
        )
    }
    load()
    return chatEvents.on(load)
  }, [store])
  const previousCloud = useRef(cloud)
  useEffect(() => {
    if (previousCloud.current === cloud) return
    previousCloud.current = cloud
    if (!cloud) setThreads([])
    // A blank chat follows the storage mode; a stored chat of the harness
    // cannot stay open once cloud sync is off.
    if (!idRef.current) setLocal(!cloud || !!route.newChatLocal)
    else if (!cloud && !localRef.current) {
      reset()
      setLocal(true)
    }
  }, [cloud, reset, route.newChatLocal])
  useEffect(() => {
    if (
      !initialId ||
      initial.current === initialId ||
      idRef.current === initialId
    )
      return
    if (!route.local && !keyReady) return
    initial.current = initialId
    void open(initialId, { local: !!route.local }).catch(report)
    // Opening a route must not run again when its stream updates the view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialId, keyReady, route.local])
  useEffect(() => {
    const clear = () => {
      setThreads([])
      if (localRef.current) return
      reset()
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
      if (receipt.temporary && !receipt.local) {
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
  function turnFields(fields: Partial<Turn>): Turn {
    return {
      clientRequestId: crypto.randomUUID(),
      threadId: idRef.current,
      kind: 'send',
      widgets: GENUI_WIDGETS.map((widget) => widget.name).filter((name) =>
        session?.widgets.includes(name),
      ),
      options: {
        model,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
      ...fields,
    }
  }
  // A local turn carries the thread and the settings a prompt reads instead
  // of the content key, which it never uses.
  async function sendLocal(fields: Partial<Turn>) {
    starting.current = true
    const version = generation.current
    const target = storeFor(temporaryRef.current)
    const threadId =
      idRef.current ?? pending.current?.run?.threadId ?? generateReverseId().id
    let base: LocalThread
    try {
      base = await localTranscript(threadId, target)
    } catch (cause) {
      starting.current = false
      report(cause)
      return false
    }
    if (version !== generation.current) return false
    if (!idRef.current && !temporaryRef.current) setUnsaved(threadId)
    const input: Turn = {
      ...turnFields(fields),
      threadId,
      local: true,
      thread: turnThread(base),
      profile: turnProfile(profileRef.current),
    }
    const run: LocalRun = {
      threadId,
      base,
      store: target,
      uploads: new Map(uploads.current),
    }
    pending.current = { input, run }
    return stream('/v1/threads/turn', input, undefined, run)
  }
  function send(fields: Partial<Turn> = {}) {
    if ((!idRef.current || runsLocally()) && starting.current) return
    setError('')
    lastTurn.current = {
      kind: fields.kind ?? 'send',
      messageId: fields.messageId,
    }
    if (runsLocally()) return sendLocal(fields)
    const input = turnFields({
      key: contentKey(),
      ephemeral: temporary,
      projectId: idRef.current ? undefined : projectId,
      presetId: idRef.current ? undefined : presetId,
      ...fields,
    })
    pending.current = { input: { ...input, key: undefined } }
    if (!idRef.current) starting.current = true
    return stream('/v1/threads/turn', input)
  }
  function cancel() {
    return api.post(
      '/v1/threads/cancel',
      {
        ...runKey(),
        threadId: idRef.current,
        runId:
          current.current.snapshot.thread?.activeRun?.runId ??
          current.current.runId,
      },
      undefined,
      false,
    )
  }
  // The harness regenerates the reply it is named. The message actions name
  // a message by its index: a reply, or the user message it answers. A user
  // message left without a reply is sent again with its own text, as the
  // previous client regenerated it. A run in progress is stopped first.
  async function regenerate(index: number, fields: Partial<Turn> = {}) {
    const messages = current.current.messages
    const target = messages[index]
    if (!target) return false
    const reply =
      target.role === 'assistant'
        ? target
        : messages[index + 1]?.role === 'assistant'
          ? messages[index + 1]
          : undefined
    const turn: Partial<Turn> = reply
      ? { kind: 'regenerate', messageId: reply.id, content: '' }
      : { kind: 'edit', messageId: target.id, content: target.content ?? '' }
    const status = current.current.status
    if (status === 'streaming' || status === 'queued')
      await cancel().catch((cause) =>
        logError('Failed to stop a run before regenerating', cause, {
          component: 'useThread',
          action: 'regenerate',
        }),
      )
    return send({ ...fields, ...turn })
  }
  const isLocalThread = (threadId: string) =>
    idRef.current === threadId
      ? localRef.current
      : !cloudRef.current || localIds.current.has(threadId)
  async function update(threadId: string, patch: Record<string, unknown>) {
    if (isLocalThread(threadId)) {
      const target = storeFor(
        idRef.current === threadId && temporaryRef.current,
      )
      const saved = await target.update(
        threadId,
        (thread) =>
          thread && {
            ...thread,
            ...(typeof patch.title === 'string'
              ? { title: patch.title, titleState: 'manual' as const }
              : {}),
            ...(typeof patch.model === 'string' ? { model: patch.model } : {}),
            ...('presetId' in patch
              ? { presetId: (patch.presetId as string | null) || undefined }
              : {}),
            ...(typeof patch.webSearchEnabled === 'boolean'
              ? { webSearchEnabled: patch.webSearchEnabled }
              : {}),
            updatedAt: now(),
          },
      )
      if (saved && idRef.current === threadId)
        setState((previous) =>
          previous.snapshot.thread
            ? {
                ...previous,
                snapshot: {
                  ...previous.snapshot,
                  thread: {
                    ...previous.snapshot.thread,
                    title: saved.title,
                    titleState: saved.titleState,
                    model: saved.model ?? previous.snapshot.thread.model,
                    webSearchEnabled:
                      saved.webSearchEnabled ??
                      previous.snapshot.thread.webSearchEnabled,
                    updatedAt: saved.updatedAt,
                  },
                },
              }
            : previous,
        )
      return
    }
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
    if (isLocalThread(threadId)) {
      const runId = localRuns.current.get(threadId)?.runId
      if (runId)
        void api
          .post('/v1/threads/cancel', { threadId, runId }, undefined, false)
          .catch(() => {})
      await store.delete(threadId)
      localRuns.current.delete(threadId)
      setLocalThreads((previous) => previous.filter((t) => t.id !== threadId))
      if (idRef.current === threadId) reset()
      return
    }
    await api.post('/v1/threads/delete', { id: threadId })
    setThreads((previous) => previous.filter((t) => t.id !== threadId))
    if (idRef.current === threadId) reset()
  }
  // Deletes every chat the user can see here: the harness's stored chats
  // with cloud sync, and the chats kept on this device.
  async function removeAll() {
    let cloudDeletionCompleted = false
    if (cloudRef.current) {
      await api.post('/v1/threads/delete-all')
      cloudDeletionCompleted = true
    }
    await store.deleteAll()
    reset()
    setThreads([])
    setLocalThreads([])
    return { cloudDeletionCompleted }
  }
  async function upload(file: File): Promise<WireAttachment> {
    if (!runsLocally())
      return api.upload<WireAttachment>('/v1/attachments/upload', file, {
        ephemeral: String(temporary),
        ...(idRef.current ? { threadId: idRef.current } : {}),
      })
    const { descriptor, ...view } = await api.upload<
      WireAttachment & { descriptor: unknown }
    >('/v1/attachments/upload', file, { local: 'true' }, undefined, false)
    // The harness keeps an upload's image bytes only briefly; a local
    // thread sends them back with later turns.
    const base64 =
      view.kind === 'image'
        ? uint8ArrayToBase64(new Uint8Array(await file.arrayBuffer()))
        : undefined
    const attachment = localAttachment(descriptor, base64)
    uploads.current.set(attachment.id, attachment)
    if (base64)
      images.current.set(attachment.id, {
        base64,
        mimeType: attachment.mimeType,
      })
    return view
  }
  // An attachment of the open chat. The harness finds a stored chat's
  // attachments under the chat; only a fresh upload resolves without it.
  function download(attachment: UIAttachment, signal?: AbortSignal) {
    const threadId = idRef.current
    return api.download(
      '/v1/attachments/get',
      { id: attachment.id, ...(threadId ? { threadId } : {}) },
      signal,
    )
  }
  async function loadImage(
    attachment: UIAttachment,
    signal?: AbortSignal,
  ): Promise<Blob> {
    if (!runsLocally()) return download(attachment, signal)
    const image = images.current.get(attachment.id)
    if (!image)
      throw new HarnessError({
        code: 'THREAD_NOT_FOUND',
        message: 'This image is not stored on this device.',
      })
    return new Blob([base64ToUint8Array(image.base64)], {
      type: image.mimeType || 'image/jpeg',
    })
  }
  // A document's text. A stored chat's messages leave it out, and the
  // harness sends a document as its extracted text; a chat on this device
  // keeps it in the document's descriptor. Reads are shared until the view
  // moves to another chat.
  function documentText(attachment: UIAttachment): Promise<string> {
    if (attachment.textContent !== undefined)
      return Promise.resolve(attachment.textContent)
    const texts = documentTexts.current
    const cached = texts.get(attachment.id)
    if (cached) return cached
    const threadId = idRef.current
    const target = storeFor(temporaryRef.current)
    const reading = (async () => {
      if (!runsLocally()) return (await download(attachment)).text()
      const descriptor =
        uploads.current.get(attachment.id) ??
        (threadId ? await target.get(threadId) : null)?.messages
          .flatMap((message) => message.attachments ?? [])
          .find((candidate) => candidate.id === attachment.id)
      if (!descriptor)
        throw new HarnessError({
          code: 'THREAD_NOT_FOUND',
          message: 'This document is not stored on this device.',
        })
      return localDocumentText(descriptor)
    })()
    texts.set(attachment.id, reading)
    reading.catch(() => {
      if (texts.get(attachment.id) === reading) texts.delete(attachment.id)
    })
    return reading
  }
  // A local chat is forked on the device, the way the previous client forked
  // chats it stored: the fork keeps the messages up to the chosen one.
  async function fork(messageIndex: number) {
    const threadId = idRef.current
    if (!threadId || !localRef.current || temporaryRef.current) return null
    const source = await localTranscript(threadId, store)
    const forkId = generateReverseId().id
    const forked = buildForkedChat(
      {
        ...source,
        createdAt: new Date(source.createdAt),
        presetId: source.presetId,
        isLocalOnly: true,
        messages: source.messages as unknown as Chat['messages'],
      },
      messageIndex + 1,
      forkId,
    )
    const thread = readLocalThread({
      ...newLocalThread(forkId, source),
      title: forked.title,
      titleState: forked.titleState,
      messages: forked.messages,
    })
    await store.update(forkId, () => thread)
    await open(forkId, { local: true })
    return forkId
  }
  // Creates a share link. A chat kept on this device is shared from its own
  // copy, which the harness seals without storing it.
  async function share(threadId: string): Promise<string> {
    if (!isLocalThread(threadId)) {
      const { url } = await api.post<{ url: string }>('/v1/threads/share', {
        threadId,
      })
      return url
    }
    const thread = shareThread(
      await localTranscript(
        threadId,
        storeFor(idRef.current === threadId && temporaryRef.current),
      ),
    )
    const input = { local: true, threadId, thread }
    if (requestBytes(input) > MAX_SHARE_REQUEST_BYTES) throw shareTooLarge()
    const { url } = await api.post<{ url: string }>(
      '/v1/threads/share',
      input,
      undefined,
      false,
    )
    return url
  }
  // The thread an ask carries: a local chat sends its transcript.
  async function askContext(): Promise<
    Pick<Turn, 'key' | 'threadId' | 'local' | 'thread' | 'profile'>
  > {
    const threadId = idRef.current
    if (threadId && runsLocally())
      return {
        threadId,
        local: true,
        thread: turnThread(
          await localTranscript(threadId, storeFor(temporaryRef.current)),
        ),
        profile: turnProfile(profileRef.current),
      }
    return { key: contentKey(), threadId }
  }
  async function reconnect() {
    setError('')
    // A request whose acceptance never arrived is sent again with its nonce,
    // which the harness answers with the run it may already have started.
    if (pending.current) {
      const { input, run } = pending.current
      return stream(
        '/v1/threads/turn',
        run ? input : { ...input, key: contentKey() },
        undefined,
        run,
      )
    }
    const runId =
      current.current.runId ?? current.current.snapshot.thread?.activeRun?.runId
    const threadId = idRef.current
    if (threadId && runId) {
      if (!runsLocally())
        return stream(
          '/v1/threads/follow',
          { key: contentKey(), threadId, runId },
          current.current.cursors[runId],
        )
      const target = storeFor(temporaryRef.current)
      const run = localRuns.current.get(threadId) ?? {
        threadId,
        base: await localTranscript(threadId, target),
        store: target,
        uploads: new Map(uploads.current),
      }
      return stream(
        '/v1/threads/follow',
        { threadId, runId },
        current.current.cursors[runId],
        run,
      )
    }
    if (initialId) return open(initialId, { local: !!route.local })
  }
  // Retries what failed. A run that ended with an error runs again: a
  // continuation continues its reply again, and any other turn regenerates
  // the reply to the last user message. A refused request or a dropped
  // stream reconnects.
  async function retry(fields: Partial<Turn> = {}) {
    const failed = current.current.failedRun
    if (!failed || current.current.status !== 'error') return reconnect()
    const messages = current.current.messages
    if (lastTurn.current?.kind === 'continue') {
      const replyId =
        lastTurn.current.messageId ??
        messages.findLast((message) => message.role === 'assistant')?.id
      if (replyId)
        return send({
          ...fields,
          kind: 'continue',
          messageId: replyId,
          content: '',
        })
    }
    const index = messages.findLastIndex((message) => message.role === 'user')
    if (index < 0) return reconnect()
    return regenerate(index, fields)
  }
  async function older() {
    if (!id || local) return
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
  const runKey = () => (runsLocally() ? {} : { key: contentKey() })
  const running = state.status === 'streaming' || state.status === 'queued'
  const isLocalChat = local && !temporary
  const messages = state.messages.map((m, index) => {
    const view = messageView(m, running && index === state.messages.length - 1)
    if (!local || !view.attachments?.length) return view
    // An image the previous client stored without a thumbnail shows its
    // bytes; others load them when opened in the gallery.
    return {
      ...view,
      attachments: view.attachments.map((attachment) =>
        attachment.thumbnailBase64 || !images.current.has(attachment.id)
          ? attachment
          : {
              ...attachment,
              base64: images.current.get(attachment.id)!.base64,
            },
      ),
    }
  })
  const summary = state.snapshot.thread
  const chat: Chat = summary
    ? {
        ...threadView(summary, messages),
        isTemporary: temporary,
        isLocalOnly: isLocalChat,
        pendingSave: unsaved === summary.id,
        presetId: presetId ?? undefined,
      }
    : {
        id: id ?? '',
        title: 'New Chat',
        messages,
        createdAt: new Date(),
        isBlankChat: !id,
        isTemporary: temporary,
        isLocalOnly: isLocalChat,
        pendingSave: !!id && unsaved === id,
        model,
        projectId: local ? undefined : (projectId ?? undefined),
        presetId: presetId ?? undefined,
      }
  return {
    api,
    state,
    chat,
    threads,
    chats: [
      ...(cloud ? threads.map((t) => threadView(t)) : []),
      ...localThreads.map((t) => ({ ...threadView(t), isLocalOnly: true })),
    ],
    model,
    setModel,
    presetId,
    setPresetId,
    temporary,
    setTemporary,
    local: isLocalChat,
    runsLocally: local,
    loading,
    notFound,
    error: error || state.error?.message || '',
    report,
    open,
    send,
    update,
    remove,
    removeAll,
    upload,
    loadImage,
    documentText,
    fork,
    share,
    askContext,
    refresh,
    reconnect,
    retry,
    errorAt: errorAt.current,
    older,
    hasOlder: state.hasOlder,
    cursor,
    running,
    newChat: (options: { local?: boolean } = {}) => {
      initial.current = null
      reset()
      setLocal(!cloudRef.current || !!options.local)
      memory.current = memoryThreadStore()
      try {
        sessionStorage.removeItem(storageKey)
      } catch {
        /* optional */
      }
    },
    cancel,
    regenerate,
    sendQueued: (queueId: string) =>
      api.post(
        '/v1/threads/queue/send',
        { ...runKey(), threadId: id, queueId },
        undefined,
        false,
      ),
    removeQueued: (queueId: string) =>
      api.post(
        '/v1/threads/queue/remove',
        { ...runKey(), threadId: id, queueId },
        undefined,
        false,
      ),
    dismissError: () => {
      setError('')
      setState((previous) => ({ ...previous, error: undefined }))
    },
  }
}
