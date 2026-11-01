'use client'

import {
  getSafeguardsServerSnapshot,
  getSafeguardsSnapshot,
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
 * Drops one account's flagged chats when another signs in or the user signs
 * out. The Safeguards settings page loads them when it opens.
 */
export function useSafeguardsReset(): void {
  const { userId } = useAuth()
  useEffect(() => () => resetSafeguards(), [userId])
}
