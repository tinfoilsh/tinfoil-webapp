/**
 * Structured error classification for chat request failures. Control flow
 * (retries, banners, rate-limit handling) must branch on these codes, never
 * on error message text, which varies across browsers, SDKs, and locales.
 */
export type ChatErrorCode =
  // Transport/network failure (no HTTP response), including exhausted retries.
  | 'FETCH_ERROR'
  // The server responded with a non-429 error status (5xx, 4xx).
  | 'SERVER_ERROR'
  // Free-tier or per-request rate limit (HTTP 429 family).
  | 'RATE_LIMIT'
  // Per-account hourly usage cap.
  | 'HOURLY_LIMIT'

export class ChatError extends Error {
  /** HTTP status of the failed request, when one was received. */
  public status?: number

  constructor(
    message: string,
    public code: ChatErrorCode,
    options?: { status?: number },
  ) {
    super(message)
    this.name = 'ChatError'
    this.status = options?.status
  }
}
