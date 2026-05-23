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
 * Upload function signature. The coalescer owns the idempotency key
 * (§9.6 R1): it mints one per logical write and passes the same value
 * into every retry of that write, so the enclave can de-duplicate
 * replays into a single committed effect.
 */
type UploadFn = (chatId: string, idempotencyKey: string) => Promise<void>

/**
 * UploadCoalescer - manages coalescing upload queue for chat backups
 *
 * Usage:
 * ```typescript
 * const coalescer = new UploadCoalescer(
 *   (chatId) => cloudStorage.uploadChat(chatId),
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
  private uploadFn: UploadFn
  private config: Required<Omit<UploadCoalescerConfig, 'scheduler'>>
  private scheduler: RetryScheduler
  private generation = 0

  constructor(uploadFn: UploadFn, config: UploadCoalescerConfig = {}) {
    this.uploadFn = uploadFn
    this.config = {
      baseDelayMs: config.baseDelayMs ?? DEFAULT_BASE_DELAY_MS,
      maxDelayMs: config.maxDelayMs ?? DEFAULT_MAX_DELAY_MS,
      maxRetries: config.maxRetries ?? DEFAULT_MAX_RETRIES,
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
        failureCount: 0,
        lastError: null,
        resultWaiters: [],
      }
      this.states.set(chatId, state)
    }

    state.dirty = true

    if (!state.inFlight) {
      this.startWorker(chatId, state)
    }
  }

  /**
   * Start the worker loop for a chat.
   * Continues uploading while the dirty flag is set.
   */
  private startWorker(chatId: string, state: ChatUploadState): void {
    const workerGeneration = this.generation
    const workerPromise = (async () => {
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
          await this.uploadWithRetry(chatId, state, idempotencyKey)
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

      // Worker done - clear in-flight promise
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
    })()

    state.inFlight = workerPromise
  }

  /**
   * Enqueue a chat and wait for the coalesced worker to finish.
   * Rejects when the worker exhausts retries without a later successful upload.
   */
  async enqueueAndWait(chatId: string): Promise<void> {
    this.enqueue(chatId)
    const state = this.states.get(chatId)
    if (!state?.inFlight) {
      return
    }

    await new Promise<void>((resolve, reject) => {
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
    state: ChatUploadState,
    idempotencyKey: string,
  ): Promise<void> {
    let lastError: Error | null = null

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        await this.uploadFn(chatId, idempotencyKey)
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

        // Check if new changes came in during wait
        if (state.dirty) {
          // New changes - let the outer loop handle it with fresh data
          return
        }
      }
    }

    // All retries exhausted
    throw lastError ?? new Error('Upload failed')
  }

  /**
   * Check if a chat has a pending or in-flight upload.
   */
  hasPendingUpload(chatId: string): boolean {
    const state = this.states.get(chatId)
    return state ? state.dirty || state.inFlight !== null : false
  }

  /**
   * Check if a chat is currently being uploaded.
   */
  isUploading(chatId: string): boolean {
    const state = this.states.get(chatId)
    return !!state?.inFlight
  }

  /**
   * Get the number of active uploads.
   */
  get activeUploadCount(): number {
    let count = 0
    for (const state of this.states.values()) {
      if (state.inFlight) count++
    }
    return count
  }

  /**
   * Get all chat IDs with pending uploads.
   */
  getPendingChatIds(): string[] {
    const ids: string[] = []
    for (const [chatId, state] of this.states.entries()) {
      if (state.dirty || state.inFlight) {
        ids.push(chatId)
      }
    }
    return ids
  }

  /**
   * Clear all pending uploads (useful for cleanup/testing).
   */
  clear(): void {
    this.generation++
    this.states.clear()
  }

  /**
   * Wait for a specific chat's upload to complete.
   * Returns immediately if no upload is in progress.
   * Useful for testing and ensuring uploads complete before proceeding.
   */
  async waitForUpload(chatId: string): Promise<void> {
    const state = this.states.get(chatId)
    if (state?.inFlight) {
      await state.inFlight
    }
  }

  /**
   * Wait for all pending uploads to complete.
   * Useful for testing and cleanup.
   */
  async waitForAllUploads(): Promise<void> {
    const promises: Promise<void>[] = []
    for (const state of this.states.values()) {
      if (state.inFlight) {
        promises.push(state.inFlight)
      }
    }
    await Promise.all(promises)
  }
}

function shouldRetryUploadError(error: Error): boolean {
  const decision = decideRecovery(error)
  if (decision.action.type === 'retry') {
    return true
  }
  if (decision.classification.code || error instanceof SyncEnclaveError) {
    return false
  }
  return true
}

/**
 * Create a singleton upload coalescer for a given upload function.
 */
export function createUploadCoalescer(
  uploadFn: UploadFn,
  config?: UploadCoalescerConfig,
): UploadCoalescer {
  return new UploadCoalescer(uploadFn, config)
}
