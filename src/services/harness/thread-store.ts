import type { Attachment as UIAttachment } from '@/components/chat/types'
import { imageBlob, type OpenAttachments } from './open-attachments'
import { ROUTES } from './protocol'
import type { DeviceRun } from './run-controller'
import type { HarnessAPI, Profile } from './runtime'
import type {
  FollowInput,
  Thread,
  ThreadMessage,
  ThreadSummary,
  Turn,
} from './types'

// A change to a chat's settings.
export interface ThreadPatch {
  title?: string
  model?: string
  presetId?: string | null
  webSearchEnabled?: boolean
  pinned?: boolean
  projectId?: string | null
}

// What a turn starts a chat with, as the open chat holds it.
export interface TurnSettings {
  // The chat has no turn the harness accepted, or no copy on this device.
  first: boolean
  presetId: string | null
  presetChosen: boolean
  projectId?: string | null
  profile: Profile
}

export interface PreparedTurn {
  input: Turn
  // The input the turn is sent again with to reconnect.
  resend: Turn
  run?: DeviceRun
  // Keeps the message the turn adds until its run returns the thread.
  keep?(message: ThreadMessage): Promise<void>
}

export type AskContext = Pick<
  Turn,
  'key' | 'threadId' | 'local' | 'thread' | 'profile'
>

// Where a chat is stored: the harness keeps a chat in the cloud and is
// named it by id and key; a chat on this device is kept by the browser and
// sent with each turn. Actions go through the open chat's store instead of
// asking where it lives.
export interface ThreadStore {
  // Turns carry the chat itself rather than the content key.
  readonly local: boolean
  get(threadId: string): Promise<Thread | null>
  // The messages before `before` that the view does not show yet.
  older(
    threadId: string,
    before: string | undefined,
  ): Promise<Pick<Thread, 'messages' | 'hasOlder'>>
  update(threadId: string, patch: ThreadPatch): Promise<ThreadSummary | null>
  remove(threadId: string): Promise<void>
  // Copies the chat through a message into a new chat, and names it.
  fork(threadId: string, messageId: string): Promise<string | null>
  deleteMessage(threadId: string, messageId: string): Promise<Thread | null>
  editReply(
    threadId: string,
    messageId: string,
    content: string,
  ): Promise<Thread | null>
  share(threadId: string): Promise<string>
  // The audio of a message read aloud, as one stream.
  speech(
    threadId: string,
    messageId: string,
    signal: AbortSignal,
  ): Promise<Response>
  // The key a turn and its run carry; reading it may refuse.
  runKey(): { key?: string }
  // A turn of the chat: the fields every turn has, and the action's own.
  prepareTurn(
    threadId: string,
    turn: { defaults: Turn; fields: Partial<Turn>; key: { key?: string } },
    settings: TurnSettings,
  ): Promise<PreparedTurn | null>
  // A run of the chat that may still be live.
  liveRun(thread: Thread): string | undefined
  follow(
    threadId: string,
    runId: string,
  ): Promise<{ input: FollowInput; device?: DeviceRun }>
  askContext(threadId: string, profile: Profile): Promise<AskContext>
  documentText(
    threadId: string | null,
    attachment: UIAttachment,
  ): Promise<string>
  image(
    threadId: string | null,
    attachment: UIAttachment,
    signal?: AbortSignal,
  ): Promise<Blob>
}

// The changes a store makes to the chat list it belongs to, shown before
// the list is next read.
export interface ListEdits {
  // A chat new to the list, as a fork or a chat moved here.
  add(summary: ThreadSummary): void
  replace(summary: ThreadSummary): void
  remove(threadId: string): void
}

const summaryOf = ({
  messages: _messages,
  hasOlder: _hasOlder,
  revision: _revision,
  presetId: _presetId,
  ...summary
}: Thread): ThreadSummary => summary

export function cloudThreads(
  api: HarnessAPI,
  list: ListEdits,
  attachments: OpenAttachments,
): ThreadStore {
  const download = (
    threadId: string | null,
    attachment: UIAttachment,
    signal?: AbortSignal,
  ) =>
    api.download(
      ROUTES.attachmentGet,
      { id: attachment.id, ...(threadId ? { threadId } : {}) },
      { signal },
    )
  // The harness changes a stored chat's message and answers with its
  // latest window.
  const changeMessage = async (
    path: typeof ROUTES.messageDelete | typeof ROUTES.messageUpdate,
    input: { threadId: string; messageId: string; content?: string },
  ) => {
    const thread = await api.post<Thread>(path, input)
    list.replace(summaryOf(thread))
    return thread
  }
  // The latest change asked of each chat, so an earlier change answered
  // after it does not list the chat as it was before the latest.
  const latestUpdate = new Map<string, number>()
  let updates = 0
  return {
    local: false,
    get: (threadId) => api.post<Thread>(ROUTES.get, { id: threadId }),
    older: (threadId, before) =>
      api.post<Thread>(ROUTES.get, { id: threadId, before }),
    async update(threadId, patch) {
      const update = ++updates
      latestUpdate.set(threadId, update)
      const summary = await api.post<ThreadSummary>(ROUTES.update, {
        id: threadId,
        ...patch,
      })
      if (latestUpdate.get(threadId) === update) list.replace(summary)
      return summary
    },
    async remove(threadId) {
      await api.post(ROUTES.delete, { id: threadId })
      list.remove(threadId)
    },
    async fork(threadId, messageId) {
      const forked = await api.post<ThreadSummary>(ROUTES.fork, {
        threadId,
        messageId,
      })
      list.add(forked)
      return forked.id
    },
    deleteMessage: (threadId, messageId) =>
      changeMessage(ROUTES.messageDelete, { threadId, messageId }),
    editReply: (threadId, messageId, content) =>
      changeMessage(ROUTES.messageUpdate, { threadId, messageId, content }),
    async share(threadId) {
      const { url } = await api.post<{ url: string }>(ROUTES.share, {
        threadId,
      })
      return url
    },
    speech: (threadId, messageId, signal) =>
      api.stream(ROUTES.speech, { threadId, messageId }, { signal }),
    runKey: () => ({ key: api.key() }),
    async prepareTurn(threadId, { defaults, fields, key }, settings) {
      const { first, presetChosen, presetId, projectId } = settings
      const input: Turn = {
        ...defaults,
        ...key,
        threadId,
        projectId: first ? projectId : undefined,
        // The harness starts a stored chat with the default prompt when its
        // first turn names none, and keeps a first turn's choice, null too.
        presetId: first && presetChosen ? presetId : undefined,
        ...fields,
      }
      return { input, resend: { ...input, key: undefined } }
    },
    liveRun: (thread) => thread.activeRun?.runId,
    async follow(threadId, runId) {
      return { input: { key: api.key(), threadId, runId } }
    },
    async askContext(threadId) {
      return { key: api.key(), threadId }
    },
    documentText: (threadId, attachment) =>
      attachments.text(attachment.id, async () =>
        (await download(threadId, attachment)).text(),
      ),
    // The file the user picked while this page holds it, or else the copy
    // the harness stored.
    async image(threadId, attachment, signal) {
      const original = attachments.originals.get(attachment.id)
      return original
        ? imageBlob(original)
        : download(threadId, attachment, signal)
    },
  }
}
