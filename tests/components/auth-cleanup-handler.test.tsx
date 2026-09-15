import { AuthCleanupHandler } from '@/components/auth-cleanup-handler'
import {
  ACCOUNT_RESET_FAILED_EVENT,
  AUTH_ACTIVE_USER_CHANGED_EVENT,
  AUTH_SIGNOUT_CLEARED_EVENT,
  AUTH_SIGNOUT_REQUESTED_EVENT,
} from '@/constants/auth-events'
import {
  AUTH_ACCOUNT_RESET_FAILED,
  AUTH_ACTIVE_USER_ID,
  AUTH_SIGNOUT_REQUESTED_AT,
} from '@/constants/storage-keys'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockPerformSignoutCleanup = vi.fn()
const mockPerformUserSwitchCleanup = vi.fn()
const mockGetEncryptionKey = vi.fn()
const mockHasPasskeyBackup = vi.fn()
const mockRetryFailedStorageCleanup = vi.fn()

let authState: { isSignedIn: boolean; isLoaded: boolean } = {
  isSignedIn: false,
  isLoaded: true,
}
let userState: { user: { id: string } | null } = {
  user: null,
}

vi.mock('@clerk/nextjs', () => ({
  useAuth: () => authState,
  useUser: () => userState,
}))

vi.mock('@/components/modals/signout-confirmation-modal', () => ({
  SignoutConfirmationModal: () => null,
}))

vi.mock('@/utils/error-handling', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
}))

vi.mock('@/utils/signout-cleanup', () => ({
  deleteEncryptionKey: vi.fn(),
  getEncryptionKey: (...args: any[]) => mockGetEncryptionKey(...args),
  hasPasskeyBackup: (...args: any[]) => mockHasPasskeyBackup(...args),
  performSignoutCleanup: (...args: any[]) => mockPerformSignoutCleanup(...args),
  performUserSwitchCleanup: (...args: any[]) =>
    mockPerformUserSwitchCleanup(...args),
  retryFailedStorageCleanup: (...args: any[]) =>
    mockRetryFailedStorageCleanup(...args),
}))

describe('AuthCleanupHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    localStorage.clear()
    sessionStorage.clear()

    authState = {
      isSignedIn: false,
      isLoaded: true,
    }
    userState = {
      user: null,
    }

    mockPerformSignoutCleanup.mockResolvedValue(undefined)
    mockPerformUserSwitchCleanup.mockResolvedValue(undefined)
    mockRetryFailedStorageCleanup.mockResolvedValue(undefined)
    mockGetEncryptionKey.mockReturnValue(null)
    mockHasPasskeyBackup.mockReturnValue(true)
    vi.spyOn(window.location, 'reload').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('announces a fresh account once and preserves it across remounts', () => {
    authState = { isSignedIn: true, isLoaded: true }
    userState = { user: { id: 'user_123' } }
    const changed = vi.fn()
    window.addEventListener(AUTH_ACTIVE_USER_CHANGED_EVENT, changed)
    try {
      const view = render(createElement(AuthCleanupHandler))
      expect(localStorage.getItem(AUTH_ACTIVE_USER_ID)).toBe('user_123')
      expect(changed).toHaveBeenCalledTimes(1)

      view.unmount()
      render(createElement(AuthCleanupHandler))
      expect(changed).toHaveBeenCalledTimes(1)
      expect(mockPerformUserSwitchCleanup).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener(AUTH_ACTIVE_USER_CHANGED_EVENT, changed)
    }
  })

  it('does not clear data for a transient signed-out state', async () => {
    localStorage.setItem(AUTH_ACTIVE_USER_ID, 'user_123')

    const { rerender } = render(createElement(AuthCleanupHandler))

    await act(async () => {
      vi.advanceTimersByTime(1000)
    })

    authState = {
      isSignedIn: true,
      isLoaded: true,
    }
    userState = {
      user: { id: 'user_123' },
    }

    rerender(createElement(AuthCleanupHandler))

    await act(async () => {
      vi.advanceTimersByTime(2000)
      await Promise.resolve()
    })

    expect(mockPerformSignoutCleanup).not.toHaveBeenCalled()
    expect(mockPerformUserSwitchCleanup).not.toHaveBeenCalled()
  })

  it('preserves data when the session expires without explicit sign-out', async () => {
    localStorage.setItem(AUTH_ACTIVE_USER_ID, 'user_123')

    render(createElement(AuthCleanupHandler))

    await act(async () => {
      vi.advanceTimersByTime(2000)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(mockPerformSignoutCleanup).not.toHaveBeenCalled()
    expect(window.location.reload).not.toHaveBeenCalled()
  })

  it('clears data after an explicit sign-out remains signed out', async () => {
    localStorage.setItem(AUTH_ACTIVE_USER_ID, 'user_123')
    localStorage.setItem(AUTH_SIGNOUT_REQUESTED_AT, String(Date.now()))

    render(createElement(AuthCleanupHandler))

    await act(async () => {
      vi.advanceTimersByTime(2000)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(mockPerformSignoutCleanup).toHaveBeenCalledTimes(1)
    expect(window.location.reload).toHaveBeenCalledTimes(1)
  })

  it('keeps cleanup retryable while browser data is still being cleared', async () => {
    localStorage.setItem(AUTH_ACTIVE_USER_ID, 'user_123')
    localStorage.setItem(AUTH_SIGNOUT_REQUESTED_AT, String(Date.now()))
    mockPerformSignoutCleanup.mockReturnValueOnce(new Promise(() => {}))

    render(createElement(AuthCleanupHandler))

    await act(async () => {
      vi.advanceTimersByTime(2000)
      await Promise.resolve()
    })

    expect(mockPerformSignoutCleanup).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem(AUTH_ACTIVE_USER_ID)).toBe('user_123')
    expect(window.location.reload).not.toHaveBeenCalled()
  })

  it('does not reload-loop when browser data cleanup fails', async () => {
    localStorage.setItem(AUTH_ACTIVE_USER_ID, 'user_123')
    localStorage.setItem(AUTH_SIGNOUT_REQUESTED_AT, String(Date.now()))
    mockPerformSignoutCleanup.mockRejectedValueOnce(new Error('reset failed'))

    render(createElement(AuthCleanupHandler))

    await act(async () => {
      vi.advanceTimersByTime(2000)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(localStorage.getItem(AUTH_ACTIVE_USER_ID)).toBe('user_123')
    expect(window.location.reload).not.toHaveBeenCalled()
  })

  it('still clears data immediately on user switch', () => {
    localStorage.setItem(AUTH_ACTIVE_USER_ID, 'user_old')
    authState = {
      isSignedIn: true,
      isLoaded: true,
    }
    userState = {
      user: { id: 'user_new' },
    }

    render(createElement(AuthCleanupHandler))

    expect(mockPerformUserSwitchCleanup).toHaveBeenCalledWith('user_new')
    expect(mockPerformSignoutCleanup).not.toHaveBeenCalled()
  })

  it('blocks the new account without reload-looping when cleanup fails', async () => {
    localStorage.setItem(AUTH_ACTIVE_USER_ID, 'user_old')
    mockPerformUserSwitchCleanup.mockRejectedValueOnce(
      new Error('reset failed'),
    )
    authState = {
      isSignedIn: true,
      isLoaded: true,
    }
    userState = {
      user: { id: 'user_new' },
    }

    render(createElement(AuthCleanupHandler))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(
      screen.getByRole('alertdialog', {
        name: 'Unable to clear local data',
      }),
    ).toBeTruthy()
    expect(mockPerformUserSwitchCleanup).toHaveBeenCalledTimes(1)
    expect(window.location.reload).not.toHaveBeenCalled()
    expect(localStorage.getItem(AUTH_ACTIVE_USER_ID)).toBe('user_old')
  })

  it('retries a failed reset signaled by another tab', async () => {
    let finishRetry!: () => void
    mockRetryFailedStorageCleanup.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishRetry = resolve
      }),
    )
    render(createElement(AuthCleanupHandler))

    act(() => {
      window.dispatchEvent(new CustomEvent(ACCOUNT_RESET_FAILED_EVENT))
    })
    fireEvent.click(screen.getByRole('button', { name: 'Retry cleanup' }))

    expect(
      screen.getByRole('alertdialog', {
        name: 'Unable to clear local data',
      }),
    ).toBeTruthy()
    expect(
      screen.getByRole('button', { name: 'Retrying cleanup...' }),
    ).toBeTruthy()
    expect(window.location.reload).not.toHaveBeenCalled()

    await act(async () => {
      finishRetry()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(mockRetryFailedStorageCleanup).toHaveBeenCalledTimes(1)
    expect(window.location.reload).toHaveBeenCalledTimes(1)
  })

  it('cancels scheduled sign-out cleanup when reset failure is reported', async () => {
    localStorage.setItem(AUTH_ACTIVE_USER_ID, 'user_123')
    localStorage.setItem(AUTH_SIGNOUT_REQUESTED_AT, String(Date.now()))
    render(createElement(AuthCleanupHandler))

    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    act(() => {
      window.dispatchEvent(new CustomEvent(ACCOUNT_RESET_FAILED_EVENT))
    })
    await act(async () => {
      vi.advanceTimersByTime(2000)
      await Promise.resolve()
    })

    expect(mockPerformSignoutCleanup).not.toHaveBeenCalled()
  })

  it('responds to an explicit sign-out requested after mount', async () => {
    localStorage.setItem(AUTH_ACTIVE_USER_ID, 'user_123')
    render(createElement(AuthCleanupHandler))

    act(() => {
      localStorage.setItem(AUTH_SIGNOUT_REQUESTED_AT, String(Date.now()))
      window.dispatchEvent(new CustomEvent(AUTH_SIGNOUT_REQUESTED_EVENT))
    })
    await act(async () => {
      vi.advanceTimersByTime(2000)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(mockPerformSignoutCleanup).toHaveBeenCalledTimes(1)
  })

  it('cancels explicit cleanup when sign-out fails', async () => {
    localStorage.setItem(AUTH_ACTIVE_USER_ID, 'user_123')
    authState = { isSignedIn: true, isLoaded: true }
    userState = { user: { id: 'user_123' } }
    const { rerender } = render(createElement(AuthCleanupHandler))

    act(() => {
      localStorage.setItem(AUTH_SIGNOUT_REQUESTED_AT, String(Date.now()))
      window.dispatchEvent(new CustomEvent(AUTH_SIGNOUT_REQUESTED_EVENT))
      localStorage.removeItem(AUTH_SIGNOUT_REQUESTED_AT)
      window.dispatchEvent(new CustomEvent(AUTH_SIGNOUT_CLEARED_EVENT))
    })

    authState = { isSignedIn: false, isLoaded: true }
    userState = { user: null }
    rerender(createElement(AuthCleanupHandler))
    await act(async () => {
      vi.advanceTimersByTime(2000)
      await Promise.resolve()
    })

    expect(mockPerformSignoutCleanup).not.toHaveBeenCalled()
  })

  it('restores a cross-tab reset failure reported before mount', async () => {
    sessionStorage.setItem(AUTH_ACCOUNT_RESET_FAILED, 'true')

    render(createElement(AuthCleanupHandler))
    await act(async () => {
      await Promise.resolve()
    })

    expect(
      screen.getByRole('alertdialog', {
        name: 'Unable to clear local data',
      }),
    ).toBeTruthy()
  })
})
