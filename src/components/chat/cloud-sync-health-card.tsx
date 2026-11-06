import type { CloudSyncStatus } from '@/services/harness/runtime'
import { useStore, type Store } from '@/services/harness/store'
import {
  TfBoxCheckmark,
  TfCloud,
  TfExclamationCircle,
  TfWarning,
} from '@tinfoilsh/tinfoil-icons'
import { useEffect, useState } from 'react'
import { cn } from '../ui/utils'
import { formatRelativeTime } from './chat-list-utils'

// A sync this recent shows as "just now".
const RECENT_SYNC_MS = 60_000
// How often the time since the last sync moves on.
const SYNC_AGE_TICK_MS = 15_000

// Why the chat service refused this device's key: it has none, or another
// key than the account's.
export type CloudKeyActionReason = 'key-recovery' | 'key-mismatch'

const ACTION_REASON_COPY: Record<CloudKeyActionReason, string> = {
  'key-recovery':
    'Sync is paused because your encryption key needs to be recovered.',
  'key-mismatch':
    "This device's encryption key is out of date and needs to be recovered.",
}

interface CloudSyncHealthCardProps {
  isDarkMode: boolean
  reason: CloudKeyActionReason
  onRecoverClick?: () => void
}

/**
 * Status row for Settings > Cloud Sync while the chat service refuses this
 * device's key. Explains the problem and offers the recovery wizard.
 */
export function CloudSyncHealthCard({
  isDarkMode,
  reason,
  onRecoverClick,
}: CloudSyncHealthCardProps) {
  return (
    <div
      className={cn(
        'rounded-lg border border-orange-500/40 p-4',
        isDarkMode ? 'bg-surface-sidebar' : 'bg-white',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2">
          <TfExclamationCircle
            className="mt-0.5 h-4 w-4 shrink-0 text-orange-500"
            aria-hidden="true"
          />
          <div className="min-w-0">
            <div className="font-aeonik text-sm font-medium text-content-primary">
              Action needed
            </div>
            <div className="mt-0.5 font-aeonik-fono text-xs text-content-muted">
              {ACTION_REASON_COPY[reason]}
            </div>
          </div>
        </div>
        {onRecoverClick && (
          <button
            type="button"
            onClick={onRecoverClick}
            className="shrink-0 rounded-md bg-orange-500/90 px-2.5 py-1.5 font-aeonik text-xs font-medium text-white transition-colors hover:bg-orange-500"
          >
            Recover Key
          </button>
        )}
      </div>
    </div>
  )
}

// The time since a sync, redrawn as it grows.
function SyncAge({ at }: { at: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), SYNC_AGE_TICK_MS)
    return () => clearInterval(timer)
  }, [])
  const reference = Math.max(now, at)
  return (
    <>
      {reference - at < RECENT_SYNC_MS
        ? 'just now'
        : formatRelativeTime(new Date(at), reference)}
    </>
  )
}

interface CloudSyncStatusCardProps {
  isDarkMode: boolean
  status: Store<CloudSyncStatus>
}

/**
 * Status row for Settings > Cloud Sync while the key is accepted: whether
 * this browser reached the chats the cloud stores on its latest try, and
 * when it last did.
 */
export function CloudSyncStatusCard({
  isDarkMode,
  status,
}: CloudSyncStatusCardProps) {
  const { lastSyncedAt, failing } = useStore(status)
  return (
    <div
      className={cn(
        'rounded-lg border border-border-subtle p-4',
        isDarkMode ? 'bg-surface-sidebar' : 'bg-white',
      )}
    >
      <div className="flex min-w-0 items-start gap-2">
        {failing ? (
          <TfWarning
            className="mt-0.5 h-4 w-4 shrink-0 text-amber-500"
            aria-hidden="true"
          />
        ) : lastSyncedAt !== null ? (
          <TfBoxCheckmark
            className="mt-0.5 h-4 w-4 shrink-0 text-brand-accent-dark dark:text-brand-accent-light"
            aria-hidden="true"
          />
        ) : (
          <TfCloud
            className="mt-0.5 h-4 w-4 shrink-0 text-content-muted"
            aria-hidden="true"
          />
        )}
        <div className="min-w-0">
          <div className="font-aeonik text-sm font-medium text-content-primary">
            {failing ? (
              'Sync paused'
            ) : lastSyncedAt !== null ? (
              <>
                Synced <SyncAge at={lastSyncedAt} />
              </>
            ) : (
              'Checking sync...'
            )}
          </div>
          {failing && (
            <div className="mt-0.5 font-aeonik-fono text-xs text-content-muted">
              Having trouble reaching the cloud. Retrying automatically.
              {lastSyncedAt !== null && (
                <>
                  {' '}
                  Last synced <SyncAge at={lastSyncedAt} />.
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
