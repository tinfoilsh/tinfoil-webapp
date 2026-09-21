import { SignoutConfirmationModal } from '@/components/modals/signout-confirmation-modal'
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
import { hasRecentExplicitSignoutIntent } from '@/utils/auth-signout-intent'
import { logError, logInfo } from '@/utils/error-handling'
import {
  deleteEncryptionKey,
  getEncryptionKey,
  hasPasskeyBackup,
  performSignoutCleanup,
  performUserSwitchCleanup,
  retryFailedStorageCleanup,
} from '@/utils/signout-cleanup'
import {
  completeSignoutStep,
  hideSignoutProgress,
  reportSignoutStep,
  SIGNOUT_STEPS,
} from '@/utils/signout-progress'
import { useAuth, useUser } from '@clerk/react'
import { useCallback, useEffect, useRef, useState } from 'react'

const SIGNOUT_CLEANUP_GRACE_MS = 2000

export function AuthCleanupHandler() {
  const { isSignedIn, isLoaded } = useAuth()
  const { user } = useUser()
  const [showModal, setShowModal] = useState(false)
  const [isDarkMode, setIsDarkMode] = useState(false)
  const [cleanupError, setCleanupError] = useState<{
    message: string
    retryStorage: boolean
  } | null>(null)
  const [cleanupRetrying, setCleanupRetrying] = useState(false)
  const [hasExplicitSignoutIntent, setHasExplicitSignoutIntent] =
    useState(false)
  const hasCheckedRef = useRef(false)
  const pendingSignoutCleanupRef = useRef<number | null>(null)
  const pendingUserSwitchCleanupRef = useRef<Promise<void> | null>(null)
  const latestAuthStateRef = useRef({
    isLoaded,
    isSignedIn,
    userId: user?.id,
  })

  useEffect(() => {
    latestAuthStateRef.current = {
      isLoaded,
      isSignedIn,
      userId: user?.id,
    }
  }, [isLoaded, isSignedIn, user?.id])

  useEffect(() => {
    const syncSignoutIntent = () => {
      setHasExplicitSignoutIntent(hasRecentExplicitSignoutIntent())
    }
    const handleSignoutRequested = () => setHasExplicitSignoutIntent(true)
    const handleStorage = (event: StorageEvent) => {
      if (event.key === AUTH_SIGNOUT_REQUESTED_AT) {
        syncSignoutIntent()
      }
    }

    syncSignoutIntent()
    window.addEventListener(
      AUTH_SIGNOUT_REQUESTED_EVENT,
      handleSignoutRequested,
    )
    window.addEventListener(AUTH_SIGNOUT_CLEARED_EVENT, syncSignoutIntent)
    window.addEventListener('storage', handleStorage)
    return () => {
      window.removeEventListener(
        AUTH_SIGNOUT_REQUESTED_EVENT,
        handleSignoutRequested,
      )
      window.removeEventListener(AUTH_SIGNOUT_CLEARED_EVENT, syncSignoutIntent)
      window.removeEventListener('storage', handleStorage)
    }
  }, [])

  useEffect(() => {
    const handleCrossTabResetFailure = () => {
      setCleanupError({
        message:
          'Local data could not be cleared after another tab changed accounts.',
        retryStorage: true,
      })
    }
    if (sessionStorage.getItem(AUTH_ACCOUNT_RESET_FAILED) === 'true') {
      handleCrossTabResetFailure()
    }
    window.addEventListener(
      ACCOUNT_RESET_FAILED_EVENT,
      handleCrossTabResetFailure,
    )
    return () =>
      window.removeEventListener(
        ACCOUNT_RESET_FAILED_EVENT,
        handleCrossTabResetFailure,
      )
  }, [])

  const clearPendingSignoutCleanup = useCallback(() => {
    if (pendingSignoutCleanupRef.current !== null) {
      clearTimeout(pendingSignoutCleanupRef.current)
      pendingSignoutCleanupRef.current = null
    }
  }, [])

  const runSignoutCleanup = useCallback(() => {
    completeSignoutStep(SIGNOUT_STEPS.SIGN_OUT)
    const encryptionKey = getEncryptionKey()

    if (hasPasskeyBackup() || !encryptionKey) {
      const action = hasPasskeyBackup()
        ? 'signoutWithPasskey'
        : 'signoutWithoutKey'
      logInfo('Auto-clearing all data on signout', {
        component: 'AuthCleanupHandler',
        action,
      })
      performSignoutCleanup()
        .then(() => {
          reportSignoutStep(SIGNOUT_STEPS.RELOAD)
          window.location.reload()
        })
        .catch((error) => {
          logError('Failed to cleanup on signout', error, {
            component: 'AuthCleanupHandler',
            action,
          })
          hideSignoutProgress()
          setCleanupError({
            message: 'Local data could not be cleared after signing out.',
            retryStorage: false,
          })
        })
      return
    }

    logInfo('No passkey backup, preserving key for download prompt', {
      component: 'AuthCleanupHandler',
      action: 'signoutWithoutPasskey',
    })
    performSignoutCleanup({ preserveEncryptionKey: true })
      .then(() => {
        hideSignoutProgress()
        // Check theme from data-theme attribute (source of truth)
        const dataTheme = document.documentElement.getAttribute('data-theme')
        setIsDarkMode(dataTheme === 'dark')
        setShowModal(true)
      })
      .catch((error) => {
        logError('Failed to cleanup on signout (preserving key)', error, {
          component: 'AuthCleanupHandler',
          action: 'signoutWithoutPasskey',
        })
        hideSignoutProgress()
        setCleanupError({
          message: 'Local data could not be cleared after signing out.',
          retryStorage: false,
        })
      })
  }, [])

  useEffect(() => {
    if (!isLoaded) return
    if (cleanupError) {
      clearPendingSignoutCleanup()
      return
    }

    if (isSignedIn && user?.id) {
      clearPendingSignoutCleanup()
      const storedUserId = localStorage.getItem(AUTH_ACTIVE_USER_ID)

      if (storedUserId && storedUserId !== user.id) {
        // Different user signed in — clear all previous user data + reload
        if (!pendingUserSwitchCleanupRef.current && !cleanupError) {
          const cleanup = performUserSwitchCleanup(user.id)
          pendingUserSwitchCleanupRef.current = cleanup
          void cleanup
            .then(() => {
              window.location.reload()
            })
            .catch(() => {
              setCleanupError({
                message:
                  'Local data from the previous account could not be cleared.',
                retryStorage: false,
              })
            })
            .finally(() => {
              if (pendingUserSwitchCleanupRef.current === cleanup) {
                pendingUserSwitchCleanupRef.current = null
              }
            })
        }
        return
      }

      // Same user or fresh sign-in — persist the active user ID
      localStorage.setItem(AUTH_ACTIVE_USER_ID, user.id)
      window.dispatchEvent(new Event(AUTH_ACTIVE_USER_CHANGED_EVENT))
    }

    // Confirm an explicit sign-out completed before clearing local account data.
    const storedUserId = localStorage.getItem(AUTH_ACTIVE_USER_ID)
    if (
      !isSignedIn &&
      storedUserId &&
      hasExplicitSignoutIntent &&
      !hasCheckedRef.current
    ) {
      if (pendingSignoutCleanupRef.current === null) {
        pendingSignoutCleanupRef.current = window.setTimeout(() => {
          pendingSignoutCleanupRef.current = null

          const latestStoredUserId = localStorage.getItem(AUTH_ACTIVE_USER_ID)
          const latestAuthState = latestAuthStateRef.current

          if (
            !latestAuthState.isLoaded ||
            latestAuthState.isSignedIn ||
            !latestStoredUserId
          ) {
            return
          }

          hasCheckedRef.current = true
          runSignoutCleanup()
        }, SIGNOUT_CLEANUP_GRACE_MS)
      }
    } else {
      clearPendingSignoutCleanup()
    }

    if (!storedUserId) {
      clearPendingSignoutCleanup()
    }

    // Reset the check flag when user signs in
    if (isSignedIn) {
      hasCheckedRef.current = false
    }
  }, [
    isSignedIn,
    isLoaded,
    user?.id,
    clearPendingSignoutCleanup,
    cleanupError,
    hasExplicitSignoutIntent,
    runSignoutCleanup,
  ])

  useEffect(() => clearPendingSignoutCleanup, [clearPendingSignoutCleanup])

  const handleDone = () => {
    deleteEncryptionKey()
    setShowModal(false)
    window.location.reload()
  }

  if (cleanupError) {
    return (
      <div
        className="fixed inset-0 z-[110] flex items-center justify-center bg-surface-chat-background px-4"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="cleanup-error-title"
      >
        <div className="w-full max-w-md rounded-site-lg border border-border-subtle bg-surface-card p-6 text-center shadow-xl">
          <h2
            id="cleanup-error-title"
            className="text-lg font-semibold text-content-primary"
          >
            Unable to clear local data
          </h2>
          <p className="mt-3 text-sm text-content-secondary">
            {cleanupError.message} Close any other Tinfoil tabs, then retry
            before continuing.
          </p>
          <button
            type="button"
            onClick={() => {
              if (!cleanupError.retryStorage) {
                window.location.reload()
                return
              }

              setCleanupRetrying(true)
              void retryFailedStorageCleanup()
                .then(() => window.location.reload())
                .catch(() => {
                  setCleanupRetrying(false)
                  setCleanupError({
                    message:
                      'Local data still could not be cleared after another tab changed accounts.',
                    retryStorage: true,
                  })
                })
            }}
            disabled={cleanupRetrying}
            className="mt-6 rounded-lg bg-brand-accent-dark px-5 py-2.5 text-sm font-medium text-white hover:bg-brand-accent-dark/90"
          >
            {cleanupRetrying ? 'Retrying cleanup...' : 'Retry cleanup'}
          </button>
        </div>
      </div>
    )
  }

  if (!showModal) {
    return null
  }

  return (
    <SignoutConfirmationModal
      isOpen={showModal}
      onDone={handleDone}
      encryptionKey={getEncryptionKey()}
      isDarkMode={isDarkMode}
    />
  )
}
