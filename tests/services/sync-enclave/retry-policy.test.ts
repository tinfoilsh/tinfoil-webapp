import { describe, expect, it, vi } from 'vitest'

import {
  computeBackoffDelay,
  runWithRetry,
  type RetryScheduler,
} from '@/services/sync-enclave/retry-policy'

function makeScheduler(): { scheduler: RetryScheduler; sleeps: number[] } {
  const sleeps: number[] = []
  let randomCursor = 0
  const randomSequence = [0.5, 0.5, 0.5, 0.5, 0.5, 0.5]
  return {
    sleeps,
    scheduler: {
      sleep: async (ms: number) => {
        sleeps.push(ms)
      },
      random: () => randomSequence[randomCursor++ % randomSequence.length],
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

describe('runWithRetry', () => {
  it('retries up to maxAttempts when shouldRetry is true', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('1'))
      .mockRejectedValueOnce(new Error('2'))
      .mockResolvedValueOnce('ok')
    const { scheduler, sleeps } = makeScheduler()

    const result = await runWithRetry(fn, () => true, {
      baseDelayMs: 10,
      maxDelayMs: 40,
      maxAttempts: 4,
      scheduler,
    })

    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(3)
    expect(sleeps.length).toBe(2)
  })

  it('stops retrying when shouldRetry returns false', async () => {
    const err = new Error('boom')
    const fn = vi.fn().mockRejectedValue(err)
    const { scheduler, sleeps } = makeScheduler()

    await expect(
      runWithRetry(fn, () => false, {
        baseDelayMs: 10,
        maxDelayMs: 40,
        maxAttempts: 4,
        scheduler,
      }),
    ).rejects.toBe(err)

    expect(fn).toHaveBeenCalledTimes(1)
    expect(sleeps.length).toBe(0)
  })

  it('throws the last error when maxAttempts is exhausted', async () => {
    const err = new Error('permanent flake')
    const fn = vi.fn().mockRejectedValue(err)
    const { scheduler } = makeScheduler()

    await expect(
      runWithRetry(fn, () => true, {
        baseDelayMs: 1,
        maxDelayMs: 4,
        maxAttempts: 3,
        scheduler,
      }),
    ).rejects.toBe(err)

    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('fires onAttemptFailed exactly once per back-off wait', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('1'))
      .mockResolvedValueOnce('ok')
    const onAttemptFailed = vi.fn()
    const { scheduler } = makeScheduler()

    await runWithRetry(fn, () => true, {
      baseDelayMs: 5,
      maxDelayMs: 5,
      maxAttempts: 4,
      scheduler,
      onAttemptFailed,
    })

    expect(onAttemptFailed).toHaveBeenCalledTimes(1)
  })

  it('fires onAttemptFailed on a non-retriable failure', async () => {
    const err = new Error('terminal')
    const fn = vi.fn().mockRejectedValue(err)
    const onAttemptFailed = vi.fn()
    const { scheduler, sleeps } = makeScheduler()

    await expect(
      runWithRetry(fn, () => false, {
        baseDelayMs: 5,
        maxDelayMs: 5,
        maxAttempts: 4,
        scheduler,
        onAttemptFailed,
      }),
    ).rejects.toBe(err)

    expect(onAttemptFailed).toHaveBeenCalledTimes(1)
    expect(onAttemptFailed).toHaveBeenCalledWith({
      attempt: 0,
      delayMs: 0,
      error: err,
    })
    expect(sleeps.length).toBe(0)
  })

  it('fires onAttemptFailed on the final exhausted attempt', async () => {
    const err = new Error('always')
    const fn = vi.fn().mockRejectedValue(err)
    const onAttemptFailed = vi.fn()
    const { scheduler } = makeScheduler()

    await expect(
      runWithRetry(fn, () => true, {
        baseDelayMs: 1,
        maxDelayMs: 1,
        maxAttempts: 3,
        scheduler,
        onAttemptFailed,
      }),
    ).rejects.toBe(err)

    expect(onAttemptFailed).toHaveBeenCalledTimes(3)
    expect(onAttemptFailed.mock.calls[2][0]).toMatchObject({
      attempt: 2,
      delayMs: 0,
    })
  })

  it('does not leak real setTimeout calls', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('x'))
      .mockResolvedValueOnce('ok')
    const { scheduler } = makeScheduler()

    await runWithRetry(fn, () => true, {
      baseDelayMs: 1,
      maxDelayMs: 1,
      maxAttempts: 2,
      scheduler,
    })

    expect(setTimeoutSpy).not.toHaveBeenCalled()
    setTimeoutSpy.mockRestore()
  })
})
