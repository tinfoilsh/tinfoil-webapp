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
 *   - `w` is a stable per-device id used only as a deterministic
 *     tiebreak when two devices land the same counter value, so every
 *     device picks the same winner.
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

/**
 * Stable id for this device/installation. Generated once and persisted;
 * reused for the life of the browser profile.
 */
export function deviceId(): string {
  if (deviceIdCache !== null) return deviceIdCache
  if (typeof window === 'undefined') {
    deviceIdCache = randomId()
    return deviceIdCache
  }
  try {
    const stored = localStorage.getItem(SYNC_DEVICE_ID)
    if (stored) {
      deviceIdCache = stored
      return stored
    }
    const next = randomId()
    localStorage.setItem(SYNC_DEVICE_ID, next)
    deviceIdCache = next
    return next
  } catch {
    deviceIdCache = randomId()
    return deviceIdCache
  }
}

function loadCounter(): number {
  if (counterCache !== null) return counterCache
  if (typeof window === 'undefined') {
    counterCache = 0
    return 0
  }
  try {
    const raw = localStorage.getItem(SYNC_EDIT_CLOCK)
    const parsed = raw ? parseInt(raw, 10) : 0
    // Clamp a previously-persisted value too, so a counter poisoned
    // before this bound existed self-heals instead of staying stuck.
    counterCache =
      Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, MAX_COUNTER) : 0
  } catch {
    counterCache = 0
  }
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
  // Remote values are untrusted input (decrypted blob); a value above
  // the ceiling is treated as malformed and ignored rather than allowed
  // to poison the counter to a point where it can no longer advance.
  if (remoteV == null || !Number.isFinite(remoteV) || remoteV > MAX_COUNTER) {
    return
  }
  const current = loadCounter()
  if (remoteV > current) {
    persistCounter(remoteV)
  }
}

/**
 * Produce the next clock for a local edit. Advances past `observedMax`
 * (e.g. the unit's current clock) so a re-edit of an already-high unit
 * still moves forward.
 */
export function nextClock(observedMax?: number | null): EditClock {
  const base = Math.min(
    Math.max(
      loadCounter(),
      observedMax != null && Number.isFinite(observedMax) ? observedMax : 0,
    ),
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
}
