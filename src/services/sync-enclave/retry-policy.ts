/**
 * §9.6 R3 — Shared retry / backoff helper for the sync layer.
 *
 * One implementation drives every retry loop in the cloud-storage
 * adapters, the upload coalescer, and the sync engine. Two design
 * properties matter:
 *
 *   1. Full-jitter exponential backoff. `delay(attempt) = random(0,
 *      min(maxDelay, baseDelay * 2**attempt))`. Full jitter (not
 *      "equal" or "decorrelated") was picked because it minimises
 *      thundering-herd risk when many clients converge after a server
 *      outage; AWS's "Exponential Backoff and Jitter" post is the
 *      canonical reference.
 *
 *   2. Injectable scheduler. Tests pass a controllable scheduler so
 *      they neither leak real `setTimeout` calls nor rely on
 *      `vi.useFakeTimers` for correctness. Production wires the
 *      default `realScheduler` which delegates to `setTimeout` and
 *      `Math.random`.
 *
 * The function deliberately does NOT classify or inspect the error
 * itself — that's §9.6 R2's `classifyEnclaveError`. The caller looks
 * up the bucket first and only calls `runWithRetry` when retrying is
 * the right action.
 */

const DEFAULT_BASE_DELAY_MS = 1_000
const DEFAULT_MAX_DELAY_MS = 8_000
const DEFAULT_MAX_ATTEMPTS = 4

export interface RetryScheduler {
  /** Resolve after `ms` milliseconds. */
  sleep(ms: number): Promise<void>
  /** Return a number in `[0, 1)` consumed by the jitter computation. */
  random(): number
}

export const realScheduler: RetryScheduler = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: () => Math.random(),
}

export interface RetryConfig {
  /** Lowest delay base, in ms (default 1000). */
  baseDelayMs?: number
  /** Maximum capped delay, in ms (default 8000). */
  maxDelayMs?: number
  /**
   * Maximum number of attempts (including the first try). Default 4
   * — matches §9.6 R3.
   */
  maxAttempts?: number
  /** Hook fired on every observed failure, for logging/metrics. */
  onAttemptFailed?(info: {
    attempt: number
    delayMs: number
    error: unknown
  }): void
  scheduler?: RetryScheduler
}

/**
 * Run `fn` until it returns or until `maxAttempts` is reached. On a
 * throw, the helper waits `delay(attempt)` ms before the next try.
 *
 * The decision to retry is made by `shouldRetry` — pass a function
 * that consults `classifyEnclaveError` so retries are not blindly
 * triggered on TERMINAL or USER_DECISION errors. If `shouldRetry`
 * returns false the helper re-throws immediately.
 */
export async function runWithRetry<T>(
  fn: () => Promise<T>,
  shouldRetry: (err: unknown, attempt: number) => boolean,
  config: RetryConfig = {},
): Promise<T> {
  const baseDelayMs = config.baseDelayMs ?? DEFAULT_BASE_DELAY_MS
  const maxDelayMs = config.maxDelayMs ?? DEFAULT_MAX_DELAY_MS
  // Clamp to at least one attempt so a caller passing 0 (or a
  // negative override) cannot skip execution entirely and end up
  // throwing `undefined` from the empty for-loop tail.
  const maxAttempts = Math.max(1, config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)
  const scheduler = config.scheduler ?? realScheduler

  let lastError: unknown
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err
      const isLast = attempt === maxAttempts - 1
      const willRetry = !isLast && shouldRetry(err, attempt)
      const delayMs = willRetry
        ? computeBackoffDelay(
            attempt,
            baseDelayMs,
            maxDelayMs,
            scheduler.random(),
          )
        : 0
      // Hook fires on every observed failure, retriable or not, so
      // callers can count terminal/final errors in the same metric
      // stream as the transient ones.
      config.onAttemptFailed?.({ attempt, delayMs, error: err })
      if (!willRetry) break
      await scheduler.sleep(delayMs)
    }
  }
  throw lastError
}

/**
 * Pure helper exposed so tests can pin the random source and assert
 * the curve without invoking the scheduler.
 */
export function computeBackoffDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  random01: number,
): number {
  const cap = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt)
  return Math.floor(random01 * cap)
}
