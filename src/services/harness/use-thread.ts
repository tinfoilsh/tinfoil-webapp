import { GENUI_WIDGETS } from '@/components/chat/genui/registry'
import type {
  Chat,
  QueuedMessage,
  Attachment as UIAttachment,
} from '@/components/chat/types'
import { displayModels } from '@/config/models'
import { ENCRYPTION_KEY_CHANGED_EVENT } from '@/services/encryption/encryption-service'
import { uint8ArrayToBase64 } from '@/utils/binary-codec'
import { logError } from '@/utils/error-handling'
import { generateReverseId } from '@/utils/reverse-id'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { chatActions } from './chat-actions'
import { useChatList } from './chat-list'
import { deviceThreads, storeRun } from './device-threads'
import { localThreadStore, memoryThreadStore, now } from './local-threads'
import { OpenAttachments, uploaded } from './open-attachments'
import { ROUTES } from './protocol'
import { useHarness } from './provider'
import { initialChat } from './reducer'
import { RunController } from './run-controller'
import { getView, type Profile } from './runtime'
import { HarnessError } from './sse'
import { createStore, useStore } from './store'
import {
  cloudThreads,
  type AskContext,
  type ThreadStore,
  type TurnSettings,
} from './thread-store'
import type {
  AttachmentDescriptor,
  HarnessErrorBody,
  ThreadMessage,
  Turn,
} from './types'
import { messageView, threadView } from './view-model'

export interface ThreadRoute {
  // The route names a chat stored on this device (/chat/local/:id).
  local?: boolean
  // A new chat starts on this device, as from the sidebar's Local tab.
  newChatLocal?: boolean
}

// The open chat, apart from what its runs show.
interface OpenChat {
  id: string | null
  temporary: boolean
  // A chat the browser stores: every chat of a signed-out visitor or of an
  // account without cloud sync, and chats from the Local tab. A temporary
  // chat without cloud sync is one too, with its transcript held in memory.
  local: boolean
  // A new chat until the harness accepts its first turn, or this device
  // first stores it. Its route waits, since opening the route before then
  // would find nothing.
  unsaved: string | null
  loading: boolean
  notFound: boolean
  model: string
  // An action that failed. The open chat's run reports how it ended in the
  // run's state.
  failure: { message: string; detail?: HarnessErrorBody } | null
  // Whether the open chat's prompt was chosen, rather than left at the
  // default a new chat starts with.
  presetChosen: boolean
  chosenPresetId: string | null
  // The open chat's web search setting, where a saved prompt or the toggle
  // set it before the chat stores it.
  webSearch?: boolean
  // Counts new chats, so the default prompt applies to each one.
  blankChats: number
}

// The prompt new chats start with, which the harness keeps in the profile.
const defaultPresetIdOf = (profile: Profile): string | null =>
  typeof profile.defaultPromptPresetId === 'string' &&
  profile.defaultPromptPresetId
    ? profile.defaultPromptPresetId
    : null

const presetIdOf = (open: OpenChat, profile: Profile) =>
  !open.id && !open.presetChosen
    ? defaultPresetIdOf(profile)
    : open.chosenPresetId

export function useThread(
  initialId?: string | null,
  projectId?: string | null,
  route: ThreadRoute = {},
) {
  const { api, session, profile, profileReady, keyReady, cloud } = useHarness()
  const [{ open, controller, attachments, moving, temporaryChats }] = useState(
    () => ({
      open: createStore<OpenChat>({
        id: null,
        temporary: false,
        local: !cloud || !!route.local || !!route.newChatLocal,
        unsaved: null,
        loading: false,
        notFound: false,
        model: '',
        failure: null,
        presetChosen: false,
        chosenPresetId: null,
        blankChats: 0,
      }),
      controller: new RunController(
        api,
        {},
        `harness-run:${api.userId ?? 'anonymous'}`,
      ),
      attachments: new OpenAttachments(),
      moving: new Map<string, Promise<unknown>>(),
      // A temporary chat on this device; each new chat starts another.
      temporaryChats: { store: memoryThreadStore() },
    }),
  )
  const patch = useCallback(
    (fields: Partial<OpenChat>) => open.update((o) => ({ ...o, ...fields })),
    [open],
  )
  const report = useCallback(
    (cause: unknown) => {
      if (
        api.lifetime.signal.aborted ||
        (cause instanceof DOMException && cause.name === 'AbortError')
      )
        return
      controller.errorAt = Date.now()
      if (cause instanceof HarnessError) api.reportRefusal(cause.detail)
      patch({
        failure: {
          message:
            cause instanceof Error
              ? cause.message
              : 'The connection failed. Reconnect to continue.',
          ...(cause instanceof HarnessError ? { detail: cause.detail } : {}),
        },
      })
    },
    [api, controller, patch],
  )
  const markSaved = useCallback(
    (threadId: string) =>
      open.update((o) =>
        o.unsaved === threadId ? { ...o, unsaved: null } : o,
      ),
    [open],
  )
  const device = useMemo(
    () => localThreadStore(api.userId ? 'device' : 'tab'),
    [api.userId],
  )
  const list = useChatList({ api, cloud, keyReady, projectId, device, report })
  const { clearCloud } = list
  const cloudStore = useMemo(
    () => cloudThreads(api, list.cloud, attachments),
    [api, list.cloud, attachments],
  )
  const deviceStore = useMemo(
    () =>
      deviceThreads({
        api,
        store: device,
        controller,
        attachments,
        list: list.device,
        saved: markSaved,
      }),
    [api, device, controller, attachments, list.device, markSaved],
  )
  // The open chat's store.
  const openStore = (): ThreadStore => {
    const { local, temporary } = open.get()
    if (!local) return cloudStore
    if (!temporary) return deviceStore
    return deviceThreads({
      api,
      store: temporaryChats.store,
      controller,
      attachments,
      list: { add() {}, replace() {}, remove() {} },
      saved: markSaved,
    })
  }
  const storeOf = (threadId: string): ThreadStore =>
    open.get().id === threadId
      ? openStore()
      : !api.cloud || list.isOnDevice(threadId)
        ? deviceStore
        : cloudStore
  const reset = useCallback(() => {
    controller.reset()
    attachments.clear()
    open.update((o) => ({
      ...o,
      id: null,
      failure: null,
      notFound: false,
      unsaved: null,
      presetChosen: false,
      chosenPresetId: null,
      webSearch: undefined,
      blankChats: o.blankChats + 1,
    }))
  }, [controller, attachments, open])
  const choosePreset = (next: string | null) =>
    patch({ presetChosen: true, chosenPresetId: next })
  // Shows the open chat as it is stored once its run is over, as when the
  // harness no longer has the run or had applied a turn sent again. A
  // temporary stored chat, or one never saved, keeps what it shows.
  async function showStored(threadId: string) {
    const { id, temporary, local } = open.get()
    if (id !== threadId) return
    const shown = controller.track()
    const thread = temporary && !local ? null : await openStore().get(threadId)
    if (!shown()) return
    if (thread) markSaved(threadId)
    controller.view.set(
      thread
        ? initialChat(thread)
        : { ...controller.view.get(), status: 'idle', error: undefined },
    )
  }
  controller.hooks = {
    accepted: markSaved,
    async saved(run, event, attached) {
      try {
        const saved = await storeRun(run, event)
        if (!saved) return
        markSaved(saved.id)
        if (open.get().id !== saved.id) return
        attachments.rememberThread(saved)
        controller.view.update((state) => {
          const shown = state.snapshot.thread
          return shown?.id === saved.id && shown.title !== saved.title
            ? {
                ...state,
                snapshot: {
                  ...state.snapshot,
                  thread: {
                    ...shown,
                    title: saved.title,
                    titleState: saved.titleState,
                  },
                },
              }
            : state
        })
      } catch (cause) {
        logError('Failed to save a local chat', cause, {
          component: 'useThread',
          action: 'saveRun',
        })
        if (attached)
          patch({
            failure: {
              message: 'This chat could not be saved on this device.',
            },
          })
      }
    },
    ended: () => {
      void list.refresh().catch(report)
    },
    gone: (threadId) => showStored(threadId).catch(report),
  }
  async function openChat(threadId: string, options: { local?: boolean } = {}) {
    const local = options.local ?? (!api.cloud || list.isOnDevice(threadId))
    reset()
    const shown = controller.track()
    patch({ loading: true })
    try {
      const store = local ? deviceStore : cloudStore
      const thread = await store.get(threadId)
      if (!shown()) return
      if (!thread) {
        patch({ temporary: false, local, notFound: true })
        return
      }
      controller.view.set(initialChat(thread))
      patch({
        id: thread.id,
        temporary: false,
        local,
        model: thread.model ?? '',
        presetChosen: true,
        chosenPresetId: thread.presetId ?? null,
        webSearch: undefined,
      })
      // A run of the chat may still be live: one this page started, one a
      // reloaded page left behind, or one the harness names.
      const runId = store.liveRun(thread)
      if (!runId) return
      const { input, device: run } = await store.follow(threadId, runId)
      void controller.run(ROUTES.follow, input, { device: run, quiet: !!run })
    } finally {
      if (shown()) patch({ loading: false })
    }
  }
  const actions = chatActions({
    api,
    controller,
    open,
    list,
    device,
    storeOf,
    moving,
    reset,
    openChat,
  })
  // The route opened last, so updates of the open chat do not reopen it.
  const opened = useRef<string | null>(null)
  const openState = useStore(open)
  const state = useStore(controller.view)
  const deviceRuns = useStore(controller.deviceRuns)
  useEffect(() => {
    if (session && !openState.model)
      patch({ model: profile.selectedModel || session.defaultModel })
  }, [session, profile.selectedModel, openState.model, patch])
  const previousCloud = useRef(cloud)
  useEffect(() => {
    if (previousCloud.current === cloud) return
    previousCloud.current = cloud
    if (!cloud) clearCloud()
    // A blank chat follows the storage mode; a stored chat of the harness
    // cannot stay open once cloud sync is off.
    const { id, local } = open.get()
    if (!id) patch({ local: !cloud || !!route.newChatLocal })
    else if (!cloud && !local) {
      reset()
      patch({ local: true })
    }
  }, [cloud, reset, route.newChatLocal, clearCloud, open, patch])
  useEffect(() => {
    if (
      !initialId ||
      opened.current === initialId ||
      open.get().id === initialId
    )
      return
    if (!route.local && !keyReady) return
    opened.current = initialId
    void openChat(initialId, { local: !!route.local }).catch(report)
    // Opening a route must not run again when its stream updates the view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialId, keyReady, route.local])
  useEffect(() => {
    const clear = () => {
      clearCloud()
      if (open.get().local) return
      reset()
      opened.current = null
      controller.clearReceipt()
    }
    window.addEventListener(ENCRYPTION_KEY_CHANGED_EVENT, clear)
    return () => {
      window.removeEventListener(ENCRYPTION_KEY_CHANGED_EVENT, clear)
      reset()
    }
  }, [reset, clearCloud, open, controller])
  // A temporary stored chat's run is rejoined after a reload through its
  // receipt, until it ends.
  useEffect(() => {
    if (initialId || !session || (api.userId && !keyReady)) return
    const receipt = controller.receipt()
    if (!receipt?.temporary || receipt.local) return
    let key: string | undefined
    try {
      key = api.key()
    } catch {
      return
    }
    patch({ temporary: true, id: receipt.threadId })
    void controller.run(
      ROUTES.follow,
      { key, threadId: receipt.threadId, runId: receipt.runId },
      { temporary: true },
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, keyReady, !!session])
  // The fields every turn of the open chat has.
  const turnDefaults = (): Turn => ({
    clientRequestId: crypto.randomUUID(),
    threadId: open.get().id,
    kind: 'send',
    widgets: GENUI_WIDGETS.map((widget) => widget.name).filter((name) =>
      session?.widgets.includes(name),
    ),
    options: {
      model: open.get().model,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
  })
  // A new chat takes its id with its first turn, and keeps showing the
  // prompt it started with.
  function startChat(): string {
    const current = open.get()
    if (current.id) return current.id
    const threadId = generateReverseId().id
    opened.current = threadId
    patch({
      ...(current.presetChosen
        ? {}
        : {
            presetChosen: true,
            chosenPresetId: presetIdOf(current, getView().profile),
          }),
      id: threadId,
      unsaved: threadId,
    })
    return threadId
  }
  // The message a turn adds, under the id the harness stores it with. A
  // message queued behind a running reply shows in the queue instead.
  function sentMessage(input: Turn): ThreadMessage | null {
    const { status } = controller.view.get()
    if (input.kind !== 'send' || status === 'streaming' || status === 'queued')
      return null
    const sent = uploaded(input.attachments)
    return {
      id: input.clientRequestId,
      role: 'user',
      createdAt: now(),
      content: input.content ?? '',
      ...(input.quote ? { quote: input.quote } : {}),
      ...(sent.length ? { attachments: sent } : {}),
    }
  }
  // A message the user sends shows at once, until the run's first window
  // replaces the messages.
  function showSent({ attachments: sent, ...message }: ThreadMessage) {
    controller.view.update((state) => ({
      ...state,
      messages: [
        ...state.messages,
        sent
          ? {
              ...message,
              attachments: sent.map(
                ({ base64: _base64, pages: _pages, ...shown }) => shown,
              ),
            }
          : message,
      ],
    }))
  }
  function send(fields: Partial<Turn> = {}): Promise<boolean> | undefined {
    const threads = openStore()
    if (threads.local && controller.startingThread() !== undefined) return
    const current = open.get()
    if (current.id && moving.has(current.id)) return
    patch({ failure: null })
    attachments.rememberSent(fields.attachments)
    controller.lastTurn = {
      kind: fields.kind ?? 'send',
      messageId: fields.messageId,
    }
    let key: { key?: string }
    try {
      key = threads.runKey()
    } catch (cause) {
      report(cause)
      return
    }
    const currentProfile = getView().profile
    const settings: TurnSettings = {
      first: !current.id || current.unsaved === current.id,
      model: current.model,
      presetId: presetIdOf(current, currentProfile),
      presetChosen: current.presetChosen,
      webSearch: current.webSearch,
      temporary: current.temporary,
      projectId,
      profile: currentProfile,
    }
    const threadId = startChat()
    return (async () => {
      const turn = await threads.prepareTurn(
        threadId,
        { defaults: turnDefaults(), fields, key },
        settings,
      )
      if (!turn) return false
      controller.pending = { input: turn.resend, run: turn.run }
      const message = sentMessage(turn.input)
      if (message) {
        showSent(message)
        await turn.keep?.(message)
      }
      return controller.run(ROUTES.turn, turn.input, {
        device: turn.run,
        temporary: settings.temporary,
      })
    })().catch((cause) => {
      report(cause)
      return false
    })
  }
  function cancel() {
    const state = controller.view.get()
    return controller.cancel({
      ...openStore().runKey(),
      threadId: open.get().id,
      runId: state.snapshot.thread?.activeRun?.runId ?? state.runId,
    })
  }
  // The harness regenerates the reply it is named. The message actions name
  // a message by its index: a reply, or the user message it answers. A user
  // message left without a reply is sent again with its own text. A run in
  // progress is stopped first.
  async function regenerate(index: number, fields: Partial<Turn> = {}) {
    const { messages, status } = controller.view.get()
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
    if (status === 'streaming' || status === 'queued')
      await cancel().catch(report)
    return send({ ...fields, ...turn })
  }
  // Asks the model to resume a reply where it stopped. The harness drops the
  // messages after it, so the continued reply ends the chat.
  function continueReply(index: number, fields: Partial<Turn> = {}) {
    const reply = controller.view.get().messages[index]
    if (reply?.role !== 'assistant') return
    return send({
      ...fields,
      kind: 'continue',
      messageId: reply.id,
      content: '',
    })
  }
  async function reconnect() {
    patch({ failure: null })
    const threads = openStore()
    const { id: threadId, temporary } = open.get()
    // A turn whose acceptance never arrived is sent again with its nonce,
    // which the harness answers with the run it may already have started.
    if (controller.pending) {
      const { input, run } = controller.pending
      if (run) controller.begin(run)
      return controller.run(
        ROUTES.turn,
        { ...input, ...threads.runKey() },
        { device: run, temporary },
      )
    }
    const state = controller.view.get()
    const runId = state.runId ?? state.snapshot.thread?.activeRun?.runId
    if (threadId && runId) {
      const { input, device: run } = await threads.follow(threadId, runId)
      return controller.run(ROUTES.follow, input, { device: run, temporary })
    }
    if (initialId) return openChat(initialId, { local: !!route.local })
  }
  // Retries what failed. A run that ended with an error runs again: a
  // continuation continues its reply again, and any other turn regenerates
  // the reply to the last user message. A refused request or a dropped
  // stream reconnects.
  async function retry(fields: Partial<Turn> = {}) {
    const { failedRun, status, messages } = controller.view.get()
    if (!failedRun || status !== 'error') return reconnect()
    const { lastTurn } = controller
    if (lastTurn?.kind === 'continue') {
      const replyId =
        lastTurn.messageId ??
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
  // Converts a file into the descriptor the turn that uses it sends. The
  // harness keeps nothing of an upload, so an image keeps its bytes.
  async function upload(file: File): Promise<AttachmentDescriptor> {
    const { attachment } = await api.upload<{
      attachment: AttachmentDescriptor
    }>(ROUTES.attachmentUpload, file, {}, { keyless: true })
    if (attachment.kind !== 'image') return attachment
    return {
      ...attachment,
      base64: uint8ArrayToBase64(new Uint8Array(await file.arrayBuffer())),
    }
  }
  // The model and web search setting a saved prompt applies when it is
  // chosen. Built-in prompts carry none, and a model the catalog no longer
  // offers is skipped.
  function presetSettings(id: string | null): {
    model?: string
    webSearchEnabled?: boolean
  } {
    const { customPromptPresets } = getView().profile
    const saved: Record<string, unknown>[] = Array.isArray(customPromptPresets)
      ? customPromptPresets
      : []
    const preset = saved.find((candidate) => candidate?.id === id)
    if (!preset) return {}
    const models = displayModels(session ?? undefined)
    return {
      ...(typeof preset.model === 'string' &&
      models.some((candidate) => candidate.modelName === preset.model)
        ? { model: preset.model }
        : {}),
      ...(typeof preset.webSearchEnabled === 'boolean'
        ? { webSearchEnabled: preset.webSearchEnabled }
        : {}),
    }
  }
  // Chooses the open chat's prompt and applies the prompt's settings to the
  // chat, once, as later turns may change them.
  async function selectPreset(next: string | null) {
    choosePreset(next)
    const settings = presetSettings(next)
    if (settings.model) patch({ model: settings.model })
    if (settings.webSearchEnabled !== undefined)
      patch({ webSearch: settings.webSearchEnabled })
    const { id: threadId, temporary } = open.get()
    if (threadId && !temporary)
      await actions.update(threadId, { presetId: next, ...settings })
  }
  // A new chat that keeps the default prompt takes the prompt's settings.
  const defaultPresetId = defaultPresetIdOf(profile)
  const defaultSettings = presetSettings(defaultPresetId)
  useEffect(() => {
    if (openState.id || openState.presetChosen) return
    if (defaultSettings.model) patch({ model: defaultSettings.model })
    patch({ webSearch: defaultSettings.webSearchEnabled })
    // The settings apply when a new chat opens or the default changes.
  }, [
    openState.id,
    openState.presetChosen,
    openState.blankChats,
    defaultPresetId,
    defaultSettings.model,
    defaultSettings.webSearchEnabled,
    patch,
  ])
  function newChat(options: { local?: boolean } = {}) {
    opened.current = null
    reset()
    patch({ local: !api.cloud || !!options.local })
    temporaryChats.store = memoryThreadStore()
    controller.clearReceipt()
  }
  // The open chat's view.
  const { id, temporary, local, unsaved, model, failure, webSearch } = openState
  const presetId = presetIdOf(openState, profile)
  const running = state.status === 'streaming' || state.status === 'queued'
  const isLocalChat = local && !temporary
  const messages = state.messages.map((m, index) => {
    const view = messageView(m, running && index === state.messages.length - 1)
    if (!local || !view.attachments?.length) return view
    // An image the previous client stored without a thumbnail shows its
    // bytes; others load them when opened in the gallery.
    return {
      ...view,
      attachments: view.attachments.map((attachment) => {
        const held = attachments.images.get(attachment.id)
        return attachment.thumbnailBase64 || !held
          ? attachment
          : { ...attachment, base64: held.base64 }
      }),
    }
  })
  // A run this tab streams is active in the chat list before the list next
  // reports it, which it never does for a chat kept on the device.
  const liveRun = (listed: Chat): Chat => {
    if (listed.activeRun) return listed
    const runId =
      deviceRuns.get(listed.id)?.runId ??
      (listed.id === id && running ? state.runId : undefined)
    return runId ? { ...listed, activeRun: { runId } } : listed
  }
  const summary = state.snapshot.thread
  const chat: Chat = summary
    ? {
        ...threadView(summary, messages),
        ...(webSearch !== undefined ? { webSearchEnabled: webSearch } : {}),
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
        webSearchEnabled: webSearch,
      }
  const queue: QueuedMessage[] = state.snapshot.queue.map((item) => ({
    id: item.queueId,
    text: item.content,
  }))
  const queueInput = (queueId: string) => ({
    ...openStore().runKey(),
    threadId: open.get().id,
    queueId,
  })
  return {
    chat,
    chats: [
      ...(cloud ? list.cloudListed.map((t) => threadView(t)) : []),
      ...list.deviceListed.map((t) => ({
        ...threadView(t),
        isLocalOnly: true,
      })),
    ].map(liveRun),
    model,
    setModel: (next: string) => patch({ model: next }),
    presetId,
    setPresetId: choosePreset,
    selectPreset,
    setWebSearch: (next: boolean) => patch({ webSearch: next }),
    temporary,
    setTemporary: (next: boolean) => patch({ temporary: next }),
    local: isLocalChat,
    cloud,
    loading: openState.loading,
    notFound: openState.notFound,
    status: state.status,
    running,
    // The open chat takes turns once its settings load and, for a chat the
    // harness stores, once the content key is unlocked.
    canSend: profileReady && (local || keyReady),
    // A chat on this device changes its own copy; the harness changes a
    // stored chat, and a temporary one is not stored at all.
    canChangeMessages: !!chat.id && (local || !temporary),
    queue,
    contextUsage: summary?.contextUsage ?? undefined,
    error: failure?.message || state.error?.message || '',
    errorDetail: failure ? failure.detail : state.error,
    errorAt: controller.errorAt,
    hasOlder: state.hasOlder,
    hasMoreChats: !!list.nextCursor,
    report,
    open: openChat,
    send,
    ...actions,
    upload,
    loadImage: (attachment: UIAttachment, signal?: AbortSignal) =>
      openStore().image(open.get().id, attachment, signal),
    // A document's text: a stored chat's messages leave it out, and the
    // harness reads it from the chat; a chat on this device keeps it.
    documentText: (attachment: UIAttachment): Promise<string> =>
      attachment.textContent !== undefined
        ? Promise.resolve(attachment.textContent)
        : openStore().documentText(open.get().id, attachment),
    // The thread an ask reads: a chat on this device sends its transcript.
    async askContext(): Promise<AskContext> {
      const threadId = open.get().id
      if (!threadId) return { key: api.key(), threadId: null }
      return openStore().askContext(threadId, getView().profile)
    },
    refresh: () => list.refresh(),
    loadMoreChats: () => list.refresh(list.nextCursor ?? undefined),
    reconnect,
    retry,
    newChat,
    cancel,
    regenerate,
    continueReply,
    sendQueued: (queueId: string) => controller.sendQueued(queueInput(queueId)),
    removeQueued: (queueId: string) =>
      controller.removeQueued(queueInput(queueId)),
    // Deletes the chats of a project the harness stores.
    async removeProjectChats(projectId: string) {
      await api.post(ROUTES.deleteAll, { projectId })
      newChat()
      await list.refresh()
    },
    dismissError: () => {
      patch({ failure: null })
      controller.view.update((previous) => ({ ...previous, error: undefined }))
    },
  }
}
