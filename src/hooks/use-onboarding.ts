import { SETTINGS_HAS_SEEN_ONBOARDING } from '@/constants/storage-keys'
import { logError } from '@/utils/error-handling'
import { useCallback, useEffect, useState } from 'react'

interface UseOnboardingOptions {
  isAuthLoaded: boolean
  isSignedIn: boolean | undefined
  userId: string | undefined
  hasCompletedOnboarding: boolean
  suppressIntroModals: boolean
}

export function useOnboarding({
  isAuthLoaded,
  isSignedIn,
  userId,
  hasCompletedOnboarding,
  suppressIntroModals,
}: UseOnboardingOptions) {
  const [completion, setCompletion] = useState<{
    userId: string
    hasSeen: boolean
  } | null>(null)

  useEffect(() => {
    if (!isAuthLoaded || !isSignedIn || !userId) {
      setCompletion(null)
      return
    }

    const refreshCompletion = () => {
      let hasSeen = false
      try {
        hasSeen = localStorage.getItem(SETTINGS_HAS_SEEN_ONBOARDING) === 'true'
      } catch (error) {
        logError('Could not read onboarding completion', error, {
          component: 'useOnboarding',
          action: 'refreshCompletion',
        })
      }
      setCompletion({ userId, hasSeen })
    }

    const handleStorage = (event: StorageEvent) => {
      if (event.key === SETTINGS_HAS_SEEN_ONBOARDING || event.key === null) {
        refreshCompletion()
      }
    }

    refreshCompletion()
    window.addEventListener('storage', handleStorage)
    return () => window.removeEventListener('storage', handleStorage)
  }, [isAuthLoaded, isSignedIn, userId])

  const isOnboardingReady =
    isAuthLoaded &&
    (!isSignedIn ||
      (!!userId &&
        (suppressIntroModals ||
          hasCompletedOnboarding ||
          completion?.userId === userId)))

  const showOnboarding =
    isOnboardingReady &&
    !!isSignedIn &&
    !suppressIntroModals &&
    !hasCompletedOnboarding &&
    completion?.hasSeen === false

  const dismissOnboarding = useCallback(() => {
    if (userId) setCompletion({ userId, hasSeen: true })
  }, [userId])

  return { showOnboarding, isOnboardingReady, dismissOnboarding }
}
