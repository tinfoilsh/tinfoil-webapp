'use client'

import {
  getSafeguardsServerSnapshot,
  getSafeguardsSnapshot,
  refreshSafeguards,
  resetSafeguards,
  subscribeSafeguards,
  type SafeguardsSnapshot,
} from '@/services/safeguards'
import { useAuth } from '@clerk/nextjs'
import { useEffect, useSyncExternalStore } from 'react'

export function useSafeguards(): SafeguardsSnapshot {
  return useSyncExternalStore(
    subscribeSafeguards,
    getSafeguardsSnapshot,
    getSafeguardsServerSnapshot,
  )
}

/**
 * Narrow subscription for the sidebar flag badge. The store keeps the
 * `flaggedChatIds` reference stable across unrelated updates so list items
 * only re-render when the set of flagged chats changes.
 */
export function useFlaggedChatIds(): SafeguardsSnapshot['flaggedChatIds'] {
  return useSyncExternalStore(
    subscribeSafeguards,
    () => getSafeguardsSnapshot().flaggedChatIds,
    () => getSafeguardsServerSnapshot().flaggedChatIds,
  )
}

export function useSafeguardsLoaded(): boolean {
  return useSyncExternalStore(
    subscribeSafeguards,
    () => getSafeguardsSnapshot().hasLoaded,
    () => getSafeguardsServerSnapshot().hasLoaded,
  )
}

const SAFEGUARDS_REFRESH_INTERVAL_MS = 30_000

/**
 * Keeps the signed-in user's flags current and clears them on sign-out.
 * Background tabs pause polling and refresh immediately when active again.
 */
export function useSafeguardsLoader(): void {
  const { isSignedIn, userId } = useAuth()
  useEffect(() => {
    if (!isSignedIn || !userId) {
      resetSafeguards()
      return
    }
    const refreshIfVisible = () => {
      if (document.visibilityState === 'visible') void refreshSafeguards()
    }
    const handleVisibilityChange = () => refreshIfVisible()

    void refreshSafeguards()
    const interval = window.setInterval(
      refreshIfVisible,
      SAFEGUARDS_REFRESH_INTERVAL_MS,
    )
    window.addEventListener('focus', refreshIfVisible)
    window.addEventListener('online', refreshIfVisible)
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      window.clearInterval(interval)
      window.removeEventListener('focus', refreshIfVisible)
      window.removeEventListener('online', refreshIfVisible)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      resetSafeguards()
    }
  }, [isSignedIn, userId])
}
