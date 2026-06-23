/**
 * Edit Clock Tests
 *
 * The Lamport-style clock must be strictly monotonic per device, must
 * advance past any observed remote value, and must expose a stable
 * device id for deterministic tiebreaking.
 */

import {
  deviceId,
  nextClock,
  observe,
  resetEditClockCache,
} from '@/services/cloud/edit-clock'
import { beforeEach, describe, expect, it } from 'vitest'

beforeEach(() => {
  localStorage.clear()
  resetEditClockCache()
})

describe('edit clock', () => {
  it('produces strictly increasing counters', () => {
    const a = nextClock()
    const b = nextClock()
    const c = nextClock()
    expect(b.v).toBeGreaterThan(a.v)
    expect(c.v).toBeGreaterThan(b.v)
  })

  it('advances past an observed remote value', () => {
    nextClock() // local at 1
    observe(50)
    const next = nextClock()
    expect(next.v).toBeGreaterThan(50)
  })

  it('ignores remote values lower than the local counter', () => {
    const high = nextClock().v
    observe(high - 1)
    expect(nextClock().v).toBe(high + 1)
  })

  it('advances past an explicit observed maximum on the unit', () => {
    expect(nextClock(99).v).toBe(100)
  })

  it('keeps a stable device id and stamps it as the writer', () => {
    const id = deviceId()
    expect(id).toBeTruthy()
    expect(deviceId()).toBe(id)
    expect(nextClock().w).toBe(id)
  })

  it('persists the counter across cache resets via storage', () => {
    const v = nextClock().v
    resetEditClockCache()
    expect(nextClock().v).toBe(v + 1)
  })

  it('ignores a remote value above the safe-integer ceiling', () => {
    // A crafted/corrupt remote clock must not poison the counter.
    observe(Number.MAX_SAFE_INTEGER + 1)
    observe(Number.POSITIVE_INFINITY)
    // The counter is untouched, so it keeps advancing from the base.
    expect(nextClock().v).toBe(1)
    expect(nextClock().v).toBe(2)
  })

  it('caps the counter at the ceiling without overflowing or trapping', () => {
    observe(Number.MAX_SAFE_INTEGER)
    const next = nextClock()
    expect(Number.isSafeInteger(next.v)).toBe(true)
    expect(next.v).toBe(Number.MAX_SAFE_INTEGER)
    // A subsequent tick stays pinned at the ceiling rather than losing
    // precision or producing a non-finite value.
    expect(nextClock().v).toBe(Number.MAX_SAFE_INTEGER)
  })
})
