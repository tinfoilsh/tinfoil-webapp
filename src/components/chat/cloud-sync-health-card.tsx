import { TfExclamationCircle } from '@tinfoilsh/tinfoil-icons'
import { cn } from '../ui/utils'

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
