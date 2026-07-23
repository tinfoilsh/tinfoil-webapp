import { SETTINGS_CACHED_SUBSCRIPTION_STATUS } from '@/constants/storage-keys'
import { useUser } from '@clerk/nextjs'
import { useEffect, useState } from 'react'

type StripeSubscriptionStatus =
  | 'active'
  | 'canceled'
  | 'incomplete'
  | 'incomplete_expired'
  | 'past_due'
  | 'paused'
  | 'trialing'
  | 'unpaid'

const SUPPORTED_STATUSES = new Set<StripeSubscriptionStatus>([
  'active',
  'canceled',
  'incomplete',
  'incomplete_expired',
  'past_due',
  'paused',
  'trialing',
  'unpaid',
])
const MAX_TIMEOUT_MS = 2_147_483_647

const isValidStatus = (status: unknown): status is StripeSubscriptionStatus =>
  typeof status === 'string' &&
  SUPPORTED_STATUSES.has(status as StripeSubscriptionStatus)

const parseExpiration = (expiration: unknown): Date | null => {
  if (typeof expiration !== 'string' || expiration.trim().length === 0) {
    return null
  }

  const parsed = new Date(expiration)
  if (Number.isNaN(parsed.getTime())) {
    return null
  }

  return parsed
}

export const hasActiveSubscription = (
  status: StripeSubscriptionStatus | null,
  expiration: Date | null,
  now: Date,
) => {
  if (!status) {
    return false
  }

  if (status === 'active' || status === 'trialing') {
    return !expiration || expiration.getTime() > now.getTime()
  }

  if (status === 'canceled' && expiration) {
    return expiration.getTime() > now.getTime()
  }

  return false
}

/**
 * Hook to get subscription status from Clerk user's public metadata.
 * This is a fully client-side implementation that reads from useUser().
 */
export function useSubscriptionStatus() {
  const { user, isLoaded } = useUser()
  const [, setExpirationTick] = useState(0)

  const publicMetadata = (user?.publicMetadata ?? {}) as Record<string, unknown>
  const rawChatStatus = publicMetadata['chat_subscription_status']
  const chatStatus = isValidStatus(rawChatStatus) ? rawChatStatus : null
  const chatExpiration = parseExpiration(
    publicMetadata['chat_subscription_expires_at'],
  )
  const expirationTime = chatExpiration?.getTime() ?? null

  useEffect(() => {
    if (expirationTime === null) return
    let timeout: number | undefined
    const scheduleExpiration = () => {
      const delay = expirationTime - Date.now()
      if (delay <= 0) {
        setExpirationTick((tick) => tick + 1)
        return
      }
      timeout = window.setTimeout(
        scheduleExpiration,
        Math.min(delay + 1, MAX_TIMEOUT_MS),
      )
    }
    scheduleExpiration()
    return () => {
      if (timeout !== undefined) window.clearTimeout(timeout)
    }
  }, [expirationTime])

  const chatSubscriptionActive =
    isLoaded &&
    !!user &&
    hasActiveSubscription(chatStatus, chatExpiration, new Date())

  // Persist subscription status so next page load can use it immediately
  useEffect(() => {
    if (!isLoaded) return
    try {
      if (!user) {
        localStorage.removeItem(SETTINGS_CACHED_SUBSCRIPTION_STATUS)
        return
      }
      localStorage.setItem(
        SETTINGS_CACHED_SUBSCRIPTION_STATUS,
        JSON.stringify({
          chat_subscription_active: chatSubscriptionActive,
        }),
      )
    } catch {
      // best-effort
    }
  }, [isLoaded, user, chatSubscriptionActive])

  return {
    isLoading: !isLoaded,
    error: null,
    chat_subscription_active: chatSubscriptionActive,
  }
}
