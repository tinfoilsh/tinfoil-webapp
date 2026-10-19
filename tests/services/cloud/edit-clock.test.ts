/**
 * Edit Clock Tests
 *
 * The Lamport-style clock must be strictly monotonic per device, must
 * advance past any observed remote value, and must expose a stable
 * device id for deterministic tiebreaking.
 */

import { SYNC_EDIT_CLOCK } from '@/constants/storage-keys'
import {
  deviceId,
  EditClockRandomnessUnavailableError,
  nextClock,
  observe,
  resetEditClockCache,
} from '@/services/cloud/edit-clock'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

beforeEach(() => {
  localStorage.clear()
  resetEditClockCache()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
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
    expect(nextClock(9).v).toBe(10)
    observe(4)
    expect(nextClock().v).toBe(11)
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

  it('fails explicitly when secure randomness is unavailable', () => {
    vi.stubGlobal('crypto', {})

    expect(() => deviceId()).toThrow(EditClockRandomnessUnavailableError)
  })

  it('uses strong in-memory IDs when local storage is unavailable', () => {
    const randomUUID = vi
      .spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce('11111111-1111-4111-8111-111111111111')
      .mockReturnValueOnce('22222222-2222-4222-8222-222222222222')
    const getItem = vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
      throw new DOMException('Storage unavailable', 'SecurityError')
    })
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('Storage unavailable', 'SecurityError')
    })

    const id = deviceId()

    expect(id).toBe(
      '22222222-2222-4222-8222-222222222222.11111111-1111-4111-8111-111111111111',
    )
    expect(deviceId()).toBe(id)
    expect(randomUUID).toHaveBeenCalledTimes(2)
    expect(getItem).toHaveBeenCalled()
  })

  it('persists the counter across cache resets via storage', () => {
    const v = nextClock().v
    resetEditClockCache()
    expect(nextClock().v).toBe(v + 1)
  })

  it('reconciles with storage so a value another tab advanced is not reused', () => {
    expect(nextClock().v).toBe(1)
    // Another tab sharing this localStorage advances the counter.
    localStorage.setItem(SYNC_EDIT_CLOCK, '8')
    // This tab must continue past the other tab's value rather than
    // reuse 2 from its stale in-memory cache.
    expect(nextClock().v).toBe(9)
  })

  it('mints a distinct writer id per runtime so concurrent tabs differ', () => {
    const first = deviceId()
    // A fresh runtime (another tab) keeps the persisted installation id
    // but draws a new per-runtime nonce.
    resetEditClockCache()
    const second = deviceId()
    expect(second).not.toBe(first)
  })

  it('ignores fractional, negative, and zero remote values', () => {
    observe(2.5)
    observe(-10)
    observe(0)
    const next = nextClock()
    expect(next.v).toBe(1)
    expect(Number.isInteger(next.v)).toBe(true)
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
