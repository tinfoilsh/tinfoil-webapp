import { SETTINGS_HAS_SEEN_ONBOARDING } from '@/constants/storage-keys'
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

    setCompletion({
      userId,
      hasSeen: localStorage.getItem(SETTINGS_HAS_SEEN_ONBOARDING) === 'true',
    })
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
