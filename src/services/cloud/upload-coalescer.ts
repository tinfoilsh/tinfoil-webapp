/**
 * Upload Coalescer
 *
 * Coalescing upload queue that replaces the recursive backupChat pattern.
 * - Prevents duplicate uploads for the same chat
 * - Coalesces rapid edits into a single upload (dirty flag pattern)
 * - Implements exponential backoff retry for transient failures
 * - Provides proper concurrency control
 */

import { logError, logInfo } from '@/utils/error-handling'
import { AuthTokenUnavailableError } from '../auth'
import { decideRecovery } from '../sync-enclave/enclave-error-recovery'
import {
  computeBackoffDelay,
  realScheduler,
  type RetryScheduler,
} from '../sync-enclave/retry-policy'
import { newIdempotencyKey } from '../sync-enclave/sync-api'
import { SyncEnclaveError } from '../sync-enclave/sync-enclave-client'

const DEFAULT_BASE_DELAY_MS = 1000
const DEFAULT_MAX_DELAY_MS = 8000
const DEFAULT_MAX_RETRIES = 3
const DEFAULT_MAX_CONCURRENCY = 3

/**
 * Configuration for the upload coalescer
 */
export interface UploadCoalescerConfig {
  /** Base delay for exponential backoff in ms (default: 1000) */
  baseDelayMs?: number
  /** Maximum delay between retries in ms (default: 8000) */
  maxDelayMs?: number
  /** Maximum number of retry attempts (default: 3) */
  maxRetries?: number
  /** Maximum number of chats uploading concurrently (default: 3) */
  maxConcurrency?: number
  /**
   * Scheduler used for back-off sleeps and jitter randomness.
   * Defaults to `realScheduler`, which uses `setTimeout` and
   * `Math.random`. Tests inject a deterministic scheduler so the
   * retry curve is observable without `vi.useFakeTimers` (§9.6 R3).
   */
  scheduler?: RetryScheduler
}

/**
 * State for a single chat's upload
 */
interface ChatUploadState {
  /** Whether the chat has pending changes that need upload */
  dirty: boolean
  /** The currently in-flight upload promise, if any */
  inFlight: Promise<void> | null
  queued: boolean
  /** Number of consecutive failures */
  failureCount: number
  /** Last terminal upload error for this worker, if any */
  lastError: Error | null
  /** Waiters that want to know whether this worker ultimately succeeded */
  resultWaiters: Array<{
    resolve: () => void
    reject: (error: Error) => void
  }>
}

/**
 * One frozen upload attempt. The prepare function captures the chat
 * snapshot and returns this closure; every retry replays it, so the
 * bytes pushed to the enclave are identical across attempts and the
 * enclave can de-duplicate them into a single committed effect.
 */
export type UploadAttempt = (() => Promise<void>) & { dispose?: () => void }

/**
 * Prepare function signature. The coalescer owns the idempotency key
 * (§9.6 R1): it mints one per logical write and calls prepare once to
 * freeze that write's payload; `null` means there is nothing to
 * upload (deleted/ineligible/streaming chat). Retries re-run the
 * returned attempt, never prepare — the enclave's operation hash
 * covers the plaintext, so a retry that re-read a chat edited between
 * attempts would replay different bytes under the same key and fail
 * with 409 IDEMPOTENCY_CONFLICT instead of deduping.
 */
type PrepareUploadFn = (
  chatId: string,
  idempotencyKey: string,
) => Promise<UploadAttempt | null>

/**
 * UploadCoalescer - manages coalescing upload queue for chat backups
 *
 * Usage:
 * ```typescript
 * const coalescer = new UploadCoalescer(
 *   async (chatId, idempotencyKey) => {
 *     const chat = await readChat(chatId)
 *     if (!chat) return null
 *     return () => cloudStorage.uploadChat(chat, { idempotencyKey })
 *   },
 * )
 *
 * // Enqueue uploads - rapid calls for same chat are coalesced
 * coalescer.enqueue('chat-1')
 * coalescer.enqueue('chat-1') // Will be coalesced
 * coalescer.enqueue('chat-2') // Different chat, runs in parallel
 * ```
 */
export class UploadCoalescer {
  private states: Map<string, ChatUploadState> = new Map()
  private prepareUpload: PrepareUploadFn
  private config: Required<Omit<UploadCoalescerConfig, 'scheduler'>>
  private scheduler: RetryScheduler
  private generation = 0
  private activeWorkers = 0
  private queuedChatIds: string[] = []

  constructor(
    prepareUpload: PrepareUploadFn,
    config: UploadCoalescerConfig = {},
  ) {
    this.prepareUpload = prepareUpload
    const maxConcurrency = config.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
      throw new RangeError('Upload concurrency must be a positive integer')
    }
    this.config = {
      baseDelayMs: config.baseDelayMs ?? DEFAULT_BASE_DELAY_MS,
      maxDelayMs: config.maxDelayMs ?? DEFAULT_MAX_DELAY_MS,
      maxRetries: config.maxRetries ?? DEFAULT_MAX_RETRIES,
      maxConcurrency,
    }
    this.scheduler = config.scheduler ?? realScheduler
  }

  /**
   * Enqueue a chat for upload.
   *
   * If the chat is already being uploaded, marks it as dirty to trigger
   * another upload after the current one completes.
   *
   * If no upload is in progress, starts a new upload worker.
   *
   * @param chatId The chat ID to upload
   */
  enqueue(chatId: string): void {
    let state = this.states.get(chatId)

    if (!state) {
      state = {
        dirty: false,
        inFlight: null,
        queued: false,
        failureCount: 0,
        lastError: null,
        resultWaiters: [],
      }
      this.states.set(chatId, state)
    }

    state.dirty = true

    if (!state.inFlight && !state.queued) {
      this.scheduleWorker(chatId, state)
    }
  }

  private scheduleWorker(chatId: string, state: ChatUploadState): void {
    if (this.activeWorkers < this.config.maxConcurrency) {
      this.startWorker(chatId, state)
      return
    }

    state.queued = true
    this.queuedChatIds.push(chatId)
  }

  private startQueuedWorkers(): void {
    while (
      this.activeWorkers < this.config.maxConcurrency &&
      this.queuedChatIds.length > 0
    ) {
      const chatId = this.queuedChatIds.shift()
      if (!chatId) continue
      const state = this.states.get(chatId)
      if (!state?.queued || !state.dirty || state.inFlight) continue
      this.startWorker(chatId, state)
    }
  }

  /**
   * Start the worker loop for a chat.
   * Continues uploading while the dirty flag is set.
   */
  private startWorker(chatId: string, state: ChatUploadState): void {
    const workerGeneration = this.generation
    state.queued = false
    this.activeWorkers++
    let completeWorker!: () => void
    state.inFlight = new Promise<void>((resolve) => {
      completeWorker = resolve
    })
    void (async () => {
      try {
        while (state.dirty && workerGeneration === this.generation) {
          // Clear dirty flag before upload
          state.dirty = false

          // Mint one idempotency key per LOGICAL write (§9.6 R1). All
          // retries inside uploadWithRetry replay under this key so the
          // enclave dedupes them; once we loop back because `dirty` was
          // set during the upload, that's a new logical write and gets
          // a fresh key on the next iteration.
          const idempotencyKey = newIdempotencyKey()

          try {
            await this.uploadWithRetry(chatId, idempotencyKey, workerGeneration)
            // Success - reset failure count
            state.failureCount = 0
            state.lastError = null
          } catch (error) {
            const uploadError =
              error instanceof Error ? error : new Error(String(error))
            // Upload failed after all retries
            state.failureCount++
            state.lastError = uploadError
            logError('Upload failed after retries', error, {
              component: 'UploadCoalescer',
              action: 'worker',
              metadata: {
                chatId,
                failureCount: state.failureCount,
                willRetry: state.dirty,
              },
            })

            // If dirty was set during upload, we'll retry
            // Otherwise, the failure is logged and we move on
          }
        }
      } catch (error) {
        state.lastError =
          error instanceof Error ? error : new Error(String(error))
      } finally {
        state.inFlight = null

        const resultWaiters = state.resultWaiters.splice(0)
        for (const waiter of resultWaiters) {
          if (state.lastError) {
            waiter.reject(state.lastError)
          } else {
            waiter.resolve()
          }
        }

        // Clean up state if no longer needed.
        // Only delete from the map if this worker's generation still matches.
        // After clear(), the map may hold a new state for the same chatId
        // that this old worker must not touch.
        if (!state.dirty && workerGeneration === this.generation) {
          this.states.delete(chatId)
        }

        if (workerGeneration === this.generation) {
          this.activeWorkers--
          this.startQueuedWorkers()
        }
      }
    })().then(completeWorker, completeWorker)
  }

  /**
   * Enqueue a chat and wait for the coalesced worker to finish.
   * Rejects when the worker exhausts retries without a later successful upload.
   */
  async enqueueAndWait(chatId: string): Promise<void> {
    this.enqueue(chatId)
    const state = this.states.get(chatId)
    if (!state) {
      return
    }

    await this.waitForResult(state)
  }

  async ensureUploadAndWait(chatId: string): Promise<void> {
    const existing = this.states.get(chatId)
    if (!existing?.inFlight && !existing?.queued) {
      this.enqueue(chatId)
    }
    const state = this.states.get(chatId)
    if (!state) {
      return
    }

    await this.waitForResult(state)
  }

  private waitForResult(state: ChatUploadState): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      state.resultWaiters.push({ resolve, reject })
    })
  }

  /**
   * Upload with exponential backoff retry. All attempts within this
   * call replay under the same `idempotencyKey` so the enclave
   * collapses them to a single committed effect (§9.6 R1).
   */
  private async uploadWithRetry(
    chatId: string,
    idempotencyKey: string,
    workerGeneration: number,
  ): Promise<void> {
    let lastError: Error | null = null
    // Frozen on the first successful prepare so every retry replays
    // the exact payload the enclave may have already committed. Only
    // a failed prepare re-runs; a failed attempt never re-reads the
    // chat. Edits that land mid-write set `dirty` and go out as the
    // next logical write under a fresh key.
    let preparedAttempt: UploadAttempt | null | undefined

    try {
      for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
        if (workerGeneration !== this.generation) return
        try {
          if (preparedAttempt === undefined) {
            preparedAttempt = await this.prepareUpload(chatId, idempotencyKey)
            if (workerGeneration !== this.generation) return
          }
          if (preparedAttempt === null) return // Nothing to upload
          await preparedAttempt()
          return // Success
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error))
          if (!shouldRetryUploadError(lastError)) {
            throw lastError
          }

          // Don't retry on final attempt
          if (attempt === this.config.maxRetries) {
            break
          }

          const delay = computeBackoffDelay(
            attempt,
            this.config.baseDelayMs,
            this.config.maxDelayMs,
            this.scheduler.random(),
          )

          logInfo(`Upload failed, retrying in ${delay}ms`, {
            component: 'UploadCoalescer',
            action: 'retry',
            metadata: {
              chatId,
              attempt: attempt + 1,
              maxRetries: this.config.maxRetries,
              delay,
              error: lastError.message,
            },
          })

          await this.scheduler.sleep(delay)
          if (workerGeneration !== this.generation) return
        }
      }

      // All retries exhausted
      throw lastError ?? new Error('Upload failed')
    } finally {
      preparedAttempt?.dispose?.()
    }
  }

  /**
   * Check if a chat has a pending or in-flight upload.
   */
  hasPendingUpload(chatId: string): boolean {
    const state = this.states.get(chatId)
    return state
      ? state.dirty || state.queued || state.inFlight !== null
      : false
  }

  /**
   * Clear all pending uploads (useful for cleanup/testing).
   */
  clear(): void {
    this.generation++
    this.activeWorkers = 0
    this.queuedChatIds = []
    const cancellationError = new Error('Upload canceled after account change')
    for (const state of this.states.values()) {
      state.dirty = false
      const waiters = state.resultWaiters.splice(0)
      for (const waiter of waiters) {
        waiter.reject(cancellationError)
      }
    }
    this.states.clear()
  }

  /**
   * Wait for a specific chat's upload to complete.
   * Returns immediately if no upload is in progress.
   * Useful for testing and ensuring uploads complete before proceeding.
   */
  async waitForUpload(chatId: string): Promise<void> {
    const state = this.states.get(chatId)
    if (state?.dirty || state?.queued || state?.inFlight) {
      await this.waitForResult(state)
    }
  }

  /**
   * Wait for all pending uploads to complete.
   * Useful for testing and cleanup.
   */
  async waitForAllUploads(): Promise<void> {
    const promises: Promise<void>[] = []
    for (const state of this.states.values()) {
      if (state.dirty || state.queued || state.inFlight) {
        promises.push(this.waitForResult(state))
      }
    }
    await Promise.all(promises)
  }
}

function shouldRetryUploadError(error: Error): boolean {
  if (error instanceof AuthTokenUnavailableError) {
    return false
  }
  const decision = decideRecovery(error)
  if (decision.action.type === 'retry') {
    return true
  }
  if (decision.classification.code || error instanceof SyncEnclaveError) {
    return false
  }
  // Deliberately retry codeless non-enclave unknowns even though
  // decideRecovery defaults them to abort: the transport layer throws
  // plain Errors for genuine network flakes that isNetworkError's
  // narrow TypeError check cannot recognize. The same idempotency key
  // covers every attempt, so the extra tries are safe and only delay
  // terminal failure by a few seconds.
  return true
}
