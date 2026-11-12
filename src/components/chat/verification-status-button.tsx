import { PrivacyLock } from '@/components/onboarding/privacy-lock'
import { cn } from '@/components/ui/utils'
import {
  TfLockLockedAnimated,
  TfLockOpenedAnimated,
} from '@tinfoilsh/tinfoil-icons/animated'
import { useEffect, useRef, useState } from 'react'
import { PiSpinner } from 'react-icons/pi'

export type VerificationStatus = 'pending' | 'verified' | 'failed'

export const VERIFIED_LABEL = 'Privacy verified'
// How long the verified label shows beside the lock as it swings shut, and how
// long it takes to fold away into the lock.
export const VERIFIED_LABEL_SHOWN_MS = 2500
export const VERIFIED_LABEL_EXIT_MS = 400

// Opens the verification panel and shows how verifying the chat service went.
// Once it succeeds, the lock swings shut, as in onboarding, beside a label
// that then folds away, leaving the lock. The label shows until `onVerifiedAnnounced` runs, so it
// shows once even though the button moves between the page and the chat
// header.
export function VerificationStatusButton({
  status,
  isPanelOpen,
  onTogglePanel,
  announceVerified,
  onVerifiedAnnounced,
  className,
}: {
  status: VerificationStatus
  isPanelOpen: boolean
  onTogglePanel: () => void
  announceVerified: boolean
  onVerifiedAnnounced: () => void
  className?: string
}) {
  const [leaving, setLeaving] = useState(false)
  const announced = useRef(onVerifiedAnnounced)
  announced.current = onVerifiedAnnounced
  const announcing = status === 'verified' && announceVerified
  useEffect(() => {
    if (!announcing) return
    if (!leaving) {
      const shown = setTimeout(() => setLeaving(true), VERIFIED_LABEL_SHOWN_MS)
      return () => clearTimeout(shown)
    }
    const gone = setTimeout(() => announced.current(), VERIFIED_LABEL_EXIT_MS)
    return () => clearTimeout(gone)
  }, [announcing, leaving])

  return (
    <div className={cn('group relative', className)}>
      <button
        id="verification-status"
        className={cn(
          'relative flex items-center justify-center gap-2 rounded-lg border p-2.5 transition-all duration-200',
          'bg-surface-chat-background text-content-secondary hover:border-border-subtle hover:bg-surface-chat hover:text-content-primary',
          isPanelOpen
            ? 'cursor-default border-border-subtle bg-surface-chat text-content-muted hover:text-content-muted'
            : 'border-transparent',
          status === 'verified' && 'gap-0',
        )}
        onClick={onTogglePanel}
        aria-label={
          isPanelOpen ? 'Close verification panel' : 'Open verification panel'
        }
        aria-pressed={isPanelOpen}
      >
        {status === 'pending' ? (
          <>
            <PiSpinner className="h-4 w-4 animate-spin" />
            <span className="text-sm leading-none">Verifying...</span>
          </>
        ) : status === 'verified' ? (
          <>
            {announcing ? (
              <PrivacyLock
                locked
                startOpen
                className="h-4 w-4 text-brand-accent-dark dark:text-brand-accent-light"
              />
            ) : (
              <TfLockLockedAnimated
                className="h-4 w-4 !text-brand-accent-dark dark:!text-brand-accent-light"
                aria-hidden="true"
              />
            )}
            {announcing && (
              <span
                data-leaving={leaving || undefined}
                className="grid grid-cols-[1fr] opacity-100 transition-[grid-template-columns,opacity] ease-in data-[leaving]:grid-cols-[0fr] data-[leaving]:opacity-0 motion-reduce:transition-none"
                style={{ transitionDuration: `${VERIFIED_LABEL_EXIT_MS}ms` }}
              >
                <span className="min-w-0 overflow-hidden">
                  <span className="block whitespace-nowrap pl-2 text-sm leading-none text-brand-accent-dark dark:text-brand-accent-light">
                    {VERIFIED_LABEL}
                  </span>
                </span>
              </span>
            )}
          </>
        ) : (
          <>
            <TfLockOpenedAnimated
              className="h-4 w-4 !text-red-500"
              aria-hidden="true"
            />
            <span className="text-sm leading-none text-red-500">Error</span>
          </>
        )}
      </button>
      <span className="pointer-events-none absolute -bottom-8 left-1/2 -translate-x-1/2 whitespace-nowrap rounded border border-border-subtle bg-surface-chat-background px-2 py-1 text-xs text-content-primary opacity-0 shadow-sm transition-opacity group-hover:opacity-100">
        {isPanelOpen ? 'Close verification' : 'View details'}
      </span>
    </div>
  )
}
