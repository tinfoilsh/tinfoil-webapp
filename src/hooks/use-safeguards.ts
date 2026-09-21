'use client'

import {
  getSafeguardsServerSnapshot,
  getSafeguardsSnapshot,
  refreshSafeguards,
  resetSafeguards,
  subscribeSafeguards,
  type SafeguardsSnapshot,
} from '@/services/safeguards'
import { useAuth } from '@clerk/react'
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

/**
 * Loads flagged chats once per signed-in session and clears them on
 * sign-out. Mount once near the chat root.
 */
export function useSafeguardsLoader(): void {
  const { isSignedIn, userId } = useAuth()
  useEffect(() => {
    if (!isSignedIn || !userId) {
      resetSafeguards()
      return
    }
    void refreshSafeguards()
    return resetSafeguards
  }, [isSignedIn, userId])
}
