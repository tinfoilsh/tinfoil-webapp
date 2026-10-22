import { isPresetModelAvailable } from '@/components/chat/prompts/preset-settings'
import type {
  Chat,
  QueuedMessage,
  Attachment as UIAttachment,
} from '@/components/chat/types'
import { ENCRYPTION_KEY_CHANGED_EVENT } from '@/services/encryption/encryption-service'
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
  type PresetChoice,
} from './open-chat'
import { ERROR_CODES, ROUTES } from './protocol'
import { useHarness } from './provider'
import { initialChat } from './reducer'
import { RunController } from './run-controller'
import { getView } from './runtime'
import { HarnessError } from './sse'
import { createStore, useStore } from './store'
import { cloudThreads, type AskContext, type ThreadStore } from './thread-store'
import type { AttachmentDescriptor, Thread } from './types'
import { messageView, threadView } from './view-model'

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
  const { api, session, profile, profileReady, keyReady, cloud, chatRevision } =
    useHarness()
  const [{ open, controller, attachments, moving, temporaryChats }] = useState(
    () => ({
      open: createStore<OpenChat>({
        id: null,
        temporary: false,
        local: !cloud || !!route.local || !!route.newChatLocal,
        unsaved: null,
        loadingId: null,
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
    report,
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
      failure: null,
      notFound: false,
      unsaved: null,
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
  async function openChat(
    threadId: string,
    options: { local?: boolean } = {},
  ): Promise<Thread | null> {
    const local = options.local ?? (!api.cloud || list.isOnDevice(threadId))
    reset()
    const shown = controller.track()
    patch({ loadingId: threadId, temporary: false, local })
    try {
      const store = local ? deviceStore : cloudStore
      const thread = await store.get(threadId)
      if (!shown()) return null
      if (!thread) {
        patch({ temporary: false, local, notFound: true })
        return null
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
      if (!runId) return thread
      const { input, device: run } = await store.follow(threadId, runId)
      if (!shown()) return null
      void controller.run(ROUTES.follow, input, { device: run, quiet: !!run })
      return thread
    } catch (cause) {
      if (!shown()) return null
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
    const current = open.get()
    if (!current.id) patch({ local: !cloud || !!route.newChatLocal })
    else if (!cloud && !onDevice(current)) {
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
    patch({ local: !api.cloud || !!options.local })
    temporaryChats.store = memoryThreadStore()
    controller.clearReceipt()
  }
  // The open chat's view.
  const { id, temporary, local, unsaved, failure } = openState
  const choice = presetChoice()
  const model = choice.model ?? openState.model
  const webSearch = openState.webSearch ?? choice.webSearchEnabled
  const presetId = presetIdOf(openState, profile)
  const running = state.status === 'streaming' || state.status === 'queued'
  const isLocalChat = local && !temporary
  const messages = state.messages.map((m, index) => {
    const view = messageView(
      m,
      running && index === state.messages.length - 1,
      state.summaries,
    )
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
  // A run this tab streams is active in the chat list before the list next
  // reports it, which it never does for a chat kept on the device.
  const liveRun = (listed: Chat): Chat => {
    if (listed.activeRun) return listed
    const runId =
      deviceRuns.get(listed.id)?.runId ??
      (listed.id === id && running ? state.runId : undefined)
    return runId ? { ...listed, activeRun: { runId } } : listed
  }
  const summary =
    state.snapshot.thread ??
    (openState.loadingId
      ? (isLocalChat
          ? list.deviceListed
          : [...list.cloudListed, ...list.pinnedListed]
        ).find((thread) => thread.id === openState.loadingId)
      : undefined)
  const selectedId = openState.loadingId ?? id
  const chat: Chat = summary
    ? {
        ...threadView(summary, messages),
        ...(state.flagged ? { flagged: true } : {}),
        ...(webSearch !== undefined ? { webSearchEnabled: webSearch } : {}),
        isTemporary: temporary,
        isLocalOnly: isLocalChat,
        pendingSave: unsaved === summary.id,
        presetId: presetId ?? undefined,
      }
    : {
        id: selectedId ?? '',
        title: openState.loadingId ? 'Loading chat…' : 'New Chat',
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
  const queue: QueuedMessage[] = state.snapshot.queue.map((item) => ({
    id: item.queueId,
    text: item.content,
  }))
  return {
    chat,
    chats: [
      ...(cloud
        ? [
            ...list.cloudListed,
            ...list.pinnedListed.filter(
              (pin) => !list.cloudListed.some((chat) => chat.id === pin.id),
            ),
          ].map((t) => threadView(t))
        : []),
      ...list.deviceListed.map((t) => ({
        ...threadView(t),
        isLocalOnly: true,
      })),
    ]
      .map(liveRun)
      .sort(
        (a, b) =>
          new Date(b.activityAt ?? b.createdAt).getTime() -
          new Date(a.activityAt ?? a.createdAt).getTime(),
      ),
    model,
    setModel: (next: string) => patch({ model: next, modelChosen: true }),
    presetId,
    selectPreset,
    setWebSearch: (next: boolean) => patch({ webSearch: next }),
    temporary,
    setTemporary: (next: boolean) => patch({ temporary: next }),
    local: isLocalChat,
    cloud,
    loading: openState.loadingId !== null,
    notFound: openState.notFound,
    status: state.status,
    running,
    // The open chat takes turns once its settings load and, for a chat the
    // harness stores, once the content key is unlocked.
    canSend:
      !openState.loadingId && profileReady && (onDevice(openState) || keyReady),
    canChangeMessages: !openState.loadingId && !!chat.id,
    queue,
    contextUsage: summary?.contextUsage ?? undefined,
    error: failure?.message || state.error?.message || '',
    errorDetail: failure ? failure.detail : state.error,
    errorAt: controller.errorAt,
    hasOlder: state.hasOlder,
    hasMoreChats: !!list.nextCursor,
    report,
    open: openChat,
    ...turns,
    ...actions,
    upload,
    loadImage: (attachment: UIAttachment, signal?: AbortSignal) =>
      openStore().image(open.get().id, attachment, signal),
    // The audio of a message of the open chat, read aloud by the harness.
    async speak(messageId: string, signal: AbortSignal): Promise<Response> {
      const threadId = open.get().id
      if (!threadId)
        throw new HarnessError({
          code: ERROR_CODES.threadNotFound,
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
      if (!threadId) return { key: api.key(), threadId: null }
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
