'use client'

import {
  getSyncHealthServerSnapshot,
  getSyncHealthSnapshot,
  subscribeSyncHealth,
  syncHealthNeedsAttention,
  type SyncHealthSnapshot,
} from '@/services/cloud/sync-health'
import { useEffect, useState, useSyncExternalStore } from 'react'

const ATTENTION_RECHECK_INTERVAL_MS = 60 * 1000

export function useSyncHealth(): SyncHealthSnapshot {
  return useSyncExternalStore(
    subscribeSyncHealth,
    getSyncHealthSnapshot,
    getSyncHealthServerSnapshot,
  )
}

/**
 * Whether the settings entry point should show the attention badge.
 * Re-evaluates on store changes and once a minute, because a paused
 * gate only starts deserving attention after it has persisted past
 * the self-healing window.
 */
export function useSyncHealthAttention(): boolean {
  const health = useSyncHealth()
  const [, setTick] = useState(0)

  const paused = health.gate.kind === 'paused'
  useEffect(() => {
    if (!paused) return
    const interval = setInterval(() => {
      setTick((t) => t + 1)
    }, ATTENTION_RECHECK_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [paused])

  return syncHealthNeedsAttention(health)
}
