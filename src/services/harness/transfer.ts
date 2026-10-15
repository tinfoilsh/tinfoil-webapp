import { logError } from '@/utils/error-handling'
import {
  readLocalThread,
  type LocalThread,
  type LocalThreadStore,
  type LocalTurnThread,
} from './local-threads'
import type { HarnessAPI } from './runtime'
import { requestBytes } from './shares'
import { HarnessError } from './sse'
import type { ThreadSummary } from './types'

// Moving a chat between the cloud and this device keeps its id. A chat on the
// device holds its attachments' content, so a move carries the content with
// it: /v1/threads/transcript returns a stored chat with every attachment
// inline, and /v1/threads/import stores a device chat in the cloud.

// The harness reads an import of up to 64 MiB; the key and field names take
// a little of it.
const MAX_IMPORT_REQUEST_BYTES = 64 * 1024 * 1024 - 1024

function transferTooLarge(): HarnessError {
  return new HarnessError(
    {
      code: 'THREAD_TOO_LARGE',
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
      code: 'RUN_IN_FLIGHT',
      message: 'Wait for the reply to finish before moving this chat.',
    },
    409,
  )
}

// The harness could not read every attachment of a stored chat, so it was
// not moved.
export function isAttachmentsUnavailable(error: unknown): boolean {
  return (
    error instanceof HarnessError && error.code === 'ATTACHMENTS_UNAVAILABLE'
  )
}

// The transcript an import sends: the whole chat, with every attachment's
// content as this device stores it, which the harness stores under the chat.
function transferThread(thread: LocalThread): LocalTurnThread {
  const {
    id: _id,
    updatedAt: _updatedAt,
    contextUsage: _contextUsage,
    presetId,
    ...rest
  } = thread
  return { ...rest, presetId: presetId ?? null }
}

// A stored chat as this device keeps it: every attachment's content inline
// and no server bookkeeping.
export async function cloudTranscript(
  api: HarnessAPI,
  threadId: string,
  signal?: AbortSignal,
): Promise<LocalThread> {
  const result = await api.post<{ thread?: unknown }>(
    '/v1/threads/transcript',
    { threadId },
    signal,
  )
  const thread = result?.thread
  if (
    !thread ||
    typeof thread !== 'object' ||
    Array.isArray(thread) ||
    !Array.isArray((thread as { messages?: unknown }).messages)
  )
    throw new HarnessError({
      code: 'UPSTREAM_REFUSED',
      message: 'The chat service returned an invalid chat.',
    })
  return readLocalThread({
    ...(thread as Record<string, unknown>),
    id: threadId,
  })
}

// Stores a chat on this device, then deletes its cloud copy. When the cloud
// copy cannot be deleted, the device copy is removed again, so the chat stays
// where it was.
export async function placeOnDevice(
  api: HarnessAPI,
  store: LocalThreadStore,
  thread: LocalThread,
): Promise<LocalThread> {
  const saved = await store.add(thread)
  if (!saved)
    throw new HarnessError(
      {
        code: 'THREAD_EXISTS',
        message: 'This chat is already stored on this device.',
      },
      409,
    )
  try {
    await api.post('/v1/threads/delete', { id: thread.id })
  } catch (cause) {
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
): Promise<LocalThread> {
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
): Promise<{ summary: ThreadSummary; original: LocalThread }> {
  const original = await store.get(threadId)
  if (!original)
    throw new HarnessError(
      {
        code: 'THREAD_NOT_FOUND',
        message: 'This chat is no longer stored on this device.',
      },
      404,
    )
  const input = { threadId, thread: transferThread(original) }
  if (requestBytes(input) > MAX_IMPORT_REQUEST_BYTES) throw transferTooLarge()
  const summary = await api.post<ThreadSummary>('/v1/threads/import', input)
  try {
    await store.delete(threadId)
  } catch (cause) {
    await api.post('/v1/threads/delete', { id: threadId }).catch((error) =>
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
