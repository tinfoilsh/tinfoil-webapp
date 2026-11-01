import { ERROR_CODES, ROUTES } from './protocol'
import { harnessAPI } from './runtime'
import { HarnessError } from './sse'
import type { SharedThread } from './types'

export const SHARE_TOO_LARGE_MESSAGE =
  'This chat is too large to share. Fork the part you want to share from one of its messages, then share the fork.'

// A share the harness or the share store refused for its size.
export function isShareTooLarge(error: unknown): boolean {
  return (
    error instanceof HarnessError &&
    (error.status === 413 ||
      error.detail.status === 413 ||
      error.code === ERROR_CODES.threadTooLarge)
  )
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
