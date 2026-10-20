import { ERROR_CODES, ROUTES } from './protocol'
import { harnessAPI } from './runtime'
import { HarnessError } from './sse'
import type { SharedThread } from './types'

// The harness reads JSON requests of up to 8 MiB. A local chat's share
// carries its transcript, so a long chat with many thumbnails or documents
// can exceed it.
export const MAX_SHARE_REQUEST_BYTES = 8 * 1024 * 1024

// The harness reads a turn, and the other requests that carry whole chats,
// up to 64 MiB; the key and field names take a little of it.
export const MAX_TURN_REQUEST_BYTES = 64 * 1024 * 1024 - 1024

export const SHARE_TOO_LARGE_MESSAGE =
  'This chat is too large to share. Fork the part you want to share from one of its messages, then share the fork.'

export function shareTooLarge(): HarnessError {
  return new HarnessError(
    { code: ERROR_CODES.threadTooLarge, message: SHARE_TOO_LARGE_MESSAGE },
    413,
  )
}

// A share the harness or the share store refused for its size.
export function isShareTooLarge(error: unknown): boolean {
  return (
    error instanceof HarnessError &&
    (error.status === 413 ||
      error.detail.status === 413 ||
      error.code === ERROR_CODES.threadTooLarge)
  )
}

export function requestBytes(input: unknown): number {
  return new TextEncoder().encode(JSON.stringify(input)).byteLength
}

// Shares are keyed by the chat they share, so the owner can check and revoke
// one without its link, for stored and local chats alike.
export async function shareStatus(threadId: string): Promise<boolean> {
  const status = await harnessAPI().post<{ shared?: unknown }>(
    ROUTES.shareStatus,
    { threadId },
    { keyless: true },
  )
  if (typeof status?.shared !== 'boolean')
    throw new HarnessError({
      code: ERROR_CODES.upstreamRefused,
      message: 'The share status could not be read.',
    })
  return status.shared
}

export async function revokeShare(threadId: string): Promise<void> {
  await harnessAPI().post(ROUTES.shareRevoke, { threadId }, { keyless: true })
}

// Opens a share with the key its link carries, which the harness reads it
// with.
export function openShare(
  shareId: string,
  shareKeyHex: string,
): Promise<SharedThread> {
  return harnessAPI().post<SharedThread>(
    ROUTES.shareOpen,
    { shareId, fragment: `v2:${shareKeyHex}` },
    { keyless: true },
  )
}

// An attachment of a share, read with the key the share gives it.
export function sharedAttachment(
  id: string,
  attKey: string,
  signal?: AbortSignal,
): Promise<Blob> {
  return harnessAPI().download(
    ROUTES.attachmentGetPublic,
    { id, attKey },
    { signal, keyless: true },
  )
}
