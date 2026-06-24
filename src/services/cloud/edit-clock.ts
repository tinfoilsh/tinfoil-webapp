/**
 * Edit Clock
 *
 * A Lamport-style logical clock shared by every mergeable sync unit
 * (each chat row, each profile field). Arbitration by this clock is a
 * total order on `(v, w)`, which makes conflict resolution a CRDT
 * LWW-register: order-independent and convergent across devices, and
 * immune to wall-clock skew between devices.
 *
 *   - `v` is a per-device monotonic counter, advanced past any remote
 *     value the device observes so a later edit always outranks the
 *     state it was based on.
 *   - `w` is a per-writer id used only as a deterministic tiebreak when
 *     two writers land the same counter value, so every replica picks
 *     the same winner. It combines a persisted per-installation id with
 *     a per-runtime nonce, so two browser tabs sharing one installation
 *     never mint the same `(v, w)` for distinct concurrent edits.
 */

import { SYNC_DEVICE_ID, SYNC_EDIT_CLOCK } from '@/constants/storage-keys'

export interface EditClock {
  v: number
  w: string
}

// Upper bound for the logical counter. Far above any value a legitimate
// edit history could reach, yet capped at the JS safe-integer ceiling so
// the counter never loses precision and an observed remote value can
// never push it past where `+ 1` stops advancing. Matches the iOS
// ceiling so both platforms clamp identically.
const MAX_COUNTER = Number.MAX_SAFE_INTEGER

let deviceIdCache: string | null = null
let counterCache: number | null = null
let writerNonce: string | null = null

// Coerce an arbitrary value (often untrusted remote input) to a usable
// counter: a non-negative safe integer within the ceiling, or 0. This
// rejects fractional, negative, non-finite, and oversized values so they
// can neither make a later tick fractional nor poison it toward overflow.
function safeCounter(value?: number | null): number {
  if (value == null || !Number.isSafeInteger(value) || value <= 0) return 0
  return Math.min(value, MAX_COUNTER)
}

function randomId(): string {
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
  ) {
    return crypto.randomUUID()
  }
  // Non-crypto fallback for environments without randomUUID. The id is
  // only a tiebreak label, never a security boundary.
  return `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

// Persisted per-installation id, reused for the life of the browser
// profile. Shared by every tab of the same profile.
function installationId(): string {
  if (typeof window === 'undefined') return randomId()
  try {
    const stored = localStorage.getItem(SYNC_DEVICE_ID)
    if (stored) return stored
    const next = randomId()
    localStorage.setItem(SYNC_DEVICE_ID, next)
    return next
  } catch {
    return randomId()
  }
}

/**
 * Writer id stamped on every clock this runtime mints. Stable for the
 * life of the runtime, but unique per runtime instance: the persisted
 * installation id is combined with a per-runtime nonce so two tabs of
 * the same browser profile, which share localStorage and so cannot
 * coordinate their counters atomically, still never produce the same
 * `(v, w)` for two distinct concurrent edits.
 */
export function deviceId(): string {
  if (deviceIdCache !== null) return deviceIdCache
  if (writerNonce === null) writerNonce = randomId()
  deviceIdCache = `${installationId()}.${writerNonce}`
  return deviceIdCache
}

function loadCounter(): number {
  if (typeof window === 'undefined') {
    counterCache = counterCache ?? 0
    return counterCache
  }
  let stored = 0
  try {
    const raw = localStorage.getItem(SYNC_EDIT_CLOCK)
    // safeCounter also clamps a previously-persisted value, so a counter
    // poisoned before this bound existed self-heals instead of staying
    // stuck.
    stored = safeCounter(raw ? parseInt(raw, 10) : 0)
  } catch {
    stored = 0
  }
  // Reconcile with the persisted value on every read rather than trusting
  // the in-memory cache. Tabs share localStorage but each have their own
  // cache, so a stale cache would hand out a value another tab already
  // used, minting duplicate clocks. The cache only guards against a failed
  // write regressing us below a value we already handed out.
  counterCache = Math.max(counterCache ?? 0, stored)
  return counterCache
}

function persistCounter(value: number): void {
  counterCache = value
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(SYNC_EDIT_CLOCK, String(value))
  } catch {
    // A persistence failure only risks a counter that restarts lower
    // after a reload; the deviceId tiebreak still keeps arbitration
    // deterministic, and observe() re-advances past any remote value.
  }
}

/**
 * Advance the local counter past an observed remote value without
 * producing a new tick. Called whenever a remote clock is seen so a
 * later local edit is guaranteed to outrank it.
 */
export function observe(remoteV?: number | null): void {
  // Remote values are untrusted input (decrypted blob); safeCounter
  // collapses anything malformed (fractional, negative, non-finite,
  // oversized) to 0 so it can neither poison the counter toward overflow
  // nor make a later tick fractional or non-monotonic.
  const value = safeCounter(remoteV)
  if (value === 0) return
  if (value > loadCounter()) {
    persistCounter(value)
  }
}

/**
 * Produce the next clock for a local edit. Advances past `observedMax`
 * (e.g. the unit's current clock) so a re-edit of an already-high unit
 * still moves forward.
 */
export function nextClock(observedMax?: number | null): EditClock {
  const base = Math.min(
    Math.max(loadCounter(), safeCounter(observedMax)),
    MAX_COUNTER,
  )
  const next = Math.min(base + 1, MAX_COUNTER)
  persistCounter(next)
  return { v: next, w: deviceId() }
}

/**
 * Reset in-memory caches. Used by sign-out cleanup so a new user does
 * not inherit the previous user's device id or counter.
 */
export function resetEditClockCache(): void {
  deviceIdCache = null
  counterCache = null
  writerNonce = null
}
