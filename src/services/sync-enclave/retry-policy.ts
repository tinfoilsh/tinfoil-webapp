/**
 * §9.6 R3 — Backoff and scheduler utilities for the sync layer.
 *
 * The upload coalescer uses `computeBackoffDelay` and `RetryScheduler`
 * to schedule its retries. Two design properties matter:
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
 * These utilities do not classify or inspect errors. The caller uses
 * §9.6 R2's `classifyEnclaveError` to decide whether to retry before
 * computing a delay and sleeping through the scheduler.
 */

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
