import { AuthTokenUnavailableError } from '@/services/auth'
import { UploadCoalescer } from '@/services/cloud/upload-coalescer'
import {
  computeBackoffDelay,
  type RetryScheduler,
} from '@/services/sync-enclave/retry-policy'
import {
  SyncEnclaveError,
  SyncNetworkError,
  SyncPersistentAuthError,
} from '@/services/sync-enclave/sync-enclave-client'
import { AttestationError } from 'tinfoil'
import { describe, expect, it, vi } from 'vitest'

function makeScheduler(): { scheduler: RetryScheduler; sleeps: number[] } {
  const sleeps: number[] = []
  return {
    sleeps,
    scheduler: {
      sleep: async (ms: number) => {
        sleeps.push(ms)
      },
      random: () => 0.5,
    },
  }
}

describe('computeBackoffDelay', () => {
  it('produces full-jitter exponential growth capped at maxDelay', () => {
    expect(computeBackoffDelay(0, 1000, 8000, 0.5)).toBe(500)
    expect(computeBackoffDelay(1, 1000, 8000, 0.5)).toBe(1000)
    expect(computeBackoffDelay(2, 1000, 8000, 0.5)).toBe(2000)
    expect(computeBackoffDelay(3, 1000, 8000, 0.5)).toBe(4000)
    expect(computeBackoffDelay(4, 1000, 8000, 0.5)).toBe(4000)
    expect(computeBackoffDelay(10, 1000, 8000, 0.5)).toBe(4000)
  })

  it('returns 0 when random01 = 0', () => {
    expect(computeBackoffDelay(3, 1000, 8000, 0)).toBe(0)
  })
})

describe('UploadCoalescer retry policy', () => {
  it('retries one prepared upload with the exact backoff sequence', async () => {
    const attempt = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new SyncNetworkError())
      .mockRejectedValueOnce(new SyncNetworkError())
      .mockResolvedValueOnce(undefined)
    const prepare = vi.fn(async () => attempt)
    const { scheduler, sleeps } = makeScheduler()
    const coalescer = new UploadCoalescer(prepare, {
      baseDelayMs: 10,
      maxDelayMs: 40,
      maxRetries: 3,
      scheduler,
    })
    await coalescer.enqueueAndWait('chat-1')
    expect(prepare).toHaveBeenCalledOnce()
    expect(prepare).toHaveBeenCalledWith(
      'chat-1',
      expect.stringMatching(/^[0-9a-f]{32}$/),
    )
    expect(attempt).toHaveBeenCalledTimes(3)
    expect(sleeps).toEqual([5, 10])
    expect(coalescer.hasPendingUpload('chat-1')).toBe(false)
  })

  it.each([
    new SyncEnclaveError('opaque', 403, 'FORBIDDEN'),
    new AttestationError('localized opaque failure'),
    new SyncPersistentAuthError(),
  ])('does not retry a terminal security failure: %s', async (error) => {
    const attempt = vi.fn<() => Promise<void>>().mockRejectedValue(error)
    const { scheduler, sleeps } = makeScheduler()
    const coalescer = new UploadCoalescer(async () => attempt, { scheduler })
    await expect(coalescer.enqueueAndWait('chat-1')).rejects.toBe(error)
    expect(attempt).toHaveBeenCalledOnce()
    expect(sleeps).toEqual([])
  })

  it('rejects with the final distinct error after exhausting retries', async () => {
    const first = new SyncNetworkError({ cause: new Error('first') })
    const last = new SyncNetworkError({ cause: new Error('last') })
    const attempt = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(first)
      .mockRejectedValue(last)
    const { scheduler, sleeps } = makeScheduler()
    const coalescer = new UploadCoalescer(async () => attempt, {
      baseDelayMs: 10,
      maxDelayMs: 40,
      maxRetries: 2,
      scheduler,
    })
    await expect(coalescer.enqueueAndWait('chat-1')).rejects.toBe(last)
    expect(attempt).toHaveBeenCalledTimes(3)
    expect(sleeps).toEqual([5, 10])
  })

  it('rejects unavailable authentication before preparing another upload', async () => {
    const error = new AuthTokenUnavailableError('unavailable')
    const prepare = vi.fn().mockRejectedValue(error)
    const { scheduler, sleeps } = makeScheduler()
    const coalescer = new UploadCoalescer(prepare, { scheduler })
    await expect(coalescer.enqueueAndWait('chat-1')).rejects.toBe(error)
    expect(prepare).toHaveBeenCalledOnce()
    expect(sleeps).toEqual([])
  })

  it('uses the injected scheduler without starting real timers', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    try {
      const attempt = vi
        .fn<() => Promise<void>>()
        .mockRejectedValueOnce(new SyncNetworkError())
        .mockResolvedValueOnce(undefined)
      const { scheduler, sleeps } = makeScheduler()
      const coalescer = new UploadCoalescer(async () => attempt, {
        baseDelayMs: 10,
        scheduler,
      })
      await coalescer.enqueueAndWait('chat-1')
      expect(attempt).toHaveBeenCalledTimes(2)
      expect(sleeps).toEqual([5])
      expect(setTimeoutSpy).not.toHaveBeenCalled()
    } finally {
      setTimeoutSpy.mockRestore()
    }
  })

  it('attempts once without sleeping when the retry budget is zero', async () => {
    const error = new SyncNetworkError()
    const attempt = vi.fn<() => Promise<void>>().mockRejectedValue(error)
    const { scheduler, sleeps } = makeScheduler()
    const coalescer = new UploadCoalescer(async () => attempt, {
      maxRetries: 0,
      scheduler,
    })
    await expect(coalescer.enqueueAndWait('chat-1')).rejects.toBe(error)
    expect(attempt).toHaveBeenCalledOnce()
    expect(sleeps).toEqual([])
  })

  it('uses four total attempts when the live retry budget is omitted', async () => {
    const error = new SyncNetworkError()
    const attempt = vi.fn<() => Promise<void>>().mockRejectedValue(error)
    const { scheduler, sleeps } = makeScheduler()
    const coalescer = new UploadCoalescer(async () => attempt, {
      baseDelayMs: 10,
      scheduler,
    })
    await expect(coalescer.enqueueAndWait('chat-1')).rejects.toBe(error)
    expect(attempt).toHaveBeenCalledTimes(4)
    expect(sleeps).toEqual([5, 10, 20])
  })
})
