import { harnessAPI } from './runtime'
import { HarnessError } from './sse'

// The harness reads JSON requests of up to 8 MiB. A local chat's share
// carries its transcript, so a long chat with many thumbnails or documents
// can exceed it.
export const MAX_SHARE_REQUEST_BYTES = 8 * 1024 * 1024

export const SHARE_TOO_LARGE_MESSAGE =
  'This chat is too large to share. Fork the part you want to share from one of its messages, then share the fork.'

export function shareTooLarge(): HarnessError {
  return new HarnessError(
    { code: 'THREAD_TOO_LARGE', message: SHARE_TOO_LARGE_MESSAGE },
    413,
  )
}

// A share the harness or the share store refused for its size.
export function isShareTooLarge(error: unknown): boolean {
  return (
    error instanceof HarnessError &&
    (error.status === 413 ||
      error.detail.status === 413 ||
      error.code === 'THREAD_TOO_LARGE')
  )
}

export function requestBytes(input: unknown): number {
  return new TextEncoder().encode(JSON.stringify(input)).byteLength
}

// Shares are keyed by the chat they share, so the owner can check and revoke
// one without its link, for stored and local chats alike.
export async function shareStatus(threadId: string): Promise<boolean> {
  const status = await harnessAPI().post<{ shared?: unknown }>(
    '/v1/threads/share/status',
    { threadId },
    undefined,
    false,
  )
  if (typeof status?.shared !== 'boolean')
    throw new HarnessError({
      code: 'UPSTREAM_REFUSED',
      message: 'The share status could not be read.',
    })
  return status.shared
}

export async function revokeShare(threadId: string): Promise<void> {
  await harnessAPI().post(
    '/v1/threads/share/revoke',
    { threadId },
    undefined,
    false,
  )
}
