import { uploadErrorMessage } from '@/components/chat/upload-error'
import { DAILY_RATE_LIMIT_MESSAGE } from '@/constants/rate-limits'
import { HarnessError } from '@/services/harness/sse'
import { describe, expect, it } from 'vitest'

describe('uploadErrorMessage', () => {
  it("shows a document failure's own explanation", () => {
    const message =
      'Document processing exceeded the time limit. Try splitting the document into smaller files.'
    expect(
      uploadErrorMessage(
        new HarnessError(
          {
            code: 'UPSTREAM_REFUSED',
            message,
            status: 502,
            upstreamCode: 'document_parser_timeout',
          },
          502,
        ),
      ),
    ).toBe(message)
  })

  it.each([
    [
      'document_parser_busy',
      7,
      'The document service is busy. Try again in 7 seconds.',
    ],
    [undefined, 1, 'Too many requests right now. Try again in 1 second.'],
    [
      undefined,
      undefined,
      'Too many requests right now. Try again in a moment.',
    ],
  ])(
    'says when a busy service (%s) can be tried again',
    (upstreamCode, retryAfter, expected) => {
      expect(
        uploadErrorMessage(
          new HarnessError(
            {
              code: 'RATE_LIMITED',
              message: 'parser busy',
              ...(retryAfter ? { retryAfter } : {}),
              ...(upstreamCode ? { upstreamCode } : {}),
            },
            429,
          ),
        ),
      ).toBe(expected)
    },
  )

  it('names the quota an upload exhausted', () => {
    const refusal = (kind: string) =>
      new HarnessError({ code: 'QUOTA_EXHAUSTED', message: 'quota', kind }, 429)
    expect(uploadErrorMessage(refusal('hourly'))).toBe(
      "You've reached your hourly usage limit.",
    )
    expect(uploadErrorMessage(refusal('free_daily'))).toBe(
      DAILY_RATE_LIMIT_MESSAGE,
    )
  })

  it('falls back for failures without a message', () => {
    expect(
      uploadErrorMessage(new Error(''), 'Unable to upload document.'),
    ).toBe('Unable to upload document.')
    expect(uploadErrorMessage('nope')).toBe('Failed to process document')
  })
})
