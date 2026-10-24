import type { Attachment as UIAttachment } from '@/components/chat/types'
import { logError } from '@/utils/error-handling'
import {
  heldImages,
  holdImages,
  isThread,
  localDocumentText,
  localSummary,
  localThreadView,
  newThread,
  shareThread,
  withHeldImages,
  type LocalThreadStore,
} from './local-threads'
import { imageBlob, uploaded, type OpenAttachments } from './open-attachments'
import { ERROR_ACTIONS, ERROR_CODES, ROUTES } from './protocol'
import type { DeviceRun, RunController } from './run-controller'
import { getView, type HarnessAPI } from './runtime'
import { HarnessError } from './sse'
import type { ListEdits, ThreadStore } from './thread-store'
import type { StoredThread, TerminalEvent, Thread, Turn } from './types'

const notOnDevice = (what: string) =>
  new HarnessError({
    code: ERROR_CODES.threadNotFound,
    action: ERROR_ACTIONS.stop,
    message: `This ${what} is not stored on this device.`,
  })

// The settings of a chat the user changes through the harness. A setting
// changed while a run goes keeps the user's value when the run's thread is
// stored.
const USER_SETTINGS = [
  'title',
  'titleState',
  'model',
  'presetId',
  'webSearchEnabled',
] as const
type UserSetting = (typeof USER_SETTINGS)[number]

const pick = (thread: StoredThread, settings: readonly string[]) =>
  Object.fromEntries(
    USER_SETTINGS.filter((setting) => settings.includes(setting)).map(
      (setting) => [setting, thread[setting]],
    ),
  ) as Partial<Pick<StoredThread, UserSetting>>

// The routes that change a chat on this device: the browser sends the chat,
// and the harness answers with it changed.
type ChangeRoute =
  | typeof ROUTES.update
  | typeof ROUTES.messageDelete
  | typeof ROUTES.messageUpdate
  | typeof ROUTES.fork

// A device run's final event carries the whole thread, which this device
// stores with the images it holds where the harness left them out, and the
// originals of the images the turn sent. The settings the user changed
// after the run's turn read the chat keep the user's values.
export function storeRun(
  run: DeviceRun,
  event: TerminalEvent,
  changedSince: readonly string[],
): Promise<StoredThread | null> {
  const thread = event.metadata?.thread
  if (!isThread(thread)) return Promise.resolve(null)
  return run.store.update(
    run.threadId,
    (stored) => ({
      ...thread,
      id: run.threadId,
      messages: withHeldImages(
        thread.messages,
        new Map([...heldImages(stored?.messages ?? []), ...run.images]),
      ),
      ...(stored ? pick(stored, changedSince) : {}),
    }),
    run.originals,
  )
}

// The chats a browser keeps: in IndexedDB for an account, in the tab for a
// signed-out visitor, or in memory for a temporary chat. Each turn carries
// the chat, and a run's final event returns it.
export function deviceThreads({
  api,
  store,
  controller,
  attachments,
  list,
  saved,
}: {
  api: HarnessAPI
  store: LocalThreadStore
  controller: RunController
  attachments: OpenAttachments
  list: ListEdits
  // The store holds a new chat now, so its route can open it.
  saved(threadId: string): void
}): ThreadStore {
  // The chat as this device stores it, or an empty one.
  const transcript = async (threadId: string): Promise<StoredThread> =>
    (await store.get(threadId)) ?? newThread(threadId)
  // The harness applies an operation to the chat this device sends it. The
  // chat it answers with keeps the images this device holds where the
  // harness left them out.
  const request = async (
    path: ChangeRoute,
    sent: StoredThread,
    fields: Record<string, unknown>,
  ): Promise<StoredThread> => {
    const { thread } = await api.post<{ thread?: unknown }>(
      path,
      { ...fields, local: true, thread: sent },
      { keyless: true },
    )
    if (!isThread(thread))
      throw new HarnessError({
        code: ERROR_CODES.upstreamRefused,
        action: ERROR_ACTIONS.retry,
        message: 'The chat service returned an invalid chat.',
      })
    return {
      ...thread,
      messages: withHeldImages(thread.messages, heldImages(sent.messages)),
    }
  }
  // Stores the changed chat in place of the copy it was made from. When a
  // run stored its thread meanwhile, the run's thread keeps its messages and
  // takes the settings the change made; a change of messages is dropped.
  const change = async (
    threadId: string,
    path: ChangeRoute,
    fields: Record<string, unknown>,
  ): Promise<StoredThread | null> => {
    const sent = await store.get(threadId)
    if (!sent) return null
    const changed = await request(path, sent, fields)
    const settings = USER_SETTINGS.filter(
      (setting) => changed[setting] !== sent[setting],
    )
    if (settings.length) controller.settingsChanged(threadId, settings)
    const before = JSON.stringify(sent)
    return store.update(threadId, (current) => {
      if (!current) return null
      if (JSON.stringify(current) === before)
        return { ...changed, id: threadId }
      return path === ROUTES.update
        ? { ...current, ...pick(changed, settings) }
        : null
    })
  }
  return {
    local: true,
    async get(threadId) {
      const thread = await store.get(threadId)
      if (!thread) return null
      attachments.rememberThread(thread)
      return localThreadView(thread)
    },
    // A run's window of a chat on this device starts later than the
    // device's copy, which holds the rest.
    async older(threadId, before) {
      const stored = await store.get(threadId)
      const messages = stored ? localThreadView(stored).messages : []
      const index = messages.findIndex((message) => message.id === before)
      return {
        messages: messages.slice(0, Math.max(index, 0)),
        hasOlder: false,
      }
    },
    // An update may apply a saved prompt, which the profile holds.
    async update(threadId, { pinned: _pinned, projectId: _project, ...patch }) {
      const changed = await change(threadId, ROUTES.update, {
        id: threadId,
        ...patch,
        profile: getView().profile,
      })
      return changed && localSummary(changed)
    },
    async remove(threadId) {
      await store.delete(threadId)
      list.remove(threadId)
    },
    // The harness makes the fork, a new chat under an id it chooses, which
    // this device stores beside the chat it came from.
    async fork(threadId, messageId) {
      const source = await store.get(threadId)
      if (!source) return null
      const forked = await request(ROUTES.fork, source, {
        threadId,
        messageId,
      })
      const originals = await store.originals(
        threadId,
        forked.messages.flatMap((message) =>
          (message.attachments ?? []).map((attachment) => attachment.id),
        ),
      )
      return (await store.add(forked, originals)) && forked.id
    },
    async deleteMessage(threadId, messageId) {
      const changed = await change(threadId, ROUTES.messageDelete, {
        threadId,
        messageId,
      })
      return changed && localThreadView(changed)
    },
    async editReply(threadId, messageId, content) {
      const changed = await change(threadId, ROUTES.messageUpdate, {
        threadId,
        messageId,
        content,
      })
      return changed && localThreadView(changed)
    },
    // A chat kept on this device is shared from its own copy, which the
    // harness seals without storing it.
    async share(threadId) {
      const input = {
        local: true,
        threadId,
        thread: shareThread(await transcript(threadId)),
      }
      const { url } = await api.post<{ url: string }>(ROUTES.share, input, {
        keyless: true,
      })
      return url
    },
    // The harness reads a message of the chat this device sends it.
    async speech(threadId, messageId, signal) {
      const thread = await store.get(threadId)
      if (!thread) throw notOnDevice('chat')
      return api.stream(
        ROUTES.speech,
        { local: true, thread, messageId },
        { signal, keyless: true },
      )
    },
    runKey: () => ({}),
    // A turn carries the thread as stored and the profile instead of the
    // content key, which it never uses. The harness makes a new chat from
    // its first turn, as it does a stored one.
    async prepareTurn(threadId, { defaults, fields }, settings) {
      const run: DeviceRun = {
        threadId,
        store,
        images: new Map(),
        since: controller.tick(),
      }
      controller.begin(run)
      const shown = controller.track()
      let stored: StoredThread | null
      try {
        stored = await store.get(threadId)
      } catch (cause) {
        controller.settle(run)
        throw cause
      }
      if (!shown()) return null
      const { first, presetChosen, presetId, profile } = settings
      const input: Turn = {
        ...defaults,
        ...(stored ? { thread: stored } : {}),
        presetId: first && presetChosen ? presetId : undefined,
        ...fields,
        threadId,
        local: true,
        profile,
      }
      const base = stored ?? newThread(threadId)
      const sent = uploaded(fields.attachments)
      run.images = holdImages(sent, heldImages(base.messages))
      run.originals = attachments.originalsOf(sent)
      return {
        input,
        resend: input,
        run,
        // The chat keeps the message until the run returns the thread, so a
        // new chat is listed from its first message.
        keep: (message) =>
          store
            .update(
              threadId,
              (current) => ({
                ...(current ?? base),
                messages: [...(current ?? base).messages, message],
                updatedAt: message.createdAt,
              }),
              run.originals,
            )
            .then((kept) => {
              if (kept) saved(threadId)
            })
            .catch((cause) =>
              logError('Failed to keep a sent message on this device', cause, {
                component: 'deviceThreads',
                action: 'keep',
              }),
            ),
      }
    },
    // A run this page started, or one a reloaded page left behind.
    liveRun(thread: Thread) {
      const runId = controller.deviceRuns.get().get(thread.id)?.runId
      if (runId) return { runId }
      const receipt = controller.receipt()
      return receipt?.threadId === thread.id ? receipt : undefined
    },
    async follow(threadId, runId) {
      return {
        input: { threadId, runId },
        device: controller.deviceRuns.get().get(threadId) ?? {
          threadId,
          store,
          images: holdImages(
            [...attachments.uploads.values()],
            heldImages((await transcript(threadId)).messages),
          ),
          since: controller.tick(),
        },
      }
    },
    async askContext(threadId, profile) {
      const thread = await store.get(threadId)
      return {
        threadId,
        local: true,
        ...(thread ? { thread } : {}),
        profile,
      }
    },
    // A chat on this device keeps a document's text in its descriptor.
    documentText: (threadId, attachment) =>
      attachments.text(attachment.id, async () => {
        const descriptor =
          attachments.uploads.get(attachment.id) ??
          (threadId ? await store.get(threadId) : null)?.messages
            .flatMap((message) => message.attachments ?? [])
            .find((candidate) => candidate.id === attachment.id)
        if (!descriptor) throw notOnDevice('document')
        return localDocumentText(descriptor)
      }),
    // The file the user picked when this device keeps it, or else the copy
    // the chat sends models.
    async image(threadId, attachment: UIAttachment) {
      const image =
        attachments.originals.get(attachment.id) ??
        (threadId
          ? (await store.originals(threadId, [attachment.id])).get(
              attachment.id,
            )
          : undefined) ??
        attachments.images.get(attachment.id)
      if (!image) throw notOnDevice('image')
      return imageBlob(image)
    },
  }
}
