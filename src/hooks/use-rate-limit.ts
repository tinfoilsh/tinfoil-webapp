'use client'

import { getView, subscribe } from '@/services/harness/runtime'
import type { RateLimit } from '@/services/harness/types'
import { useSyncExternalStore } from 'react'

const getSnapshot = () => getView().rateLimit ?? null
const getServerSnapshot = () => null

/** Live view of the account's quota (free-tier daily or subscriber hourly). */
export function useRateLimit(): Readonly<RateLimit> | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
