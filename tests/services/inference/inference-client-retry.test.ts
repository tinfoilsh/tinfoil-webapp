import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from 'openai'
import { describe, expect, it, vi } from 'vitest'

import {
  generateRecoverySessionId,
  isRetryableError,
} from '@/services/inference/inference-client'

function statusError(status: number) {
  return APIError.generate(status, undefined, undefined, new Headers())
}

describe('isRetryableError', () => {
  it.each([
    new APIConnectionError({}),
    new APIConnectionTimeoutError(),
    // fetch() rejects with a TypeError on network failure
    new TypeError('Failed to fetch'),
  ])('retries SDK and browser transport failures: $name', (error) => {
    expect(isRetryableError(error)).toBe(true)
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

  it('generates fresh 128-bit recovery capabilities', () => {
    const entropy = [
      new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 255]),
      new Uint8Array([255, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0]),
    ]
    let calls = 0
    const random = vi
      .spyOn(crypto, 'getRandomValues')
      .mockImplementation((bytes) => {
        expect(bytes).toBeInstanceOf(Uint8Array)
        expect(bytes?.byteLength).toBe(16)
        if (!(bytes instanceof Uint8Array))
          throw new Error('Expected byte buffer')
        bytes.set(entropy[calls++])
        return bytes
      })
    try {
      expect(generateRecoverySessionId()).toBe(
        '000102030405060708090a0b0c0d0eff',
      )
      expect(generateRecoverySessionId()).toBe(
        'ff0e0d0c0b0a09080706050403020100',
      )
      expect(random).toHaveBeenCalledTimes(2)
      expect(random.mock.calls[0][0]).not.toBe(random.mock.calls[1][0])
    } finally {
      random.mockRestore()
    }
  })
})
