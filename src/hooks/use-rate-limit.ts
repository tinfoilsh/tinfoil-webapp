'use client'

import {
  getRateLimitSnapshot,
  subscribeRateLimit,
  type RateLimitInfo,
} from '@/services/inference/tinfoil-client'
import { useSyncExternalStore } from 'react'

function getServerSnapshot(): null {
  return null
}

/** Live view of the cached rate limit (free-tier daily or subscriber hourly). */
export function useRateLimit(): Readonly<RateLimitInfo> | null {
  return useSyncExternalStore(
    subscribeRateLimit,
    getRateLimitSnapshot,
    getServerSnapshot,
  )
}
