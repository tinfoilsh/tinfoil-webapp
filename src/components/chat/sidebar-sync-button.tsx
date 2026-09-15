import { cn } from '@/components/ui/utils'
import { CheckIcon } from '@heroicons/react/24/outline'
import { motion } from 'framer-motion'
import { useState } from 'react'
import { GoSync } from 'react-icons/go'
import { PiSpinner } from 'react-icons/pi'
import { CONSTANTS } from './constants'

type SyncFeedback = 'idle' | 'syncing' | 'success'

interface SidebarSyncButtonProps {
  isSyncing: boolean
  syncFailed: boolean
  onSync: () => Promise<boolean>
}

function wait(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs))
}

export function SidebarSyncButton({
  isSyncing,
  syncFailed,
  onSync,
}: SidebarSyncButtonProps) {
  const [feedback, setFeedback] = useState<SyncFeedback>('idle')
  const [manualSyncFailed, setManualSyncFailed] = useState(false)
  const showSpinner = isSyncing || feedback === 'syncing'
  const isDisabled = isSyncing || feedback !== 'idle'
  const showSuccess = feedback === 'success'
  const hasSyncFailure = syncFailed || manualSyncFailed
  const statusLabel = showSpinner
    ? 'Syncing'
    : hasSyncFailure
      ? 'Sync failed'
      : 'Sync healthy'

  const handleSync = async () => {
    const startedAt = Date.now()
    setFeedback('syncing')
    setManualSyncFailed(false)

    let succeeded = false
    try {
      succeeded = await onSync()
    } catch {
      succeeded = false
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

    setFeedback('success')
    await wait(CONSTANTS.SIDEBAR_SYNC_SUCCESS_FEEDBACK_MS)
    setFeedback('idle')
  }

  return (
    <div className="group relative flex items-center">
      <button
        type="button"
        onClick={() => void handleSync()}
        disabled={isDisabled}
        aria-label={`Sync cloud data. ${showSuccess ? 'Synced' : statusLabel}`}
        className={cn(
          'relative flex items-center justify-center rounded-lg border border-border-subtle bg-surface-chat-background p-2 text-content-secondary transition-all duration-200 hover:bg-surface-chat hover:text-content-primary disabled:cursor-default',
          showSpinner && 'opacity-60',
        )}
      >
        <span className="relative h-5 w-5">
          <motion.span
            initial={false}
            animate={{
              opacity: showSuccess ? 0 : 1,
              filter: showSuccess ? 'blur(2px)' : 'blur(0px)',
            }}
            transition={
              showSuccess
                ? {
                    duration: CONSTANTS.SIDEBAR_SYNC_FEEDBACK_EXIT_S,
                    ease: 'easeOut',
                  }
                : {
                    duration: CONSTANTS.SIDEBAR_SYNC_FEEDBACK_ENTER_S,
                    delay: CONSTANTS.SIDEBAR_SYNC_FEEDBACK_ENTER_DELAY_S,
                    ease: 'easeOut',
                  }
            }
            className="absolute inset-0 flex items-center justify-center"
            aria-hidden="true"
          >
            {showSpinner ? (
              <PiSpinner className="h-5 w-5 animate-spin" />
            ) : (
              <GoSync className="h-5 w-5" />
            )}
            {!showSpinner && (
              <span
                className={cn(
                  'absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full ring-2 ring-surface-chat-background',
                  hasSyncFailure ? 'bg-orange-500' : 'bg-green-500',
                )}
                title={statusLabel}
              />
            )}
          </motion.span>
          <motion.span
            initial={false}
            animate={{
              opacity: showSuccess ? 1 : 0,
              scale: showSuccess ? 1 : 0.7,
              filter: showSuccess ? 'blur(0px)' : 'blur(2px)',
            }}
            transition={
              showSuccess
                ? {
                    duration: CONSTANTS.SIDEBAR_SYNC_FEEDBACK_ENTER_S,
                    delay: CONSTANTS.SIDEBAR_SYNC_FEEDBACK_ENTER_DELAY_S,
                    ease: 'easeOut',
                  }
                : {
                    duration: CONSTANTS.SIDEBAR_SYNC_FEEDBACK_EXIT_S,
                    ease: 'easeOut',
                  }
            }
            className="pointer-events-none absolute inset-0 flex items-center justify-center text-green-600 dark:text-green-400"
            aria-hidden={!showSuccess}
          >
            <CheckIcon className="h-5 w-5" strokeWidth={2.5} />
          </motion.span>
        </span>
      </button>
      <span className="pointer-events-none absolute left-1/2 top-full z-50 mt-1 -translate-x-1/2 whitespace-nowrap rounded border border-border-subtle bg-surface-chat-background px-2 py-1 text-xs text-content-primary opacity-0 shadow-sm transition-opacity group-hover:opacity-100">
        {showSuccess ? 'Synced' : statusLabel}
      </span>
    </div>
  )
}
