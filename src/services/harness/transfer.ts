import { logError } from '@/utils/error-handling'
import type { LocalThreadStore } from './local-threads'
import { ERROR_CODES, ROUTES } from './protocol'
import type { HarnessAPI } from './runtime'
import { MAX_TURN_REQUEST_BYTES, requestBytes } from './shares'
import { HarnessError } from './sse'
import type { StoredThread, ThreadSummary } from './types'

// Moving a chat between the cloud and this device keeps its id. A chat on the
// device holds its attachments' content, so a move carries the content with
// it: /v1/threads/transcript returns a stored chat with every attachment
// inline, and /v1/threads/import stores a device chat in the cloud.

function transferTooLarge(): HarnessError {
  return new HarnessError(
    {
      code: ERROR_CODES.threadTooLarge,
      message: 'This chat is too large to move to the cloud.',
    },
    413,
  )
}

// A run of the chat is still streaming, so moving it now would leave the
// reply behind.
export function transferInFlight(): HarnessError {
  return new HarnessError(
    {
      code: ERROR_CODES.runInFlight,
      message: 'Wait for the reply to finish before moving this chat.',
    },
    409,
  )
}

const SERVER_ERROR_STATUS = 500

// A request the harness refused, or that failed before it was sent, changed
// nothing. A server error may come after the change committed.
function isRefusal(error: unknown): boolean {
  return (
    error instanceof HarnessError &&
    (error.status === undefined || error.status < SERVER_ERROR_STATUS)
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
export async function cloudTranscript(
  api: HarnessAPI,
  threadId: string,
  signal?: AbortSignal,
): Promise<StoredThread> {
  const result = await api.post<{ thread?: unknown }>(
    ROUTES.transcript,
    { threadId },
    { signal },
  )
  const thread = result?.thread
  if (
    !thread ||
    typeof thread !== 'object' ||
    Array.isArray(thread) ||
    !Array.isArray((thread as { messages?: unknown }).messages)
  )
    throw new HarnessError({
      code: ERROR_CODES.upstreamRefused,
      message: 'The chat service returned an invalid chat.',
    })
  return { ...(thread as StoredThread), id: threadId }
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
): Promise<StoredThread> {
  const saved = await store.add(thread)
  if (!saved)
    throw new HarnessError(
      {
        code: ERROR_CODES.threadExists,
        message: 'This chat is already stored on this device.',
      },
      409,
    )
  try {
    await api.post(ROUTES.delete, { id: thread.id })
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
  return placeOnDevice(api, store, await cloudTranscript(api, threadId))
}

// Stores a chat from this device in the cloud under the same id, then
// deletes it from the device. A failed import leaves the device copy as it
// was; when the device copy cannot be deleted, the cloud copy is deleted
// again. The device copy is returned, so a caller can put it back.
export async function moveThreadToCloud(
  api: HarnessAPI,
  store: LocalThreadStore,
  threadId: string,
): Promise<{ summary: ThreadSummary; original: StoredThread }> {
  const original = await store.get(threadId)
  if (!original)
    throw new HarnessError(
      {
        code: ERROR_CODES.threadNotFound,
        message: 'This chat is no longer stored on this device.',
      },
      404,
    )
  const input = { threadId, thread: original }
  if (requestBytes(input) > MAX_TURN_REQUEST_BYTES) throw transferTooLarge()
  const summary = await api.post<ThreadSummary>(ROUTES.threadImport, input)
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
  return { summary, original }
}
