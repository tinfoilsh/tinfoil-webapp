'use client'

import { logError } from '@/utils/error-handling'
import { useEffect, useRef, useState } from 'react'
import { CONSTANTS } from '../constants'

type SyncFeedback = 'idle' | 'syncing' | 'success'

interface UseManualSyncOptions {
  isSyncing: boolean
  syncFailed: boolean
  onSync: () => Promise<boolean>
}

export interface ManualSyncState {
  /** Spinner is showing, either from a background sync or a manual one. */
  showSpinner: boolean
  /** Brief confirmation window after a manual sync succeeds. */
  showSuccess: boolean
  /** The last manual or background sync failed. */
  hasSyncFailure: boolean
  isDisabled: boolean
  statusLabel: string
  sync: () => Promise<void>
}

function wait(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs))
}

/**
 * Drives the manual sync control: keeps the spinner up for a minimum
 * duration so quick syncs still read as activity, then shows a short
 * success confirmation before settling back to idle.
 */
export function useManualSync({
  isSyncing,
  syncFailed,
  onSync,
}: UseManualSyncOptions): ManualSyncState {
  const [feedback, setFeedback] = useState<SyncFeedback>('idle')
  const [manualSyncFailed, setManualSyncFailed] = useState(false)
  const backgroundSyncActive = useRef(false)

  useEffect(() => {
    if (isSyncing && feedback === 'idle') backgroundSyncActive.current = true
    if (!isSyncing && backgroundSyncActive.current) {
      backgroundSyncActive.current = false
      if (!syncFailed) setManualSyncFailed(false)
    }
  }, [isSyncing, syncFailed, feedback])

  const showSpinner = isSyncing || feedback === 'syncing'
  const hasSyncFailure = syncFailed || manualSyncFailed
  const showSuccess = feedback === 'success' && !hasSyncFailure
  const statusLabel = showSpinner
    ? hasSyncFailure
      ? 'Retrying failed sync'
      : 'Syncing'
    : hasSyncFailure
      ? 'Sync failed'
      : showSuccess
        ? 'Synced'
        : 'Sync healthy'

  const sync = async () => {
    const startedAt = Date.now()
    setFeedback('syncing')

    let succeeded = false
    try {
      succeeded = await onSync()
    } catch (error) {
      logError('Manual sync failed', error, {
        component: 'useManualSync',
        action: 'sync',
      })
    }

    const remainingSpinnerTime = Math.max(
      0,
      CONSTANTS.SIDEBAR_SYNC_MIN_SPINNER_MS - (Date.now() - startedAt),
    )
    if (remainingSpinnerTime > 0) {
      await wait(remainingSpinnerTime)
    }

    if (!succeeded) {
      setManualSyncFailed(true)
      setFeedback('idle')
      return
    }

    setManualSyncFailed(false)
    setFeedback('success')
    await wait(CONSTANTS.SIDEBAR_SYNC_SUCCESS_FEEDBACK_MS)
    setFeedback('idle')
  }

  return {
    showSpinner,
    showSuccess,
    hasSyncFailure,
    isDisabled: isSyncing || feedback !== 'idle',
    statusLabel,
    sync,
  }
}
