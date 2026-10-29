import { logError } from '@/utils/error-handling'
import type { LocalThreadStore, Originals } from './local-threads'
import { ERROR_ACTIONS, ERROR_CODES, ROUTES } from './protocol'
import type { HarnessAPI } from './runtime'
import { HarnessError } from './sse'
import type { StoredThread, ThreadSummary } from './types'

export interface DeviceChatCopy {
  thread: StoredThread
  originals: Originals
}

// Moving a chat between the cloud and this device keeps its id. A chat on the
// device holds its attachments' content, so a move carries the content with
// it: /v1/threads/transcript returns a stored chat with every attachment
// inline, and /v1/threads/import stores a device chat in the cloud.

// A run of the chat is still streaming, so moving it now would leave the
// reply behind.
export function transferInFlight(): HarnessError {
  return new HarnessError(
    {
      code: ERROR_CODES.runInFlight,
      action: ERROR_ACTIONS.retry,
      message: 'Wait for the reply to finish before moving this chat.',
    },
    409,
  )
}

const alreadyOnDevice = () =>
  new HarnessError(
    {
      code: ERROR_CODES.threadExists,
      action: ERROR_ACTIONS.stop,
      message: 'This chat is already stored on this device.',
    },
    409,
  )

const CLIENT_ERROR_STATUS = 400
const SERVER_ERROR_STATUS = 500

// A request the harness refused, or that failed before it was sent, changed
// nothing. A server error may come after the change committed, and so may a
// request whose connection failed. A success this client could not read did
// commit.
function isRefusal(error: unknown): boolean {
  return (
    error instanceof HarnessError &&
    error.detail.code !== ERROR_CODES.connection &&
    (error.status === undefined ||
      (error.status >= CLIENT_ERROR_STATUS &&
        error.status < SERVER_ERROR_STATUS))
  )
}

// The harness could not read every attachment of a stored chat, so it was
// not moved.
export function isAttachmentsUnavailable(error: unknown): boolean {
  return (
    error instanceof HarnessError &&
    error.code === ERROR_CODES.attachmentsUnavailable
  )
}

// A stored chat as this device keeps it: the thread with every attachment's
// content inline.
async function cloudTranscript(
  api: HarnessAPI,
  threadId: string,
  signal?: AbortSignal,
): Promise<{ thread: StoredThread; revision: string }> {
  const result = await api.post<{ thread?: unknown; revision?: string }>(
    ROUTES.transcript,
    { threadId },
    { signal },
  )
  const thread = result?.thread
  if (
    !result?.revision ||
    !thread ||
    typeof thread !== 'object' ||
    Array.isArray(thread) ||
    !Array.isArray((thread as { messages?: unknown }).messages)
  )
    throw new HarnessError({
      code: ERROR_CODES.upstreamRefused,
      action: ERROR_ACTIONS.retry,
      message: 'The chat service returned an invalid chat.',
    })
  return {
    thread: { ...(thread as StoredThread), id: threadId },
    revision: result.revision,
  }
}

// Stores a chat on this device, then deletes its cloud copy. A deletion that
// was refused, by the harness or before it was sent, leaves the cloud copy,
// so the device copy is removed again and the chat stays where it was. One
// that failed in any other way, such as over a dropped connection or with a
// server error, may have committed, so the device copy, perhaps the only one
// left, is kept.
export async function placeOnDevice(
  api: HarnessAPI,
  store: LocalThreadStore,
  thread: StoredThread,
  originals?: Originals,
  revision?: string,
): Promise<StoredThread> {
  const saved = await store.add(thread, originals)
  if (!saved) throw alreadyOnDevice()
  try {
    await api.post(ROUTES.delete, {
      id: thread.id,
      ...(revision ? { revision } : {}),
    })
  } catch (cause) {
    if (!isRefusal(cause)) throw cause
    await store.delete(thread.id).catch((error) =>
      logError('Failed to remove a chat copied to this device', error, {
        component: 'transfer',
        action: 'placeOnDevice',
        metadata: { chatId: thread.id },
      }),
    )
    throw cause
  }
  return saved
}

export async function moveThreadToDevice(
  api: HarnessAPI,
  store: LocalThreadStore,
  threadId: string,
): Promise<StoredThread> {
  const { thread, revision } = await cloudTranscript(api, threadId)
  return placeOnDevice(api, store, thread, undefined, revision)
}

// A chat this device keeps, with the originals of its attachments.
async function deviceCopy(
  store: LocalThreadStore,
  threadId: string,
): Promise<DeviceChatCopy> {
  const thread = await store.get(threadId)
  if (!thread)
    throw new HarnessError(
      {
        code: ERROR_CODES.threadNotFound,
        action: ERROR_ACTIONS.stop,
        message: 'This chat is no longer stored on this device.',
      },
      404,
    )
  const originals = await store.originals(
    threadId,
    thread.messages.flatMap((message) =>
      (message.attachments ?? []).map((attachment) => attachment.id),
    ),
  )
  return { thread, originals }
}

// Stores a chat from one store of this device in another under the same id,
// as a temporary chat the user keeps, then deletes it from the first.
export async function moveThreadOnDevice(
  from: LocalThreadStore,
  to: LocalThreadStore,
  threadId: string,
): Promise<StoredThread> {
  const { thread, originals } = await deviceCopy(from, threadId)
  const saved = await to.add(thread, originals)
  if (!saved) throw alreadyOnDevice()
  await from.delete(threadId)
  return saved
}

// Stores a chat from this device in the cloud under the same id, then
// deletes it from the device. A failed import leaves the device copy as it
// was; when the device copy cannot be deleted, the cloud copy is deleted
// again. The device copy is returned, so a caller can put it back.
export async function moveThreadToCloud(
  api: HarnessAPI,
  store: LocalThreadStore,
  threadId: string,
): Promise<{ summary: ThreadSummary; original: DeviceChatCopy }> {
  const { thread: original, originals } = await deviceCopy(store, threadId)
  const summary = await api.post<ThreadSummary>(ROUTES.threadImport, {
    threadId,
    thread: original,
  })
  try {
    await store.delete(threadId)
  } catch (cause) {
    await api.post(ROUTES.delete, { id: threadId }).catch((error) =>
      logError('Failed to remove a chat copied to the cloud', error, {
        component: 'transfer',
        action: 'moveThreadToCloud',
        metadata: { chatId: threadId },
      }),
    )
    throw cause
  }
  return { summary, original: { thread: original, originals } }
}
