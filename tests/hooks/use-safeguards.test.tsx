import { useSafeguardsLoader } from '@/hooks/use-safeguards'
import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  useAuth: vi.fn(),
  refresh: vi.fn(() => Promise.resolve()),
  reset: vi.fn(),
}))

vi.mock('@clerk/react', () => ({ useAuth: mocks.useAuth }))
vi.mock('@/services/safeguards', () => ({
  getSafeguardsServerSnapshot: vi.fn(),
  getSafeguardsSnapshot: vi.fn(),
  refreshSafeguards: mocks.refresh,
  resetSafeguards: mocks.reset,
  subscribeSafeguards: vi.fn(),
}))

const SAFEGUARDS_REFRESH_INTERVAL_MS = 30_000

describe('useSafeguardsLoader', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    mocks.useAuth.mockReturnValue({ isSignedIn: true, userId: 'user-1' })
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('refreshes immediately, every 30 seconds, on focus, and online', () => {
    renderHook(() => useSafeguardsLoader())

    expect(mocks.refresh).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(SAFEGUARDS_REFRESH_INTERVAL_MS)
    expect(mocks.refresh).toHaveBeenCalledTimes(2)

    window.dispatchEvent(new Event('focus'))
    window.dispatchEvent(new Event('online'))
    expect(mocks.refresh).toHaveBeenCalledTimes(4)
  })

  it('pauses polling while hidden and refreshes when visible again', () => {
    const visibility = vi
      .spyOn(document, 'visibilityState', 'get')
      .mockReturnValue('hidden')
    renderHook(() => useSafeguardsLoader())

    vi.advanceTimersByTime(SAFEGUARDS_REFRESH_INTERVAL_MS)
    expect(mocks.refresh).toHaveBeenCalledTimes(1)

    visibility.mockReturnValue('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    expect(mocks.refresh).toHaveBeenCalledTimes(2)
  })

  it('clears account state and timers on cleanup', () => {
    const { unmount } = renderHook(() => useSafeguardsLoader())

    unmount()
    vi.advanceTimersByTime(SAFEGUARDS_REFRESH_INTERVAL_MS)
    window.dispatchEvent(new Event('focus'))
    window.dispatchEvent(new Event('online'))
    document.dispatchEvent(new Event('visibilitychange'))

    expect(mocks.reset).toHaveBeenCalledTimes(1)
    expect(mocks.refresh).toHaveBeenCalledTimes(1)
  })

  it('clears state without fetching or polling when signed out', () => {
    mocks.useAuth.mockReturnValue({ isSignedIn: false, userId: null })

    renderHook(() => useSafeguardsLoader())
    vi.advanceTimersByTime(SAFEGUARDS_REFRESH_INTERVAL_MS)

    expect(mocks.reset).toHaveBeenCalledTimes(1)
    expect(mocks.refresh).not.toHaveBeenCalled()
  })
})
