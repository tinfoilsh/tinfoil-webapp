/**
 * Inline pairing-handshake card. Renders as an assistant-styled chat message
 * while the broker session is in the `pairing` phase — the user verifies the
 * code shown here matches the code shown by the system-tray's pairing
 * prompt, then clicks Approve in the tray. Mutated to a terminal state
 * (approved / denied / cancelled / timeout) once the handshake resolves, so
 * historical chats render a static record of the choice.
 *
 * Replaces the old `ComputerUseSessionDialog`-as-modal pairing UI. The chat
 * thread is where the matching code is shown to the user; the modal was
 * context-stealing in addition to being a separate surface from the rest of
 * the consent / session flow.
 */
'use client'

import { useComputerUseFunnelContext } from '@/components/chat/computer-use-funnel-context'
import { cn } from '@/components/ui/utils'
import { CheckCircleIcon, XCircleIcon } from '@heroicons/react/24/outline'
import { PiSpinner } from 'react-icons/pi'

interface ComputerUsePairingCardProps {
  code: string | undefined
  status:
    | 'pending'
    | 'approved'
    | 'denied'
    | 'cancelled'
    | 'timeout'
    | undefined
}

const STATE_LABEL: Record<
  NonNullable<ComputerUsePairingCardProps['status']>,
  string
> = {
  pending: 'Waiting for tray approval…',
  approved: 'Approved in tray',
  denied: 'Declined in tray',
  cancelled: 'Pairing cancelled',
  timeout: 'Pairing timed out',
}

export function ComputerUsePairingCard({
  code,
  status,
}: ComputerUsePairingCardProps) {
  const effectiveStatus = status ?? 'pending'
  const ctx = useComputerUseFunnelContext()
  const isPending = effectiveStatus === 'pending'
  return (
    <div className="relative mx-auto mb-6 flex w-full max-w-3xl flex-col items-start">
      <div className="w-full px-4 py-2">
        <div className="overflow-hidden rounded-2xl border border-border-subtle bg-surface-chat-background">
          <PairingHeader status={effectiveStatus} />
          <div className="space-y-3 px-5 py-4">
            {isPending && (
              <>
                <p className="text-sm text-content-secondary">
                  Approve this connection in the Tinfoil menu-bar icon. Make
                  sure the code matches before clicking Approve:
                </p>
                <div className="flex justify-center font-mono text-3xl font-bold tracking-widest text-content-primary">
                  {code ?? '····'}
                </div>
                <p className="text-center text-xs text-content-muted">
                  Waiting for your decision in the tray…
                </p>
              </>
            )}
            {!isPending && code && (
              <p className="text-sm text-content-secondary">
                Pairing code{' '}
                <span className="font-mono font-semibold text-content-primary">
                  {code}
                </span>{' '}
                — {STATE_LABEL[effectiveStatus].toLowerCase()}.
              </p>
            )}
            {isPending && ctx && (
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={ctx.cancelPairing}
                  className="rounded-md px-2 py-1 text-xs text-content-secondary hover:bg-surface-chat hover:text-content-primary"
                >
                  Cancel pairing
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function PairingHeader({
  status,
}: {
  status: NonNullable<ComputerUsePairingCardProps['status']>
}) {
  const tone =
    status === 'approved'
      ? 'positive'
      : status === 'denied' || status === 'timeout'
        ? 'negative'
        : status === 'cancelled'
          ? 'muted'
          : 'pending'
  const toneCls = {
    pending: 'text-amber-600 dark:text-amber-400',
    positive: 'text-green-600 dark:text-green-400',
    negative: 'text-red-500',
    muted: 'text-content-secondary',
  }[tone]
  return (
    <div className="flex items-center justify-between border-b border-border-subtle px-3 py-2">
      <span className="flex items-center gap-2 text-xs font-medium text-content-secondary">
        <span className="text-content-primary">Computer use</span>
        <span className={cn(toneCls, 'flex items-center gap-1')}>
          · {STATE_LABEL[status]}
          {status === 'pending' && (
            <PiSpinner className="size-3 animate-spin" />
          )}
          {status === 'approved' && <CheckCircleIcon className="size-3" />}
          {(status === 'denied' || status === 'timeout') && (
            <XCircleIcon className="size-3" />
          )}
        </span>
      </span>
    </div>
  )
}
