/**
 * Tests that usePaired reflects credential set/clear and reacts in the same
 * tab (the credential-store setters dispatch PAIR_CHANGE_EVENT) and across
 * tabs (storage events).
 */
import {
  clearRefreshCredential,
  PAIR_CHANGE_EVENT,
  setRefreshCredential,
} from '@/services/computer-use/credential-store'
import { usePaired } from '@/services/computer-use/use-paired'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

describe('usePaired', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })
  afterEach(() => {
    window.localStorage.clear()
  })

  it('returns false when no credential is stored', () => {
    const { result } = renderHook(() => usePaired())
    expect(result.current).toBe(false)
  })

  it('returns true when a credential is already stored at mount', () => {
    window.localStorage.setItem(
      'tinfoil-computer-use-refresh-credential',
      'secret',
    )
    const { result } = renderHook(() => usePaired())
    expect(result.current).toBe(true)
  })

  it('flips true when setRefreshCredential is called (same tab)', () => {
    const { result } = renderHook(() => usePaired())
    expect(result.current).toBe(false)
    act(() => {
      setRefreshCredential('refresh-abc')
    })
    expect(result.current).toBe(true)
  })

  it('flips false when clearRefreshCredential is called (same tab, e.g. 401)', () => {
    window.localStorage.setItem(
      'tinfoil-computer-use-refresh-credential',
      'secret',
    )
    const { result } = renderHook(() => usePaired())
    expect(result.current).toBe(true)
    act(() => {
      clearRefreshCredential()
    })
    expect(result.current).toBe(false)
  })

  it('reacts to cross-tab storage events', () => {
    const { result } = renderHook(() => usePaired())
    expect(result.current).toBe(false)
    // Simulate another tab having paired.
    window.localStorage.setItem(
      'tinfoil-computer-use-refresh-credential',
      'from-other-tab',
    )
    act(() => {
      window.dispatchEvent(new Event('storage'))
    })
    expect(result.current).toBe(true)
  })

  it('PAIR_CHANGE_EVENT alone (without a real storage change) also re-reads', () => {
    const { result } = renderHook(() => usePaired())
    expect(result.current).toBe(false)
    // Directly set the underlying value without going through the setter, then
    // emit the custom event — covers an edge case where the storage event
    // doesn't fire for the originating tab.
    window.localStorage.setItem(
      'tinfoil-computer-use-refresh-credential',
      'manual',
    )
    act(() => {
      window.dispatchEvent(new Event(PAIR_CHANGE_EVENT))
    })
    expect(result.current).toBe(true)
  })
})
