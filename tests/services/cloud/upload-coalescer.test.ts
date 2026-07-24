/**
 * Upload Coalescer Tests
 */

import { UploadCoalescer } from '@/services/cloud/upload-coalescer'
import { SyncEnclaveError } from '@/services/sync-enclave/sync-enclave-client'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock error handling
vi.mock('@/utils/error-handling', () => ({
  logInfo: vi.fn(),
  logError: vi.fn(),
}))

describe('UploadCoalescer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('Basic enqueue behavior', () => {
    it('calls upload function when enqueued', async () => {
      const uploadFn = vi.fn().mockResolvedValue(undefined)
      const coalescer = new UploadCoalescer(uploadFn)

      coalescer.enqueue('chat-1')

      // Let the async worker run
      await vi.runAllTimersAsync()

      expect(uploadFn).toHaveBeenCalledWith('chat-1', expect.any(String))
      expect(uploadFn).toHaveBeenCalledTimes(1)
    })

    it('handles multiple different chats in parallel', async () => {
      const uploadFn = vi.fn().mockResolvedValue(undefined)
      const coalescer = new UploadCoalescer(uploadFn)

      coalescer.enqueue('chat-1')
      coalescer.enqueue('chat-2')
      coalescer.enqueue('chat-3')

      await vi.runAllTimersAsync()

      expect(uploadFn).toHaveBeenCalledTimes(3)
      expect(uploadFn).toHaveBeenCalledWith('chat-1', expect.any(String))
      expect(uploadFn).toHaveBeenCalledWith('chat-2', expect.any(String))
      expect(uploadFn).toHaveBeenCalledWith('chat-3', expect.any(String))
    })
  })

  describe('§9.6 R1 — idempotency key ownership', () => {
    it('reuses the same idempotency key across retries of one logical write', async () => {
      const uploadFn = vi
        .fn()
        .mockRejectedValueOnce(new Error('flake'))
        .mockRejectedValueOnce(new Error('flake'))
        .mockResolvedValueOnce(undefined)

      const coalescer = new UploadCoalescer(uploadFn, {
        baseDelayMs: 10,
        maxDelayMs: 40,
        maxRetries: 3,
      })

      coalescer.enqueue('chat-1')
      await vi.runAllTimersAsync()

      expect(uploadFn).toHaveBeenCalledTimes(3)
      const keys = uploadFn.mock.calls.map((c) => c[1])
      expect(new Set(keys).size).toBe(1)
    })

    it('mints a fresh idempotency key for each new logical write', async () => {
      let resolveFirst: () => void
      const uploadFn = vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              resolveFirst = resolve
            }),
        )
        .mockResolvedValueOnce(undefined)

      const coalescer = new UploadCoalescer(uploadFn)

      coalescer.enqueue('chat-1')
      // Dirty during in-flight — second logical write.
      coalescer.enqueue('chat-1')

      resolveFirst!()
      await vi.runAllTimersAsync()

      expect(uploadFn).toHaveBeenCalledTimes(2)
      const firstKey = uploadFn.mock.calls[0][1]
      const secondKey = uploadFn.mock.calls[1][1]
      expect(firstKey).not.toBe(secondKey)
    })
  })

  describe('Coalescing behavior', () => {
    it('waits for an existing upload without scheduling another write', async () => {
      let resolveUpload: (() => void) | undefined
      const uploadFn = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveUpload = resolve
          }),
      )
      const coalescer = new UploadCoalescer(uploadFn)
      coalescer.enqueue('chat-1')

      const ensured = coalescer.ensureUploadAndWait('chat-1')
      resolveUpload?.()
      await ensured

      expect(uploadFn).toHaveBeenCalledOnce()
    })

    it('coalesces rapid enqueues for the same chat', async () => {
      let resolveUpload: () => void
      const uploadPromise = new Promise<void>((resolve) => {
        resolveUpload = resolve
      })
      const uploadFn = vi.fn().mockReturnValue(uploadPromise)
      const coalescer = new UploadCoalescer(uploadFn)

      // First enqueue starts upload
      coalescer.enqueue('chat-1')

      // These should be coalesced since upload is in progress
      coalescer.enqueue('chat-1')
      coalescer.enqueue('chat-1')
      coalescer.enqueue('chat-1')

      // Still only one upload started
      expect(uploadFn).toHaveBeenCalledTimes(1)
      expect(coalescer.isUploading('chat-1')).toBe(true)

      // Complete first upload
      resolveUpload!()
      await vi.runAllTimersAsync()

      // Dirty flag was set, so one more upload
      expect(uploadFn).toHaveBeenCalledTimes(2)
    })

    it('re-uploads after dirty flag set during upload', async () => {
      let resolveFirst: () => void
      let resolveSecond: () => void

      const uploadFn = vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              resolveFirst = resolve
            }),
        )
        .mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              resolveSecond = resolve
            }),
        )

      const coalescer = new UploadCoalescer(uploadFn)

      // Start first upload
      coalescer.enqueue('chat-1')
      expect(uploadFn).toHaveBeenCalledTimes(1)

      // Enqueue during upload - sets dirty flag
      coalescer.enqueue('chat-1')
      expect(uploadFn).toHaveBeenCalledTimes(1) // Still just one

      // Complete first upload
      resolveFirst!()
      await vi.runAllTimersAsync()

      // Second upload should have started
      expect(uploadFn).toHaveBeenCalledTimes(2)

      // Complete second upload
      resolveSecond!()
      await vi.runAllTimersAsync()

      // No more uploads (dirty flag was clear)
      expect(uploadFn).toHaveBeenCalledTimes(2)
    })
  })

  describe('Retry behavior', () => {
    it('retries failed uploads with exponential backoff', async () => {
      const uploadFn = vi
        .fn()
        .mockRejectedValueOnce(new Error('Network error'))
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce(undefined)

      // Pin the jitter to its upper bound so the retry windows are
      // deterministic. With full-jitter exponential backoff
      // delay = floor(random() * min(maxDelay, baseDelay * 2**attempt)),
      // random()=0.9999 gives the worst-case wait per attempt.
      const coalescer = new UploadCoalescer(uploadFn, {
        baseDelayMs: 100,
        maxDelayMs: 400,
        maxRetries: 3,
        scheduler: {
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          random: () => 0.9999,
        },
      })

      coalescer.enqueue('chat-1')

      // First attempt fails immediately
      await vi.advanceTimersByTimeAsync(0)
      expect(uploadFn).toHaveBeenCalledTimes(1)

      // Wait for first retry: max delay window = baseDelay * 2**0 = 100ms.
      await vi.advanceTimersByTimeAsync(100)
      expect(uploadFn).toHaveBeenCalledTimes(2)

      // Wait for second retry: max delay window = baseDelay * 2**1 = 200ms.
      await vi.advanceTimersByTimeAsync(200)
      expect(uploadFn).toHaveBeenCalledTimes(3)

      // All done
      await vi.runAllTimersAsync()
      expect(uploadFn).toHaveBeenCalledTimes(3)
    })

    it('gives up after max retries', async () => {
      const uploadFn = vi.fn().mockRejectedValue(new Error('Permanent failure'))

      const coalescer = new UploadCoalescer(uploadFn, {
        baseDelayMs: 100,
        maxRetries: 2,
      })

      coalescer.enqueue('chat-1')

      await vi.runAllTimersAsync()

      // 1 initial + 2 retries = 3 total attempts
      expect(uploadFn).toHaveBeenCalledTimes(3)
    })

    it('rejects enqueueAndWait after retries are exhausted', async () => {
      const uploadFn = vi.fn().mockRejectedValue(new Error('Permanent failure'))
      const coalescer = new UploadCoalescer(uploadFn, {
        baseDelayMs: 100,
        maxRetries: 1,
      })

      const uploadPromise = coalescer.enqueueAndWait('chat-1')
      const expectation =
        expect(uploadPromise).rejects.toThrow('Permanent failure')
      await vi.runAllTimersAsync()

      await expectation
    })

    it('surfaces sync conflicts without retrying under the same idempotency key', async () => {
      const uploadFn = vi
        .fn()
        .mockRejectedValue(
          new SyncEnclaveError('SYNC_CONFLICT', 409, 'SYNC_CONFLICT'),
        )
      const coalescer = new UploadCoalescer(uploadFn, {
        baseDelayMs: 100,
        maxRetries: 3,
      })

      const uploadPromise = coalescer.enqueueAndWait('chat-1')
      const expectation = expect(uploadPromise).rejects.toMatchObject({
        code: 'SYNC_CONFLICT',
      })
      await vi.runAllTimersAsync()

      await expectation
      expect(uploadFn).toHaveBeenCalledTimes(1)
    })
  })

  describe('State tracking', () => {
    it('tracks pending uploads correctly', async () => {
      const uploadFn = vi.fn().mockResolvedValue(undefined)

      const coalescer = new UploadCoalescer(uploadFn)

      expect(coalescer.hasPendingUpload('chat-1')).toBe(false)

      coalescer.enqueue('chat-1')

      // Right after enqueue, dirty flag is set
      expect(coalescer.hasPendingUpload('chat-1')).toBe(true)

      // Let the upload complete
      await vi.runAllTimersAsync()

      // After completion, state should be cleaned up
      expect(coalescer.hasPendingUpload('chat-1')).toBe(false)
      expect(coalescer.activeUploadCount).toBe(0)
    })

    it('returns pending chat IDs', async () => {
      const uploadFn = vi.fn().mockReturnValue(new Promise(() => {})) // Never resolves

      const coalescer = new UploadCoalescer(uploadFn)

      coalescer.enqueue('chat-1')
      coalescer.enqueue('chat-2')

      const pendingIds = coalescer.getPendingChatIds()

      expect(pendingIds).toContain('chat-1')
      expect(pendingIds).toContain('chat-2')
      expect(pendingIds).toHaveLength(2)
    })

    it('clears all state', async () => {
      const uploadFn = vi.fn().mockReturnValue(new Promise(() => {}))

      const coalescer = new UploadCoalescer(uploadFn)

      coalescer.enqueue('chat-1')
      coalescer.enqueue('chat-2')

      expect(coalescer.activeUploadCount).toBe(2)

      coalescer.clear()

      expect(coalescer.activeUploadCount).toBe(0)
      expect(coalescer.getPendingChatIds()).toHaveLength(0)
    })

    it('cancels waiters and retries when cleared during backoff', async () => {
      const uploadFn = vi.fn().mockRejectedValue(new Error('Network error'))
      const coalescer = new UploadCoalescer(uploadFn, {
        baseDelayMs: 1000,
        maxRetries: 3,
        scheduler: {
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          random: () => 0.9999,
        },
      })

      const upload = coalescer.enqueueAndWait('chat-1')
      await vi.advanceTimersByTimeAsync(0)
      expect(uploadFn).toHaveBeenCalledTimes(1)

      coalescer.clear()
      await expect(upload).rejects.toThrow('account change')
      await vi.advanceTimersByTimeAsync(1000)

      expect(uploadFn).toHaveBeenCalledTimes(1)
    })
  })

  describe('Edge cases', () => {
    it('handles synchronous upload success', async () => {
      const uploadFn = vi.fn().mockResolvedValue(undefined)
      const coalescer = new UploadCoalescer(uploadFn)

      coalescer.enqueue('chat-1')
      await vi.runAllTimersAsync()

      expect(uploadFn).toHaveBeenCalledTimes(1)
      expect(coalescer.hasPendingUpload('chat-1')).toBe(false)
    })

    it('handles enqueue during retry backoff', async () => {
      const uploadFn = vi
        .fn()
        .mockRejectedValueOnce(new Error('Fail'))
        .mockResolvedValue(undefined)

      // Pin the jitter to its upper bound so the backoff window is
      // deterministic. A random delay of 0 would let the first retry
      // fire inside advanceTimersByTimeAsync(0) below — before the
      // enqueue during backoff — completing the worker and triggering
      // an extra upload.
      const coalescer = new UploadCoalescer(uploadFn, {
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
      coalescer.enqueue('chat-1')

      // Advance to trigger retry
      await vi.advanceTimersByTimeAsync(1000)

      // Should succeed (dirty flag causes fresh data)
      await vi.runAllTimersAsync()

      expect(uploadFn).toHaveBeenCalledTimes(2)
    })
  })
})
