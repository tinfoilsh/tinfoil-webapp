/**
 * Webapp-side idle-reaper countdown for the computer-use session.
 *
 * The driver tears a session down after `idle_timeout` of inactivity. We
 * mirror that countdown in the toolbar so the user knows how long they have
 * before the VM is reaped. The reset key is bumped whenever the agent (or
 * the user) does something that the driver counts as activity — today the
 * frame stream is a faithful proxy for that signal.
 */

'use client'

import { useEffect, useMemo, useState } from 'react'

/** Go-style duration (`15m`, `1h30m`, `45s`) → milliseconds. */
export function parseDurationMs(s: string | undefined | null): number | null {
  if (!s) return null
  // Each match is (number)(unit). Multiple components sum (e.g. `1h30m`).
  const re = /(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)/g
  let total = 0
  let m: RegExpExecArray | null
  let matched = false
  while ((m = re.exec(s))) {
    matched = true
    const n = parseFloat(m[1])
    const unit = m[2]
    const mul =
      unit === 'h'
        ? 3.6e6
        : unit === 'm'
          ? 6e4
          : unit === 's'
            ? 1e3
            : unit === 'ms'
              ? 1
              : unit === 'us' || unit === 'µs'
                ? 1e-3
                : unit === 'ns'
                  ? 1e-6
                  : 0
    total += n * mul
  }
  return matched && total > 0 ? total : null
}

/**
 * Track the time left before the driver's idle reaper would fire. `resetKey`
 * is the activity proxy — any value change (e.g. `frames.length`) restarts
 * the countdown. Returns `null` when no timeout is configured.
 */
export function useIdleCountdown(
  idleTimeout: string | undefined,
  resetKey: number,
  paused = false,
) {
  const totalMs = useMemo(() => parseDurationMs(idleTimeout), [idleTimeout])
  // Both timestamps live in state (not refs) so render can read them
  // without violating purity rules. They start as `null` until the
  // bootstrap effect runs — the render handles that by returning the
  // full duration while we wait, which flashes for a single paint.
  const [lastActivity, setLastActivity] = useState<number | null>(null)
  const [now, setNow] = useState<number | null>(null)

  // Bootstrap + reset on activity. Initial render fires once with
  // `resetKey = 0`, populating both timestamps and the countdown begins.
  // The setState-in-effect here is intentional and unavoidable: we are
  // syncing the wall-clock at the moment an external signal (resetKey)
  // changed, and `Date.now()` is the value we need to capture. There is
  // no pure derivation that produces a fresh wall-clock from a counter.
  useEffect(() => {
    const t = Date.now()
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLastActivity(t)
    setNow(t)
  }, [resetKey])

  useEffect(() => {
    if (totalMs == null || paused) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [totalMs, paused])

  if (totalMs == null) return null
  if (paused) return totalMs // The reaper holds while the user holds.
  if (lastActivity == null || now == null) return totalMs
  const elapsed = now - lastActivity
  return Math.max(0, totalMs - elapsed)
}

/** "2m 30s" / "45s" / "1h 12m" — short form, max two units. */
export function formatRemaining(ms: number): string {
  const totalSeconds = Math.ceil(ms / 1000)
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  const s = totalSeconds % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return s > 0 ? `${m}m ${s}s` : `${m}m`
  return `${s}s`
}
