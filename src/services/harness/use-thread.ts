import { isPresetModelAvailable } from '@/components/chat/prompts/preset-settings'
import type {
  Chat,
  Message,
  QueuedMessage,
  Attachment as UIAttachment,
} from '@/components/chat/types'
import { DEFAULT_CHAT_TITLE, TEMPORARY_CHAT_TITLE } from '@/constants/chat'
import {
  ENCRYPTION_KEY_CHANGED_EVENT,
  encryptionService,
} from '@/services/encryption/encryption-service'
import { uint8ArrayToBase64 } from '@/utils/binary-codec'
import { logError } from '@/utils/error-handling'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { chatActions } from './chat-actions'
import { useChatList } from './chat-list'
import { chatTurns } from './chat-turns'
import { deviceThreads, storeRun } from './device-threads'
import { localThreadStore, memoryThreadStore } from './local-threads'
import { OpenAttachments } from './open-attachments'
import {
  onDevice,
  presetIdOf,
  type OpenChat,
  type OpenChatResult,
  type PresetChoice,
} from './open-chat'
import { ERROR_ACTIONS, ERROR_CODES, ROUTES } from './protocol'
import { useHarness } from './provider'
import { initialChat, type ChatState } from './reducer'
import { RunController } from './run-controller'
import { getView, reportHarnessError } from './runtime'
import { HarnessError } from './sse'
import { createStore, useStore } from './store'
import { cloudThreads, type AskContext, type ThreadStore } from './thread-store'
import type {
  AttachmentDescriptor,
  Turn,
  Message as WireMessage,
} from './types'
import {
  lastActive,
  messageView,
  queuedAttachmentViews,
  threadView,
} from './view-model'

export interface ThreadRoute {
  // The route names a chat stored on this device (/chat/local/:id).
  local?: boolean
  // A new chat starts on this device, as from the sidebar's Local tab.
  newChatLocal?: boolean
}

export function useThread(
  initialId?: string | null,
  projectId?: string | null,
  route: ThreadRoute = {},
) {
  const {
    api,
    session,
    profile,
    profileReady,
    keyReady,
    keyLocked,
    error: sessionError,
    cloud,
    chatRevision,
  } = useHarness()
  const [{ open, controller, attachments, moving, temporaryChats }] = useState(
    () => ({
      open: createStore<OpenChat>({
        id: null,
        temporary: false,
        local: !cloud || !!route.local || !!route.newChatLocal,
        unsaved: null,
        loadingId: null,
        failedId: null,
        notFound: false,
        model: '',
        failure: null,
        presetChosen: false,
        chosenPresetId: null,
        modelChosen: false,
      }),
      controller: new RunController(
        api,
        {},
        `harness-run:${api.userId ?? 'anonymous'}`,
      ),
      attachments: new OpenAttachments(),
      moving: new Map<string, Promise<unknown>>(),
      // A temporary chat, kept in page memory; each new chat starts another.
      temporaryChats: { store: memoryThreadStore() },
    }),
  )
  // The view of each message, kept until the message, whether it streams or
  // the reasoning summaries change, so a message that did not change keeps
  // its view.
  const [views] = useState(
    () =>
      new WeakMap<
        WireMessage,
        {
          streaming: boolean
          summaries: ChatState['summaries']
          view: Message
        }
      >(),
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
      if (cause instanceof HarnessError)
        api.reportRateLimit(cause.detail.rateLimit)
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
  const list = useChatList({
    api,
    cloud,
    keyReady,
    projectId,
    device,
    revision: chatRevision,
  })
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
  // The open chat's store. A temporary chat runs as a chat on this device
  // whose thread lives only in page memory, with or without cloud sync.
  const openStore = (): ThreadStore => {
    const { local, temporary } = open.get()
    if (!temporary) return local ? deviceStore : cloudStore
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
      loadingId: null,
      failedId: null,
      failure: null,
      notFound: false,
      unsaved: null,
      model: '',
      presetChosen: false,
      chosenPresetId: null,
      modelChosen: false,
      webSearch: undefined,
    }))
  }, [controller, attachments, open])
  // What a new chat's saved prompt chooses and the user did not change,
  // which the composer shows until the first turn, when the harness applies
  // it. A model the catalog no longer offers is not shown.
  const presetChoice = (): PresetChoice => {
    const current = open.get()
    if (current.id) return {}
    const { customPromptPresets } = profile
    const saved: Record<string, unknown>[] = Array.isArray(customPromptPresets)
      ? customPromptPresets
      : []
    const preset = saved.find(
      (candidate) => candidate?.id === presetIdOf(current, profile),
    )
    if (!preset) return {}
    return {
      ...(!current.modelChosen &&
      typeof preset.model === 'string' &&
      isPresetModelAvailable(preset.model, session?.models ?? [])
        ? { model: preset.model }
        : {}),
      ...(current.webSearch === undefined &&
      typeof preset.webSearchEnabled === 'boolean'
        ? { webSearchEnabled: preset.webSearchEnabled }
        : {}),
    }
  }
  // Shows the open chat as it is stored once its run is over, as when the
  // harness no longer has the run or had applied a turn sent again. A chat
  // never saved keeps what it shows.
  async function showStored(threadId: string) {
    if (open.get().id !== threadId) return
    const shown = controller.track()
    const thread = await openStore().get(threadId)
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
    // The chat list shows a stored chat as its run reports it.
    summary(thread) {
      const current = open.get()
      if (!onDevice(current) && current.id === thread.id)
        list.cloud.reported(thread)
    },
    async saved(run, event, attached) {
      try {
        const saved = await storeRun(
          run,
          event,
          controller.settingsChangedSince(run),
        )
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
        if (attached) {
          const message = 'This chat could not be saved on this device.'
          patch({
            failure: {
              message,
              detail: {
                code: ERROR_CODES.localSaveFailed,
                action: ERROR_ACTIONS.stop,
                message,
              },
            },
          })
        }
      }
    },
    ended: list.reload,
    gone: (threadId) => showStored(threadId).catch(report),
  }
  async function openChat(
    threadId: string,
    options: { local?: boolean } = {},
  ): Promise<OpenChatResult> {
    const local = options.local ?? (!api.cloud || list.isOnDevice(threadId))
    reset()
    const shown = controller.track()
    patch({ loadingId: threadId, temporary: false, local })
    try {
      const store = local ? deviceStore : cloudStore
      const thread = await store.get(threadId)
      if (!shown()) return { status: 'superseded' }
      if (!thread) {
        patch({ temporary: false, local, notFound: true, failedId: threadId })
        return { status: 'not-found' }
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
      const live = store.liveRun(thread)
      if (!live) return { status: 'opened', thread }
      api.client.locate(threadId, live.instance)
      const { input, device: run } = await store.follow(threadId, live.runId)
      if (!shown()) return { status: 'superseded' }
      void controller.run(ROUTES.follow, input, { device: run, quiet: !!run })
      return { status: 'opened', thread }
    } catch (cause) {
      if (!shown()) return { status: 'superseded' }
      patch({ failedId: threadId })
      if (
        cause instanceof HarnessError &&
        cause.code === ERROR_CODES.threadNotFound
      ) {
        patch({ notFound: true })
        return { status: 'not-found' }
      }
      throw cause
    } finally {
      if (shown()) patch({ loadingId: null })
    }
  }
  const actions = chatActions({
    api,
    controller,
    open,
    list,
    device,
    temporary: () => temporaryChats.store,
    storeOf,
    moving,
    reset,
    openChat,
  })
  // The route opened last, so updates of the open chat do not reopen it.
  const opened = useRef<string | null>(null)
  const turns = chatTurns({
    api,
    controller,
    open,
    attachments,
    session: session ?? undefined,
    profile,
    projectId,
    moving,
    openStore,
    patch,
    report,
    presetChoice,
    claim: (threadId) => {
      opened.current = threadId
    },
    reopen: () =>
      initialId ? openChat(initialId, { local: !!route.local }) : undefined,
  })
  const openState = useStore(open)
  const state = useStore(controller.view)
  const deviceRuns = useStore(controller.deviceRuns)
  const refreshedChat = useRef<{ id: string; revision: string } | null>(null)
  useEffect(() => {
    if (
      !chatRevision ||
      !keyReady ||
      onDevice(open.get()) ||
      !open.get().id ||
      open.get().loadingId ||
      open.get().unsaved === open.get().id ||
      state.status !== 'idle'
    )
      return
    const id = open.get().id!
    if (
      refreshedChat.current?.id === id &&
      refreshedChat.current.revision === chatRevision
    )
      return
    const shown = controller.track()
    let cancelled = false
    void (async () => {
      const thread = await cloudStore.get(id)
      if (!thread) return
      const wanted = controller.view.get().messages.length
      while (thread.hasOlder && thread.messages.length < wanted) {
        const older = await cloudStore.older(id, thread.messages[0]?.id)
        if (!older.messages.length) break
        thread.messages.unshift(...older.messages)
        thread.hasOlder = older.hasOlder
      }
      if (cancelled || !shown() || controller.view.get().status !== 'idle')
        return
      controller.view.set(initialChat(thread))
      refreshedChat.current = { id, revision: chatRevision }
      patch({
        model: thread.model,
        chosenPresetId: thread.presetId ?? null,
        presetChosen: true,
        webSearch: undefined,
      })
    })().catch((cause) => {
      if (cancelled || !shown()) return
      if (
        cause instanceof HarnessError &&
        cause.code === ERROR_CODES.threadNotFound
      ) {
        reset()
        patch({ notFound: true })
      } else report(cause)
    })
    return () => {
      cancelled = true
    }
  }, [
    chatRevision,
    keyReady,
    cloudStore,
    controller,
    open,
    patch,
    report,
    reset,
    state.status,
  ])
  // A new chat follows the model the user picked last, as the profile
  // loads, until the user chooses one in it or sends its first message. A
  // chat stored without a model continues on that pick.
  const pickedModel = profile.selectedModel || session?.defaultModel || ''
  useEffect(() => {
    if (pickedModel && openState.id && !openState.model)
      patch({ model: pickedModel })
  }, [pickedModel, openState.id, openState.model, patch])
  const previousCloud = useRef(cloud)
  useEffect(() => {
    if (previousCloud.current === cloud) return
    previousCloud.current = cloud
    if (!cloud) clearCloud()
    // A blank chat follows the storage mode; a stored chat of the harness
    // cannot stay open once cloud sync is off.
    const current = open.get()
    if (!current.id) patch({ local: !cloud || !!route.newChatLocal })
    else if (!cloud && !onDevice(current)) {
      reset()
      patch({ local: true })
    }
  }, [cloud, reset, route.newChatLocal, clearCloud, open, patch])
  const previousRoute = useRef(initialId)
  const previousNewChatLocal = useRef(!!route.newChatLocal)
  const previousProject = useRef(projectId)
  const leavingChat = !!previousRoute.current && !initialId
  useEffect(() => {
    previousRoute.current = initialId
    const changedStorage = previousNewChatLocal.current !== !!route.newChatLocal
    previousNewChatLocal.current = !!route.newChatLocal
    const changedProject = previousProject.current !== projectId
    previousProject.current = projectId
    if (leavingChat || (!initialId && (changedStorage || changedProject))) {
      newChat({ local: !!route.newChatLocal })
      return
    }
    if (!initialId) return
    // A route that names the open chat, as once a selection's address
    // lands, is the one opened last; a later route back to the chat
    // opened before it opens that chat again.
    if (open.get().id === initialId) {
      opened.current = initialId
      return
    }
    if (opened.current === initialId) return
    if (!route.local && !keyReady) return
    opened.current = initialId
    void openChat(initialId, { local: !!route.local }).catch(report)
    // Opening a route must not run again when its stream updates the view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialId, keyReady, route.local, route.newChatLocal, projectId])
  useEffect(() => {
    let currentKey = encryptionService.getKey()
    const clear = () => {
      const nextKey = encryptionService.getKey()
      if (nextKey === currentKey) return
      currentKey = nextKey
      clearCloud()
      if (onDevice(open.get())) return
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
  // Converts a file into the descriptor the turn that uses it sends. An
  // image's descriptor carries the copy the harness gives models; the file
  // itself is kept apart, to show and download.
  async function upload(file: File): Promise<AttachmentDescriptor> {
    const { attachment } = await api.upload<{
      attachment: AttachmentDescriptor
    }>(ROUTES.attachmentUpload, file, {}, { keyless: true })
    if (attachment.kind === 'image')
      attachments.originals.set(attachment.id, {
        base64: uint8ArrayToBase64(new Uint8Array(await file.arrayBuffer())),
        mimeType: file.type || attachment.mimeType,
      })
    return attachment
  }
  // Chooses the open chat's prompt. A new chat shows what the prompt chooses
  // until its first turn; the harness applies the prompt's settings to a
  // chat it is named for, and the chat then shows them.
  async function selectPreset(next: string | null) {
    const threadId = open.get().id
    if (!threadId) {
      patch({
        presetChosen: true,
        chosenPresetId: next,
        modelChosen: false,
        webSearch: undefined,
      })
      return
    }
    patch({ presetChosen: true, chosenPresetId: next })
    const summary = await actions.update(threadId, { presetId: next })
    if (summary && open.get().id === threadId)
      patch({ model: summary.model, webSearch: undefined })
  }
  function newChat(options: { local?: boolean } = {}) {
    opened.current = null
    reset()
    patch({ local: !api.cloud || !!options.local, temporary: false })
    temporaryChats.store = memoryThreadStore()
    controller.clearReceipt()
  }
  // The open chat's view.
  const { id, temporary, local, unsaved, failure } = openState
  const choice = presetChoice()
  const model = choice.model ?? (openState.model || pickedModel)
  const webSearch = openState.webSearch ?? choice.webSearchEnabled
  const presetId = presetIdOf(openState, profile)
  const running =
    state.status === 'submitting' ||
    state.status === 'streaming' ||
    state.status === 'queued'
  const isLocalChat = local && !temporary
  const viewOf = (message: WireMessage, streaming: boolean) => {
    const kept = views.get(message)
    if (kept?.streaming === streaming && kept.summaries === state.summaries)
      return kept.view
    const view = messageView(message, streaming, state.summaries)
    views.set(message, { streaming, summaries: state.summaries, view })
    return view
  }
  const messages = state.messages.map((m, index) => {
    const view = viewOf(m, running && index === state.messages.length - 1)
    if (!onDevice(openState) || !view.attachments?.length) return view
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
  // The open chat is as recent as the latest message it shows, as one just
  // sent, before the list reports it.
  let shownActivity = 0
  for (const message of state.messages) {
    const at = Date.parse(message.createdAt)
    if (at > shownActivity) shownActivity = at
  }
  const shownRun = running ? state.runId : undefined
  const { cloudListed, pinnedListed, deviceListed } = list
  // Stored chats a refused key cannot open are left out, cached or not.
  const listsCloud = cloud && !keyLocked
  // The same list while nothing it shows changes, so a title the user just
  // typed is not animated in again.
  const chats = useMemo(() => {
    // A run this tab streams is active in the chat list before the list
    // next reports it, which it never does for a chat kept on the device.
    const liveRun = (listed: Chat): Chat => {
      if (listed.activeRun) return listed
      const runId =
        deviceRuns.get(listed.id)?.run?.runId ??
        (listed.id === id ? shownRun : undefined)
      return runId ? { ...listed, activeRun: { runId } } : listed
    }
    const recent = (listed: Chat): Chat =>
      listed.id === id && shownActivity > lastActive(listed)
        ? { ...listed, activityAt: new Date(shownActivity).toISOString() }
        : listed
    return [
      ...(listsCloud
        ? [
            ...cloudListed,
            ...pinnedListed.filter(
              (pin) => !cloudListed.some((chat) => chat.id === pin.id),
            ),
          ].map((t) => threadView(t))
        : []),
      ...deviceListed.map((t) => ({
        ...threadView(t),
        isLocalOnly: true,
      })),
    ]
      .map((listed) => recent(liveRun(listed)))
      .sort((a, b) => lastActive(b) - lastActive(a))
  }, [
    listsCloud,
    cloudListed,
    pinnedListed,
    deviceListed,
    deviceRuns,
    id,
    shownRun,
    shownActivity,
  ])
  // The favorites, the most recently pinned first.
  const favoriteIds = useMemo(
    () => (listsCloud ? pinnedListed.map((thread) => thread.id).reverse() : []),
    [listsCloud, pinnedListed],
  )
  const summary =
    state.snapshot.thread ??
    (openState.loadingId
      ? (isLocalChat
          ? list.deviceListed
          : [...list.cloudListed, ...list.pinnedListed]
        ).find((thread) => thread.id === openState.loadingId)
      : undefined)
  const loading =
    leavingChat ||
    openState.loadingId !== null ||
    (!!initialId && opened.current !== initialId && id !== initialId)
  const selectedId =
    openState.loadingId ??
    openState.failedId ??
    id ??
    (loading ? initialId : null)
  // A temporary chat is titled as one, whatever the harness names it, and a
  // new chat is untitled until its run reports it.
  const chat: Chat = summary
    ? {
        ...threadView(summary, messages),
        ...(temporary ? { title: TEMPORARY_CHAT_TITLE } : {}),
        ...(state.flagged ? { flagged: true } : {}),
        ...(webSearch !== undefined ? { webSearchEnabled: webSearch } : {}),
        isTemporary: temporary,
        isLocalOnly: isLocalChat,
        pendingSave: unsaved === summary.id,
        presetId: presetId ?? undefined,
      }
    : {
        id: selectedId ?? '',
        title: temporary
          ? TEMPORARY_CHAT_TITLE
          : loading
            ? 'Loading chat…'
            : DEFAULT_CHAT_TITLE,
        titleState: 'placeholder',
        messages,
        createdAt: new Date(),
        isBlankChat: !selectedId,
        isTemporary: temporary,
        isLocalOnly: isLocalChat,
        pendingSave: !!id && unsaved === id,
        model,
        projectId: onDevice(openState) ? undefined : (projectId ?? undefined),
        presetId: presetId ?? undefined,
        webSearchEnabled: webSearch,
        ...(state.flagged ? { flagged: true } : {}),
      }
  const profileFailed = cloud && !profileReady && !keyLocked && !!sessionError
  const queue: QueuedMessage[] = state.snapshot.queue.map((item) => ({
    id: item.queueId,
    text: item.content ?? '',
    ...(item.quote ? { quote: item.quote } : {}),
    ...(item.attachments?.length
      ? { attachments: queuedAttachmentViews(item.attachments) }
      : {}),
  }))
  return {
    chat,
    chats,
    favoriteIds,
    model,
    setModel: (next: string) => patch({ model: next, modelChosen: true }),
    presetId,
    selectPreset,
    setWebSearch: (next: boolean) => patch({ webSearch: next }),
    temporary,
    setTemporary: (next: boolean) => patch({ temporary: next }),
    local: isLocalChat,
    cloud,
    loading,
    notFound: openState.notFound,
    loadFailed: !!openState.failedId,
    retryOpen: () =>
      openState.failedId
        ? openChat(openState.failedId, { local: openState.local })
        : undefined,
    status: state.status,
    running,
    // The open chat takes turns once its settings load and, for a chat the
    // harness stores, once the content key is unlocked.
    canSend:
      !loading &&
      !openState.failedId &&
      profileReady &&
      (onDevice(openState) || keyReady),
    canChangeMessages: !loading && !openState.failedId && !!chat.id,
    queue,
    contextUsage: summary?.contextUsage ?? undefined,
    error: failure?.message || state.error?.message || '',
    errorDetail: failure ? failure.detail : state.error,
    errorAt: controller.errorAt,
    hasOlder: state.hasOlder,
    hasMoreChats: !!list.nextCursor,
    // The synced chats wait for the content key: a locked one for the user
    // to unlock it, and a profile that failed to load for another try.
    loadingChats: list.loading && !keyLocked && !profileFailed,
    chatListError: profileFailed ? sessionError : list.error,
    retryChatList: profileFailed
      ? () => void api.refresh().catch(reportHarnessError)
      : list.retry,
    report,
    open: openChat,
    ...turns,
    send(fields?: Partial<Turn>) {
      const current = open.get()
      if (!current.id && !current.model) patch({ model: pickedModel })
      return turns.send(fields)
    },
    ...actions,
    // A temporary chat saved while its reply streams is kept once no run of
    // it is left, so the reply is stored with it, unless it was left first.
    async saveTemporary() {
      const { id: threadId, temporary: isTemporary } = open.get()
      if (!threadId || !isTemporary) return
      await new Promise<void>((resolve) => {
        const check = () => {
          const { status } = controller.view.get()
          if (
            controller.deviceRuns.get().has(threadId) ||
            (open.get().id === threadId &&
              (status === 'submitting' ||
                status === 'streaming' ||
                status === 'queued'))
          )
            return
          stops.forEach((stop) => stop())
          resolve()
        }
        const stops = [
          open.subscribe(check),
          controller.view.subscribe(check),
          controller.deviceRuns.subscribe(check),
        ]
        check()
      })
      if (open.get().id === threadId) return actions.saveTemporary()
    },
    upload,
    loadImage: (attachment: UIAttachment, signal?: AbortSignal) =>
      openStore().image(open.get().id, attachment, signal),
    // The audio of a message of the open chat, read aloud by the harness.
    async speak(messageId: string, signal: AbortSignal): Promise<Response> {
      const threadId = open.get().id
      if (!threadId)
        throw new HarnessError({
          code: ERROR_CODES.threadNotFound,
          action: ERROR_ACTIONS.stop,
          message: 'This chat is not saved yet.',
        })
      return openStore().speech(threadId, messageId, signal)
    },
    // A document's text: a stored chat's messages leave it out, and the
    // harness reads it from the chat; a chat on this device keeps it.
    documentText: (attachment: UIAttachment): Promise<string> =>
      attachment.textContent !== undefined
        ? Promise.resolve(attachment.textContent)
        : openStore().documentText(open.get().id, attachment),
    // The thread an ask reads: a chat on this device sends its transcript.
    async askContext(): Promise<AskContext> {
      const threadId = open.get().id
      if (!threadId)
        throw new HarnessError({
          code: ERROR_CODES.threadNotFound,
          action: ERROR_ACTIONS.stop,
          message: 'This chat is not saved yet.',
        })
      return openStore().askContext(threadId, getView().profile)
    },
    refresh: () => list.refresh(),
    loadMoreChats: () => list.refresh(list.nextCursor ?? undefined),
    newChat,
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
