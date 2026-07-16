import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from 'openai'
import { describe, expect, it } from 'vitest'

import { isRetryableError } from '@/services/inference/inference-client'

function statusError(status: number) {
  return APIError.generate(status, undefined, undefined, new Headers())
}

describe('isRetryableError', () => {
  it('retries SDK transport failures, including request timeouts', () => {
    expect(isRetryableError(new APIConnectionError({}))).toBe(true)
    expect(isRetryableError(new APIConnectionTimeoutError())).toBe(true)
  })

  it('retries browser fetch network failures', () => {
    // fetch() rejects with a TypeError on network failure
    expect(isRetryableError(new TypeError('Failed to fetch'))).toBe(true)
  })

  it('retries timeouts, rate limits, and server errors by HTTP status', () => {
    expect(isRetryableError(statusError(408))).toBe(true)
    expect(isRetryableError(statusError(409))).toBe(true)
    expect(isRetryableError(statusError(429))).toBe(true)
    expect(isRetryableError(statusError(503))).toBe(true)
  })

  it('does not retry user aborts', () => {
    expect(isRetryableError(new APIUserAbortError())).toBe(false)
    expect(isRetryableError(new DOMException('Aborted', 'AbortError'))).toBe(
      false,
    )
  })

  it('does not retry client errors or unclassified errors', () => {
    expect(isRetryableError(statusError(400))).toBe(false)
    expect(isRetryableError(statusError(401))).toBe(false)
    // A bare Error carrying a transport-sounding message is not enough
    expect(isRetryableError(new Error('Connection error.'))).toBe(false)
    expect(isRetryableError(undefined)).toBe(false)
  })
})
