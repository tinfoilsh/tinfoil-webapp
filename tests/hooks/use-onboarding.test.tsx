import {
  SETTINGS_HAS_SEEN_ONBOARDING,
  SETTINGS_HAS_SEEN_WEB_SEARCH_INTRO,
} from '@/constants/storage-keys'
import { useOnboarding } from '@/hooks/use-onboarding'
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/utils/error-handling', () => ({
  logError: vi.fn(),
}))

const signedInOptions = {
  isAuthLoaded: true,
  isSignedIn: true,
  userId: 'user-new',
  hasCompletedOnboarding: false,
  suppressIntroModals: false,
}

describe('useOnboarding', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('waits for auth and user data, then shows onboarding after sign-in', () => {
    const { result, rerender } = renderHook(useOnboarding, {
      initialProps: {
        ...signedInOptions,
        isAuthLoaded: false,
        isSignedIn: undefined as boolean | undefined,
        userId: undefined as string | undefined,
      },
    })
    expect(result.current.showOnboarding).toBe(false)
    expect(result.current.isOnboardingReady).toBe(false)

    rerender({ ...signedInOptions, userId: undefined })
    expect(result.current.showOnboarding).toBe(false)
    expect(result.current.isOnboardingReady).toBe(false)

    rerender(signedInOptions)
    expect(result.current.showOnboarding).toBe(true)
    expect(result.current.isOnboardingReady).toBe(true)
    expect(localStorage.getItem(SETTINGS_HAS_SEEN_ONBOARDING)).toBeNull()
  })

  it('never shows onboarding to anonymous users or marks them completed', () => {
    const { result, rerender } = renderHook(useOnboarding, {
      initialProps: { ...signedInOptions, isSignedIn: false },
    })
    expect(result.current.showOnboarding).toBe(false)
    expect(result.current.isOnboardingReady).toBe(true)
    expect(localStorage.getItem(SETTINGS_HAS_SEEN_ONBOARDING)).toBeNull()

    rerender(signedInOptions)
    expect(result.current.showOnboarding).toBe(true)

    rerender({ ...signedInOptions, isSignedIn: false })
    expect(result.current.showOnboarding).toBe(false)
  })

  it('skips onboarding already completed on the account', () => {
    const { result } = renderHook(() =>
      useOnboarding({ ...signedInOptions, hasCompletedOnboarding: true }),
    )
    expect(result.current.showOnboarding).toBe(false)
    expect(result.current.isOnboardingReady).toBe(true)
  })

  it('skips onboarding already seen on this device', () => {
    localStorage.setItem(SETTINGS_HAS_SEEN_ONBOARDING, 'true')
    const { result } = renderHook(() => useOnboarding(signedInOptions))
    expect(result.current.showOnboarding).toBe(false)
  })

  it.each([SETTINGS_HAS_SEEN_ONBOARDING, null])(
    'refreshes completion from other tabs, including clearing with key %s',
    (clearEventKey) => {
      const { result } = renderHook(() => useOnboarding(signedInOptions))
      expect(result.current.showOnboarding).toBe(true)

      act(() => {
        localStorage.setItem(SETTINGS_HAS_SEEN_ONBOARDING, 'true')
        window.dispatchEvent(
          new StorageEvent('storage', { key: SETTINGS_HAS_SEEN_ONBOARDING }),
        )
      })
      expect(result.current.showOnboarding).toBe(false)

      act(() => {
        localStorage.clear()
        window.dispatchEvent(
          new StorageEvent('storage', { key: clearEventKey }),
        )
      })
      expect(result.current.showOnboarding).toBe(true)
    },
  )

  it('does not reset dismissal for unrelated storage changes', () => {
    const { result } = renderHook(() => useOnboarding(signedInOptions))
    act(() => result.current.dismissOnboarding())

    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: SETTINGS_HAS_SEEN_WEB_SEARCH_INTRO,
        }),
      )
    })
    expect(result.current.showOnboarding).toBe(false)
  })

  it.each([false, true])(
    'uses account completion %s when local storage reads are blocked',
    (hasCompletedOnboarding) => {
      vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
        throw new DOMException('Storage blocked', 'SecurityError')
      })

      const { result } = renderHook(() =>
        useOnboarding({ ...signedInOptions, hasCompletedOnboarding }),
      )
      expect(result.current.isOnboardingReady).toBe(true)
      expect(result.current.showOnboarding).toBe(!hasCompletedOnboarding)

      act(() => result.current.dismissOnboarding())
      expect(result.current.showOnboarding).toBe(false)
    },
  )

  it('does not treat the web search intro as onboarding completion', () => {
    localStorage.setItem(SETTINGS_HAS_SEEN_WEB_SEARCH_INTRO, 'true')
    const { result } = renderHook(() => useOnboarding(signedInOptions))
    expect(result.current.showOnboarding).toBe(true)
    expect(localStorage.getItem(SETTINGS_HAS_SEEN_ONBOARDING)).toBeNull()
  })

  it('respects routes that suppress intro modals without marking completion', () => {
    const { result, rerender } = renderHook(useOnboarding, {
      initialProps: { ...signedInOptions, suppressIntroModals: true },
    })
    expect(result.current.showOnboarding).toBe(false)
    expect(result.current.isOnboardingReady).toBe(true)
    expect(localStorage.getItem(SETTINGS_HAS_SEEN_ONBOARDING)).toBeNull()

    rerender(signedInOptions)
    expect(result.current.showOnboarding).toBe(true)
  })

  it('stays dismissed until the active account changes', () => {
    const { result, rerender } = renderHook(useOnboarding, {
      initialProps: signedInOptions,
    })
    act(() => result.current.dismissOnboarding())
    rerender({ ...signedInOptions })
    expect(result.current.showOnboarding).toBe(false)

    rerender({ ...signedInOptions, userId: 'user-another' })
    expect(result.current.showOnboarding).toBe(true)
  })

  it('hides onboarding when account completion arrives', () => {
    const { result, rerender } = renderHook(useOnboarding, {
      initialProps: signedInOptions,
    })
    expect(result.current.showOnboarding).toBe(true)

    rerender({ ...signedInOptions, hasCompletedOnboarding: true })
    expect(result.current.showOnboarding).toBe(false)
  })
})
