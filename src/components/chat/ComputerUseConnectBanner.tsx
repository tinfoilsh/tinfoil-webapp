/**
 * Small banner shown above the chat input when:
 *   - the local computer driver (broker) is reachable, AND
 *   - this browser has not yet paired with it, AND
 *   - the current model is vision-capable (otherwise pairing wouldn't help), AND
 *   - the host is macOS (the driver only runs there for MVP).
 *
 * Click "Connect" to run the pairing flow eagerly (no chat input required).
 * The X dismisses the banner for the rest of the page-load — so the user
 * isn't nagged after declining — while reload re-shows it. Successful
 * pairing makes it disappear naturally because `usePaired()` flips true.
 *
 * Why a banner (not just the toggle): without this, the only signal that the
 * driver was detected is the toggle becoming clickable, which the user has
 * to notice. A short inline prompt above the input is the first thing in
 * their eye-line and makes the one-time setup discoverable.
 */
'use client'

import { cn } from '@/components/ui/utils'
import { XMarkIcon } from '@heroicons/react/24/outline'
import { useState } from 'react'
import { PiDesktop } from 'react-icons/pi'

interface ComputerUseConnectBannerProps {
  /** Shown only when all gates are satisfied (caller computes them). */
  show: boolean
  /** Trigger the pairing flow (drives session.connect()). */
  onConnect: () => void
  isDarkMode: boolean
}

const DISMISSED_KEY = 'tinfoil-computer-use-connect-banner-dismissed'

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

export function ComputerUseConnectBanner({
  show,
  onConnect,
  isDarkMode,
}: ComputerUseConnectBannerProps) {
  // Local dismiss for the page-load. sessionStorage so a reload re-shows it,
  // and so cross-tab dismissals don't leak (per-tab UX feels right here).
  const [dismissed, setDismissed] = useState<boolean>(() => readDismissed())
  if (!show || dismissed) return null

  return (
    <div
      role="status"
      // Width fits content, anchored to the left of the input column so the
      // banner reads as an inline cue rather than a chat-width chrome strip.
      // `max-w-3xl` caps it so a future longer message can't grow forever.
      className={cn(
        'mb-2 mr-auto inline-flex max-w-3xl items-center gap-2 rounded-lg border px-3 py-2 text-sm shadow-sm',
        isDarkMode
          ? 'border-amber-500/30 bg-amber-500/10 text-amber-200'
          : 'border-amber-300 bg-amber-50 text-amber-900',
      )}
    >
      <PiDesktop
        aria-hidden
        className="size-4 flex-shrink-0 text-current opacity-80"
      />
      <span className="flex-1 truncate">
        Local computer driver detected — pair to enable computer use.
      </span>
      <button
        type="button"
        onClick={onConnect}
        className={cn(
          'rounded-md px-2 py-1 text-xs font-medium transition-colors',
          isDarkMode
            ? 'bg-amber-500/20 text-amber-100 hover:bg-amber-500/30'
            : 'bg-amber-500/20 text-amber-900 hover:bg-amber-500/30',
        )}
      >
        Connect
      </button>
      <button
        type="button"
        onClick={() => {
          writeDismissed()
          setDismissed(true)
        }}
        aria-label="Dismiss"
        className={cn(
          'rounded-md p-1 transition-colors',
          isDarkMode ? 'hover:bg-amber-500/20' : 'hover:bg-amber-500/20',
        )}
      >
        <XMarkIcon className="size-4" />
      </button>
    </div>
  )
}
