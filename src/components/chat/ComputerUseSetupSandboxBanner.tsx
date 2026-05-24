/**
 * Post-pair, pre-image banner: prompts the user to set up their first sandbox
 * image with a single click, no CLI required. Drives the driver's
 * `POST /images/setup-default` endpoint, which pulls + provisions a known-good
 * base in the background and reflects progress via `/status`'s setup_job.
 *
 * Lifecycle:
 *   - idle (no setup_job): "Set up a sandbox" + Start button
 *   - pulling: indeterminate progress + the driver's progress message
 *   - provisioning: ditto, different label
 *   - done: brief success ("Sandbox ready!") — auto-dismissed when the next
 *     /status poll reflects the new ready image (the banner's `show` gate
 *     flips off in `chat-input.tsx`)
 *   - error: red error band + Retry button
 *
 * The webapp doesn't need to poll a separate progress endpoint — the existing
 * /status poll in `useDriverStatus` already surfaces `setup_job`.
 */
'use client'

import { cn } from '@/components/ui/utils'
import type { DriverSetupJob } from '@/services/computer-use'
import { XMarkIcon } from '@heroicons/react/24/outline'
import { useState } from 'react'
import { PiDesktop, PiSpinner } from 'react-icons/pi'

interface ComputerUseSetupSandboxBannerProps {
  /** Caller gates visibility (driver paired + no ready image yet). */
  show: boolean
  /** Live setup-job snapshot from /status, when one is in flight. */
  job?: DriverSetupJob
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

const STATE_LABEL: Record<DriverSetupJob['state'], string> = {
  pulling: 'Pulling base image…',
  provisioning: 'Provisioning sandbox…',
  done: 'Sandbox ready!',
  error: 'Setup failed',
}

// Keyframes for the indeterminate progress bar. Slides the 35%-wide fill
// from off-screen-left to off-screen-right and back. Namespaced
// ("tinfoil-…") so it can't collide with other animations. Inlined via a
// <style> tag inside the component to avoid touching tailwind.config.
const INDETERMINATE_KEYFRAMES = `
@keyframes tinfoil-indeterminate-bar {
  0%   { transform: translateX(-100%); }
  60%  { transform: translateX(220%); }
  100% { transform: translateX(220%); }
}
`

/**
 * Slim progress bar. `fraction` undefined → indeterminate shimmer (a
 * looping translate animation); otherwise a filled bar at that ratio.
 * Tailwind handles colors so light/dark agree without a JS prop drill.
 */
function ProgressBar({
  fraction,
  isDarkMode,
}: {
  fraction: number | undefined
  isDarkMode: boolean
}) {
  const trackCls = isDarkMode ? 'bg-amber-500/20' : 'bg-amber-500/15'
  const fillCls = isDarkMode ? 'bg-amber-300' : 'bg-amber-600'
  if (fraction === undefined) {
    // Indeterminate: a 35%-wide bar that slides back and forth across the
    // track. Earlier we used `animate-pulse` (opacity-only) at a fixed 1/3
    // width, which read as "static 30%" rather than "indeterminate".
    // The keyframes are inlined via a <style> tag so we don't have to touch
    // tailwind.config; namespaced so there's no risk of clobbering.
    return (
      <div className={cn('mt-1 h-1 w-full overflow-hidden rounded', trackCls)}>
        <style>{INDETERMINATE_KEYFRAMES}</style>
        <div
          className={cn('h-full w-[35%] rounded', fillCls)}
          style={{
            animation:
              'tinfoil-indeterminate-bar 1.4s cubic-bezier(0.4, 0, 0.2, 1) infinite',
          }}
        />
      </div>
    )
  }
  // Clamp defensively in case the driver reports >100% (which it shouldn't).
  const clamped = Math.min(1, Math.max(0, fraction))
  return (
    <div className={cn('mt-1 h-1 w-full overflow-hidden rounded', trackCls)}>
      <div
        className={cn('h-full rounded transition-all duration-200', fillCls)}
        style={{ width: `${(clamped * 100).toFixed(1)}%` }}
      />
    </div>
  )
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
      // Left-anchored, content-width — same shape as the Connect banner. The
      // inner column expands to accommodate the progress bar.
      className={cn(
        'mb-2 mr-auto flex max-w-3xl items-start gap-2 rounded-lg border px-3 py-2 text-sm shadow-sm',
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
        <div className="flex items-center justify-between gap-2">
          <span className="font-medium">
            {job ? STATE_LABEL[job.state] : 'Set up your sandbox'}
          </span>
          {/* Show the percentage to the right of the label when we have a
              determinate fraction. Stays empty on `provisioning` (no source
              of percent) so the row doesn't lie about progress. */}
          {job?.state === 'pulling' &&
            typeof job.progress === 'number' &&
            job.progress > 0 && (
              <span className="font-mono text-xs tabular-nums opacity-80">
                {Math.round(job.progress * 100)}%
              </span>
            )}
        </div>
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
        {/* Progress bar. Determinate when we have a fraction; an
            indeterminate "shimmer" for the percentless phases (pre-pull
            "Resolving…" and the provisioning step). Both stop rendering on
            terminal states so the banner reads as a result, not a process. */}
        {job?.state === 'pulling' && (
          <ProgressBar
            fraction={
              typeof job.progress === 'number' && job.progress > 0
                ? job.progress
                : undefined
            }
            isDarkMode={isDarkMode}
          />
        )}
        {job?.state === 'provisioning' && (
          <ProgressBar fraction={undefined} isDarkMode={isDarkMode} />
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
