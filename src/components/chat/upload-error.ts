import { DAILY_RATE_LIMIT_MESSAGE } from '@/constants/rate-limits'
import { HarnessError } from '@/services/harness/sse'

// What an upload refusal tells the user. A document the harness could not
// convert carries the document service's own explanation as its message.
export function uploadErrorMessage(
  error: unknown,
  fallback = 'Failed to process document',
): string {
  if (error instanceof HarnessError) {
    const { code, kind, retryAfter, upstreamCode } = error.detail
    if (code === 'RATE_LIMITED') {
      const subject = upstreamCode?.startsWith('document_')
        ? 'The document service is busy.'
        : 'Too many requests right now.'
      const wait = retryAfter
        ? `in ${retryAfter} second${retryAfter === 1 ? '' : 's'}`
        : 'in a moment'
      return `${subject} Try again ${wait}.`
    }
    if (code === 'QUOTA_EXHAUSTED')
      return kind === 'hourly'
        ? "You've reached your hourly usage limit."
        : DAILY_RATE_LIMIT_MESSAGE
    return error.message || fallback
  }
  return error instanceof Error && error.message ? error.message : fallback
}
