import type { Attachment as UIAttachment } from '@/components/chat/types'
import { forkChatTitle } from '@/constants/chat'
import { base64ToUint8Array } from '@/utils/binary-codec'
import { logError } from '@/utils/error-handling'
import { generateReverseId } from '@/utils/reverse-id'
import { turnProfile } from './local-profile'
import {
  heldImages,
  holdImages,
  isThread,
  localDocumentText,
  localSummary,
  localThreadView,
  newThread,
  now,
  replaceReplyText,
  shareThread,
  turnThread,
  withHeldImages,
  type LocalThreadStore,
} from './local-threads'
import { uploaded, type OpenAttachments } from './open-attachments'
import { ERROR_CODES, ROUTES } from './protocol'
import type { DeviceRun, RunController } from './run-controller'
import type { HarnessAPI } from './runtime'
import { MAX_SHARE_REQUEST_BYTES, requestBytes, shareTooLarge } from './shares'
import { HarnessError } from './sse'
import type { ListEdits, ThreadStore, TurnSettings } from './thread-store'
import type { StoredThread, TerminalEvent, Thread, Turn } from './types'

const notOnDevice = (what: string) =>
  new HarnessError({
    code: ERROR_CODES.threadNotFound,
    message: `This ${what} is not stored on this device.`,
  })

// A device run's final event carries the whole thread, which this device
// stores as it is, with the images it holds where the harness left them
// out. A title the user set on this device during the run stays.
export function storeRun(
  run: DeviceRun,
  event: TerminalEvent,
): Promise<StoredThread | null> {
  const thread = event.metadata?.thread
  if (!isThread(thread)) return Promise.resolve(null)
  return run.store.update(run.threadId, (stored) => ({
    ...thread,
    id: run.threadId,
    messages: withHeldImages(thread.messages, run.images),
    ...(stored?.titleState === 'manual'
      ? { title: stored.title, titleState: stored.titleState }
      : {}),
  }))
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
  // The chat as this device stores it. A new chat starts from an empty
  // thread.
  const transcript = async (
    threadId: string,
    settings?: Pick<TurnSettings, 'model' | 'presetId' | 'webSearch'>,
  ): Promise<StoredThread> =>
    (await store.get(threadId)) ??
    newThread(threadId, {
      model: settings?.model ?? '',
      presetId: settings?.presetId ?? null,
      webSearchEnabled: settings?.webSearch,
    })
  // A chat on this device changes its own copy, which its next turn sends.
  const changeMessage = async (
    threadId: string,
    change: (thread: StoredThread) => StoredThread | null,
  ) => {
    const changed = await store.update(
      threadId,
      (thread) => thread && change(thread),
    )
    return changed && localThreadView(changed)
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
    async update(threadId, patch) {
      const changed = await store.update(
        threadId,
        (thread) =>
          thread && {
            ...thread,
            ...(typeof patch.title === 'string'
              ? { title: patch.title, titleState: 'manual' as const }
              : {}),
            ...(typeof patch.model === 'string' ? { model: patch.model } : {}),
            ...('presetId' in patch
              ? { presetId: patch.presetId || null }
              : {}),
            ...(typeof patch.webSearchEnabled === 'boolean'
              ? { webSearchEnabled: patch.webSearchEnabled }
              : {}),
            updatedAt: now(),
          },
      )
      return changed && localSummary(changed)
    },
    async remove(threadId) {
      await store.delete(threadId)
      list.remove(threadId)
    },
    // A fork holds the messages through the chosen one, with its own
    // attachment ids, under a title that names it a fork.
    async fork(threadId, messageId) {
      const source = await transcript(threadId)
      const count =
        source.messages.findIndex((message) => message.id === messageId) + 1
      if (!count) return null
      const forkId = generateReverseId().id
      await store.update(forkId, () => ({
        ...newThread(forkId, source),
        title: forkChatTitle(source.title),
        titleState: 'manual',
        messages: source.messages.slice(0, count).map((message) =>
          message.attachments
            ? {
                ...message,
                attachments: message.attachments.map((attachment) => ({
                  ...attachment,
                  id: crypto.randomUUID(),
                })),
              }
            : message,
        ),
      }))
      return forkId
    },
    // Removes one message; its reply, or the message it answers, stays.
    deleteMessage: (threadId, messageId) =>
      changeMessage(threadId, (thread) =>
        thread.messages.length > 1 &&
        thread.messages.some((message) => message.id === messageId)
          ? {
              ...thread,
              messages: thread.messages.filter(
                (message) => message.id !== messageId,
              ),
              updatedAt: now(),
            }
          : null,
      ),
    // Rewrites a reply's text in place; later messages stay.
    editReply: (threadId, messageId, content) =>
      changeMessage(threadId, (thread) =>
        thread.messages.some(
          (message) => message.id === messageId && message.role === 'assistant',
        )
          ? {
              ...thread,
              messages: thread.messages.map((message) =>
                message.id === messageId
                  ? replaceReplyText(message, content)
                  : message,
              ),
              updatedAt: now(),
            }
          : null,
      ),
    // A chat kept on this device is shared from its own copy, which the
    // harness seals without storing it.
    async share(threadId) {
      const input = {
        local: true,
        threadId,
        thread: shareThread(await transcript(threadId)),
      }
      if (requestBytes(input) > MAX_SHARE_REQUEST_BYTES) throw shareTooLarge()
      const { url } = await api.post<{ url: string }>(ROUTES.share, input, {
        keyless: true,
      })
      return url
    },
    runKey: () => ({}),
    // A turn carries the thread and the settings a prompt reads instead of
    // the content key, which it never uses.
    async prepareTurn(threadId, { defaults, fields }, settings) {
      const run: DeviceRun = { threadId, store, images: new Map() }
      controller.begin(run)
      const shown = controller.track()
      let base: StoredThread
      try {
        base = await transcript(threadId, settings)
      } catch (cause) {
        controller.settle(run)
        throw cause
      }
      if (!shown()) return null
      const input: Turn = {
        ...defaults,
        ...fields,
        threadId,
        local: true,
        thread: turnThread(base),
        profile: turnProfile(settings.profile),
      }
      run.images = holdImages(
        uploaded(fields.attachments),
        heldImages(base.messages),
      )
      return {
        input,
        resend: input,
        run,
        // The chat keeps the message until the run returns the thread, so a
        // new chat is listed from its first message.
        keep: (message) =>
          store
            .update(threadId, () => ({
              ...base,
              messages: [...base.messages, message],
              updatedAt: message.createdAt,
            }))
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
      const receipt = controller.receipt()
      return (
        controller.deviceRuns.get().get(thread.id)?.runId ??
        (receipt?.local && receipt.threadId === thread.id
          ? receipt.runId
          : undefined)
      )
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
        },
      }
    },
    async askContext(threadId, profile) {
      return {
        threadId,
        local: true,
        thread: turnThread(await transcript(threadId)),
        profile: turnProfile(profile),
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
    async image(_threadId, attachment: UIAttachment) {
      const image = attachments.images.get(attachment.id)
      if (!image) throw notOnDevice('image')
      return new Blob([base64ToUint8Array(image.base64)], {
        type: image.mimeType || 'image/jpeg',
      })
    },
  }
}
