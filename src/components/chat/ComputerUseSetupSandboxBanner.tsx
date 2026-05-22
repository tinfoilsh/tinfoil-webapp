/**
 * Post-pair, pre-image banner: prompts the user to set up their first sandbox
 * image with a single click, no CLI required. Drives the broker's
 * `POST /images/setup-default` endpoint, which pulls + provisions a known-good
 * base in the background and reflects progress via `/status`'s setup_job.
 *
 * Lifecycle:
 *   - idle (no setup_job): "Set up a sandbox" + Start button
 *   - pulling: indeterminate progress + the broker's progress message
 *   - provisioning: ditto, different label
 *   - done: brief success ("Sandbox ready!") — auto-dismissed when the next
 *     /status poll reflects the new ready image (the banner's `show` gate
 *     flips off in `chat-input.tsx`)
 *   - error: red error band + Retry button
 *
 * The webapp doesn't need to poll a separate progress endpoint — the existing
 * /status poll in `useBrokerStatus` already surfaces `setup_job`.
 */
'use client'

import { cn } from '@/components/ui/utils'
import type { BrokerSetupJob } from '@/services/computer-use'
import { XMarkIcon } from '@heroicons/react/24/outline'
import { useState } from 'react'
import { PiDesktop, PiSpinner } from 'react-icons/pi'

interface ComputerUseSetupSandboxBannerProps {
  /** Caller gates visibility (broker paired + no ready image yet). */
  show: boolean
  /** Live setup-job snapshot from /status, when one is in flight. */
  job?: BrokerSetupJob
  /** Trigger `POST /images/setup-default`. */
  onStart: () => void
  isDarkMode: boolean
}

const DISMISSED_KEY = 'tinfoil-computer-use-setup-banner-dismissed'

function readDismissed(): boolean {
  try {
    return (
      typeof window !== 'undefined' &&
      window.sessionStorage?.getItem(DISMISSED_KEY) === '1'
    )
  } catch {
    return false
  }
}

function writeDismissed(): void {
  try {
    window.sessionStorage?.setItem(DISMISSED_KEY, '1')
  } catch {
    /* sessionStorage may be unavailable in sandboxed contexts */
  }
}

const STATE_LABEL: Record<BrokerSetupJob['state'], string> = {
  pulling: 'Pulling base image…',
  provisioning: 'Provisioning sandbox…',
  done: 'Sandbox ready!',
  error: 'Setup failed',
}

export function ComputerUseSetupSandboxBanner({
  show,
  job,
  onStart,
  isDarkMode,
}: ComputerUseSetupSandboxBannerProps) {
  // Local dismiss for the page-load. Stays dismissed until reload — same UX
  // shape as the Connect banner so they feel consistent.
  const [dismissed, setDismissed] = useState<boolean>(() => readDismissed())
  if (!show || dismissed) return null

  const inFlight = job?.state === 'pulling' || job?.state === 'provisioning'
  const isError = job?.state === 'error'

  return (
    <div
      role="status"
      className={cn(
        'mx-auto mb-2 flex max-w-3xl items-start gap-2 rounded-lg border px-3 py-2 text-sm shadow-sm',
        isError
          ? isDarkMode
            ? 'border-red-500/40 bg-red-950/60 text-red-200'
            : 'border-red-300 bg-red-50 text-red-700'
          : isDarkMode
            ? 'border-amber-500/30 bg-amber-500/10 text-amber-200'
            : 'border-amber-300 bg-amber-50 text-amber-900',
      )}
    >
      {inFlight ? (
        <PiSpinner
          aria-hidden
          className="size-4 flex-shrink-0 animate-spin text-current opacity-80"
        />
      ) : (
        <PiDesktop
          aria-hidden
          className="size-4 flex-shrink-0 text-current opacity-80"
        />
      )}
      <div className="flex flex-1 flex-col gap-0.5">
        <span className="font-medium">
          {job ? STATE_LABEL[job.state] : 'Set up your sandbox'}
        </span>
        {job?.message && !isError && (
          <span className="text-xs opacity-80">{job.message}</span>
        )}
        {isError && job?.error && (
          <span className="text-xs opacity-80">{job.error}</span>
        )}
        {!job && (
          <span className="text-xs opacity-80">
            Pulls a base macOS image (~21 GB) and gets it ready to drive. Runs
            in the background — no CLI needed.
          </span>
        )}
      </div>
      {!job && (
        <button
          type="button"
          onClick={onStart}
          className={cn(
            'rounded-md px-2 py-1 text-xs font-medium transition-colors',
            isDarkMode
              ? 'bg-amber-500/20 text-amber-100 hover:bg-amber-500/30'
              : 'bg-amber-500/20 text-amber-900 hover:bg-amber-500/30',
          )}
        >
          Start
        </button>
      )}
      {isError && (
        <button
          type="button"
          onClick={onStart}
          className={cn(
            'rounded-md px-2 py-1 text-xs font-medium transition-colors',
            isDarkMode
              ? 'bg-red-500/20 text-red-100 hover:bg-red-500/30'
              : 'bg-red-500/20 text-red-900 hover:bg-red-500/30',
          )}
        >
          Retry
        </button>
      )}
      <button
        type="button"
        onClick={() => {
          writeDismissed()
          setDismissed(true)
        }}
        aria-label="Dismiss"
        className={cn(
          'rounded-md p-1 transition-colors',
          isError
            ? 'hover:bg-red-500/20'
            : isDarkMode
              ? 'hover:bg-amber-500/20'
              : 'hover:bg-amber-500/20',
        )}
      >
        <XMarkIcon className="size-4" />
      </button>
    </div>
  )
}
