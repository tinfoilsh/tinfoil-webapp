/**
 * Upload Coalescer Tests
 */

import { UploadCoalescer } from '@/services/cloud/upload-coalescer'
import { SyncEnclaveError } from '@/services/sync-enclave/sync-enclave-client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock error handling
vi.mock('@/utils/error-handling', () => ({
  logInfo: vi.fn(),
  logError: vi.fn(),
}))

type AttemptImpl = (chatId: string, idempotencyKey: string) => Promise<void>

// Adapts a per-attempt mock to the coalescer's prepare contract: the
// prepare mock resolves to a frozen attempt closure delegating to
// `attemptFn`, mirroring how cloud-sync snapshots a chat once and
// returns an attempt bound to that snapshot.
function prepareWith(attemptFn: AttemptImpl) {
  return vi.fn(
    async (chatId: string, idempotencyKey: string) => () =>
      attemptFn(chatId, idempotencyKey),
  )
}

describe('UploadCoalescer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('Basic enqueue behavior', () => {
    it('handles multiple different chats in parallel', async () => {
      const releases: Array<() => void> = []
      const attemptFn = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            releases.push(resolve)
          }),
      )
      const prepareFn = prepareWith(attemptFn)
      const coalescer = new UploadCoalescer(prepareFn)

      coalescer.enqueue('chat-1')
      coalescer.enqueue('chat-2')
      coalescer.enqueue('chat-3')

      await vi.runAllTimersAsync()

      expect(attemptFn).toHaveBeenCalledTimes(3)
      expect(prepareFn).toHaveBeenCalledWith('chat-1', expect.any(String))
      expect(prepareFn).toHaveBeenCalledWith('chat-2', expect.any(String))
      expect(prepareFn).toHaveBeenCalledWith('chat-3', expect.any(String))
      expect(releases).toHaveLength(3)
      for (const release of releases) release()
      await coalescer.waitForAllUploads()
    })

    it('bounds concurrent uploads across different chats', async () => {
      const resolvers: Array<() => void> = []
      let active = 0
      let peakActive = 0
      const attemptFn = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            active++
            peakActive = Math.max(peakActive, active)
            resolvers.push(() => {
              active--
              resolve()
            })
          }),
      )
      const coalescer = new UploadCoalescer(prepareWith(attemptFn), {
        maxConcurrency: 2,
      })

      const uploads = ['chat-1', 'chat-2', 'chat-3', 'chat-4'].map((chatId) =>
        coalescer.enqueueAndWait(chatId),
      )
      await vi.advanceTimersByTimeAsync(0)

      expect(attemptFn).toHaveBeenCalledTimes(2)

      resolvers.shift()?.()
      await vi.advanceTimersByTimeAsync(0)
      expect(attemptFn).toHaveBeenCalledTimes(3)

      while (resolvers.length > 0) {
        resolvers.shift()?.()
        await vi.advanceTimersByTimeAsync(0)
      }
      await Promise.all(uploads)

      expect(peakActive).toBe(2)
    })

    it('waits for uploads that are queued behind the concurrency limit', async () => {
      const resolvers: Array<() => void> = []
      const attemptFn = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolvers.push(resolve)
          }),
      )
      const coalescer = new UploadCoalescer(prepareWith(attemptFn), {
        maxConcurrency: 1,
      })
      coalescer.enqueue('chat-1')
      coalescer.enqueue('chat-2')

      let completed = false
      const waiting = coalescer.waitForUpload('chat-2').then(() => {
        completed = true
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(completed).toBe(false)
      expect(attemptFn).toHaveBeenCalledTimes(1)

      resolvers.shift()?.()
      await vi.advanceTimersByTimeAsync(0)
      expect(attemptFn).toHaveBeenCalledTimes(2)
      expect(completed).toBe(false)

      resolvers.shift()?.()
      await waiting
      expect(completed).toBe(true)
    })

    it('gives a new generation fresh slots without stale worker accounting', async () => {
      const resolvers = new Map<string, () => void>()
      const attemptFn = vi.fn(
        (chatId: string) =>
          new Promise<void>((resolve) => {
            resolvers.set(chatId, resolve)
          }),
      )
      const coalescer = new UploadCoalescer(prepareWith(attemptFn), {
        maxConcurrency: 2,
      })
      coalescer.enqueue('old-chat-1')
      coalescer.enqueue('old-chat-2')
      await vi.advanceTimersByTimeAsync(0)
      expect(attemptFn).toHaveBeenCalledTimes(2)

      coalescer.clear()
      expect(coalescer.hasPendingUpload('old-chat-1')).toBe(false)
      expect(coalescer.hasPendingUpload('old-chat-2')).toBe(false)
      coalescer.enqueue('new-chat-1')
      coalescer.enqueue('new-chat-2')
      await vi.advanceTimersByTimeAsync(0)
      expect(attemptFn).toHaveBeenCalledTimes(4)

      coalescer.enqueue('new-chat-3')
      await vi.advanceTimersByTimeAsync(0)
      expect(attemptFn).toHaveBeenCalledTimes(4)

      resolvers.get('old-chat-1')?.()
      resolvers.get('old-chat-2')?.()
      await vi.advanceTimersByTimeAsync(0)
      expect(attemptFn).toHaveBeenCalledTimes(4)

      resolvers.get('new-chat-1')?.()
      await vi.advanceTimersByTimeAsync(0)
      expect(attemptFn).toHaveBeenCalledTimes(5)
      expect(attemptFn).toHaveBeenLastCalledWith(
        'new-chat-3',
        expect.any(String),
      )

      resolvers.get('new-chat-2')?.()
      resolvers.get('new-chat-3')?.()
      await coalescer.waitForAllUploads()
      expect(coalescer.hasPendingUpload('new-chat-3')).toBe(false)
    })

    it('completes without an attempt when prepare returns null', async () => {
      const prepareFn = vi.fn().mockResolvedValue(null)
      const coalescer = new UploadCoalescer(prepareFn)

      const wait = coalescer.enqueueAndWait('chat-1')
      await vi.runAllTimersAsync()

      await expect(wait).resolves.toBeUndefined()
      expect(prepareFn).toHaveBeenCalledTimes(1)
    })
  })

  describe('§9.6 R1 — idempotency key ownership', () => {
    it('disposes a frozen upload only after all retries finish', async () => {
      const dispose = vi.fn()
      const run = vi
        .fn()
        .mockRejectedValueOnce(new Error('flake'))
        .mockResolvedValueOnce(undefined)
      const prepareFn = vi.fn(async () => {
        const attempt = Object.assign(async () => run(), { dispose })
        return attempt
      })
      const coalescer = new UploadCoalescer(prepareFn, {
        baseDelayMs: 10,
        maxRetries: 2,
        scheduler: {
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          random: () => 0.9999,
        },
      })

      coalescer.enqueue('chat-1')
      await vi.advanceTimersByTimeAsync(0)
      expect(dispose).not.toHaveBeenCalled()
      await vi.runAllTimersAsync()

      expect(run).toHaveBeenCalledTimes(2)
      expect(dispose).toHaveBeenCalledOnce()
    })

    it('replays the frozen snapshot even when the source changes between retries', async () => {
      let source = 'v1'
      const seenPayloads: string[] = []
      const prepareFn = vi.fn(async () => {
        const snapshot = source
        return async () => {
          seenPayloads.push(snapshot)
          if (seenPayloads.length === 1) throw new Error('flake')
        }
      })

      const coalescer = new UploadCoalescer(prepareFn, {
        baseDelayMs: 10,
        maxRetries: 2,
        scheduler: {
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          random: () => 0.9999,
        },
      })

      coalescer.enqueue('chat-1')
      await vi.advanceTimersByTimeAsync(0) // First attempt fails
      source = 'v2' // An edit lands between attempts
      await vi.runAllTimersAsync()

      // The retry replays the snapshot captured at prepare time, not
      // the mutated source — that byte-identity is what lets the
      // enclave replay a committed-but-lost write instead of failing
      // with IDEMPOTENCY_CONFLICT.
      expect(seenPayloads).toEqual(['v1', 'v1'])
    })

    it('re-runs prepare when prepare itself fails before freezing a payload', async () => {
      const attemptFn = vi.fn().mockResolvedValue(undefined)
      const prepareFn = vi
        .fn()
        .mockRejectedValueOnce(new Error('flake'))
        .mockImplementation(
          async (chatId: string, idempotencyKey: string) => () =>
            attemptFn(chatId, idempotencyKey),
        )

      const coalescer = new UploadCoalescer(prepareFn, {
        baseDelayMs: 10,
        maxRetries: 3,
      })

      coalescer.enqueue('chat-1')
      await vi.runAllTimersAsync()

      expect(prepareFn).toHaveBeenCalledTimes(2)
      expect(attemptFn).toHaveBeenCalledTimes(1)
      // Still one logical write: both prepare calls carry the same key
      expect(prepareFn.mock.calls[0][1]).toBe(prepareFn.mock.calls[1][1])
    })
  })

  describe('Coalescing behavior', () => {
    it('waits for an existing upload without scheduling another write', async () => {
      let resolveUpload: (() => void) | undefined
      const attemptFn = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveUpload = resolve
          }),
      )
      const prepareFn = prepareWith(attemptFn)
      const coalescer = new UploadCoalescer(prepareFn)
      coalescer.enqueue('chat-1')
      await vi.advanceTimersByTimeAsync(0)

      const ensured = coalescer.ensureUploadAndWait('chat-1')
      let settled = false
      void ensured.then(() => {
        settled = true
      })
      await Promise.resolve()
      expect(settled).toBe(false)

      resolveUpload!()
      await ensured

      expect(settled).toBe(true)
      expect(prepareFn).toHaveBeenCalledOnce()
      expect(attemptFn).toHaveBeenCalledOnce()
    })

    it('coalesces rapid enqueues for the same chat', async () => {
      let resolveUpload: () => void
      let resolveSecond!: () => void
      const uploadPromise = new Promise<void>((resolve) => {
        resolveUpload = resolve
      })
      const attemptFn = vi
        .fn()
        .mockReturnValueOnce(uploadPromise)
        .mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              resolveSecond = resolve
            }),
        )
      const prepareFn = prepareWith(attemptFn)
      const coalescer = new UploadCoalescer(prepareFn)

      // First enqueue starts upload
      coalescer.enqueue('chat-1')
      await vi.advanceTimersByTimeAsync(0)

      // These should be coalesced since upload is in progress
      coalescer.enqueue('chat-1')
      coalescer.enqueue('chat-1')
      coalescer.enqueue('chat-1')

      // Still only one upload started
      expect(attemptFn).toHaveBeenCalledTimes(1)
      expect(coalescer.hasPendingUpload('chat-1')).toBe(true)

      // Complete first upload
      resolveUpload!()
      await vi.advanceTimersByTimeAsync(0)
      expect(attemptFn).toHaveBeenCalledTimes(2)
      expect(attemptFn.mock.calls[0][1]).not.toBe(attemptFn.mock.calls[1][1])
      resolveSecond()
      await vi.runAllTimersAsync()

      // Dirty flag was set, so one more upload
      expect(attemptFn).toHaveBeenCalledTimes(2)
    })
  })

  describe('Retry behavior', () => {
    it('retries failed uploads with exponential backoff', async () => {
      const sleep = vi.fn(
        (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
      )
      const attemptFn = vi
        .fn()
        .mockRejectedValueOnce(new Error('Network error'))
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce(undefined)
      const prepareFn = prepareWith(attemptFn)

      // Pin the jitter to its upper bound so the retry windows are
      // deterministic. With full-jitter exponential backoff
      // delay = floor(random() * min(maxDelay, baseDelay * 2**attempt)),
      // random()=0.9999 gives the worst-case wait per attempt.
      const coalescer = new UploadCoalescer(prepareFn, {
        baseDelayMs: 100,
        maxDelayMs: 400,
        maxRetries: 3,
        scheduler: {
          sleep,
          random: () => 0.9999,
        },
      })

      coalescer.enqueue('chat-1')

      // First attempt fails immediately
      await vi.advanceTimersByTimeAsync(0)
      expect(attemptFn).toHaveBeenCalledTimes(1)

      // Wait for first retry: max delay window = baseDelay * 2**0 = 100ms.
      await vi.advanceTimersByTimeAsync(100)
      expect(attemptFn).toHaveBeenCalledTimes(2)

      // Wait for second retry: max delay window = baseDelay * 2**1 = 200ms.
      await vi.advanceTimersByTimeAsync(200)
      expect(attemptFn).toHaveBeenCalledTimes(3)

      // All done
      await vi.runAllTimersAsync()
      expect(attemptFn).toHaveBeenCalledTimes(3)
      expect(sleep.mock.calls).toEqual([[99], [199]])
      const cappedSleep = vi.fn(async (_delay: number) => {})
      const cappedAttempt = vi
        .fn()
        .mockRejectedValueOnce(new Error('Retry one'))
        .mockRejectedValueOnce(new Error('Retry two'))
        .mockRejectedValueOnce(new Error('Retry three'))
        .mockResolvedValueOnce(undefined)
      await new UploadCoalescer(prepareWith(cappedAttempt), {
        baseDelayMs: 100,
        maxDelayMs: 150,
        maxRetries: 3,
        scheduler: { sleep: cappedSleep, random: () => 0.9999 },
      }).enqueueAndWait('capped-chat')
      expect(cappedSleep.mock.calls).toEqual([[99], [149], [149]])
      expect(cappedAttempt).toHaveBeenCalledTimes(4)
    })

    it('rejects enqueueAndWait after retries are exhausted', async () => {
      const attemptFn = vi
        .fn()
        .mockRejectedValue(new Error('Permanent failure'))
      const coalescer = new UploadCoalescer(prepareWith(attemptFn), {
        baseDelayMs: 100,
        maxRetries: 2,
      })

      const uploadPromise = coalescer.enqueueAndWait('chat-1')
      const expectation =
        expect(uploadPromise).rejects.toThrow('Permanent failure')
      await vi.runAllTimersAsync()

      await expectation
      expect(attemptFn).toHaveBeenCalledTimes(3)
    })

    it('surfaces sync conflicts without retrying under the same idempotency key', async () => {
      const attemptFn = vi
        .fn()
        .mockRejectedValue(
          new SyncEnclaveError('SYNC_CONFLICT', 409, 'SYNC_CONFLICT'),
        )
      const coalescer = new UploadCoalescer(prepareWith(attemptFn), {
        baseDelayMs: 100,
        maxRetries: 3,
      })

      const uploadPromise = coalescer.enqueueAndWait('chat-1')
      const expectation = expect(uploadPromise).rejects.toMatchObject({
        code: 'SYNC_CONFLICT',
      })
      await vi.runAllTimersAsync()

      await expectation
      expect(attemptFn).toHaveBeenCalledTimes(1)
    })
  })

  describe('State tracking', () => {
    it('tracks pending uploads correctly', async () => {
      const attemptFn = vi.fn().mockResolvedValue(undefined)
      const prepareFn = prepareWith(attemptFn)
      const coalescer = new UploadCoalescer(prepareFn)

      expect(coalescer.hasPendingUpload('chat-1')).toBe(false)

      coalescer.enqueue('chat-1')

      // Right after enqueue, dirty flag is set
      expect(coalescer.hasPendingUpload('chat-1')).toBe(true)

      // Let the upload complete
      await vi.runAllTimersAsync()

      // After completion, state should be cleaned up
      expect(coalescer.hasPendingUpload('chat-1')).toBe(false)
      expect(prepareFn).toHaveBeenCalledExactlyOnceWith(
        'chat-1',
        expect.any(String),
      )
      expect(attemptFn).toHaveBeenCalledOnce()
    })

    it('cancels waiters and retries when cleared during backoff', async () => {
      const attemptFn = vi.fn().mockRejectedValue(new Error('Network error'))
      const coalescer = new UploadCoalescer(prepareWith(attemptFn), {
        baseDelayMs: 1000,
        maxRetries: 3,
        scheduler: {
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          random: () => 0.9999,
        },
      })

      const upload = coalescer.enqueueAndWait('chat-1')
      await vi.advanceTimersByTimeAsync(0)
      expect(attemptFn).toHaveBeenCalledTimes(1)

      coalescer.clear()
      await expect(upload).rejects.toThrow('account change')
      await vi.advanceTimersByTimeAsync(1000)

      expect(attemptFn).toHaveBeenCalledTimes(1)
    })
  })

  describe('Edge cases', () => {
    it.each([
      { failures: 1, expected: ['v1', 'v1', 'v2'] },
      { failures: 2, expected: ['v1', 'v1', 'v1', 'v2'] },
    ])(
      'finishes a frozen retry before uploading newer dirty state',
      async ({ failures, expected }) => {
        let source = 'v1'
        const attempts: Array<{ payload: string; idempotencyKey: string }> = []
        const prepareFn = vi.fn(
          async (_chatId: string, idempotencyKey: string) => {
            const payload = source
            return async () => {
              attempts.push({ payload, idempotencyKey })
              if (attempts.length <= failures) throw new Error('Fail')
            }
          },
        )

        // Pin the jitter to its upper bound so the backoff window is
        // deterministic. A random delay of 0 would let the first retry
        // fire inside advanceTimersByTimeAsync(0) below — before the
        // enqueue during backoff — completing the worker and triggering
        // an extra upload.
        const coalescer = new UploadCoalescer(prepareFn, {
          baseDelayMs: 1000,
          maxRetries: 3,
          scheduler: {
            sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
            random: () => 0.9999,
          },
        })

        coalescer.enqueue('chat-1')
        await vi.advanceTimersByTimeAsync(0) // First attempt fails

        // Enqueue during backoff
        source = 'v2'
        coalescer.enqueue('chat-1')

        // Advance to trigger retry
        await vi.advanceTimersByTimeAsync(1000)

        await vi.runAllTimersAsync()

        expect(attempts.map((attempt) => attempt.payload)).toEqual(expected)
        expect(prepareFn).toHaveBeenCalledTimes(2)
        expect(attempts[0].idempotencyKey).toBe(attempts[1].idempotencyKey)
        expect(
          new Set(
            attempts.slice(0, -1).map((attempt) => attempt.idempotencyKey),
          ).size,
        ).toBe(1)
        expect(attempts.at(-1)!.idempotencyKey).not.toBe(
          attempts[0].idempotencyKey,
        )
      },
    )
  })
})
