/**
 * Chat-input toolbar button for the computer-use tool, mirroring the web-search
 * / code-execution toggles. Presentational only: capability (vision) is resolved
 * by the parent and passed in. Non-vision models render the button disabled with
 * a "needs vision" tooltip rather than hiding it, so the constraint is
 * discoverable.
 *
 * (A live broker online/offline indicator was prototyped here; removed for now
 * pending a positioning pass — the detection plumbing still lives in
 * `services/computer-use` and is wired for conditional tool exposure.)
 */

import { cn } from '@/components/ui/utils'
import { PiDesktop } from 'react-icons/pi'

export interface ComputerUseToolButtonProps {
  variant?: 'desktop' | 'mobile'
  enabled: boolean
  onToggle: () => void
  isDarkMode: boolean
  /** Whether the current model can drive computer use (vision-capable). */
  supported: boolean
  /** Constraint to surface when not supported. */
  reason?: string
  /**
   * Whether this browser has already paired with the local computer driver.
   * When false (but `supported` is true), the click action switches from
   * toggling the feature for the conversation to running the one-time
   * pairing flow — and the tooltip explains that. Defaults to true so
   * existing call sites that don't know about pairing get the original
   * toggle-only behavior.
   */
  paired?: boolean
  /**
   * Click handler for the unpaired state. Required when `paired === false`
   * to actually launch the pairing flow; ignored otherwise.
   */
  onConnect?: () => void
}

export function ComputerUseToolButton({
  variant = 'desktop',
  enabled,
  onToggle,
  isDarkMode,
  supported,
  reason,
  paired = true,
  onConnect,
}: ComputerUseToolButtonProps) {
  const active = enabled && supported && paired
  // Three click states resolved here:
  //   - !supported → button disabled (tooltip explains why)
  //   - supported && !paired → fires onConnect (one-time pair)
  //   - supported && paired → fires onToggle (per-conversation enable)
  const handleClick = !supported ? undefined : !paired ? onConnect : onToggle
  const tooltip = !supported
    ? (reason ?? 'Computer use is unavailable for this model.')
    : !paired
      ? 'Click to pair to computer driver'
      : 'Computer use'

  // Visual cue for the "supported but not paired" state: a small amber dot on
  // the icon, telling the user "this needs a one-time setup action" without
  // requiring them to hover for the tooltip.
  const needsPair = supported && !paired

  // Mobile: a row in the "+" menu, matching the web-search / code-execution items.
  if (variant === 'mobile') {
    return (
      <button
        type="button"
        onClick={handleClick}
        disabled={!supported}
        aria-pressed={enabled}
        title={tooltip}
        className={cn(
          'flex w-full items-center gap-3 px-3 py-2 text-left text-sm text-content-primary hover:bg-surface-chat-background',
          !supported && 'cursor-not-allowed opacity-50',
        )}
      >
        <span className="relative">
          <PiDesktop className="h-5 w-5 text-content-secondary" />
          {needsPair && (
            <span
              aria-hidden
              className="absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-amber-500"
            />
          )}
        </span>
        <span className="flex-1">
          {needsPair ? 'Pair computer driver' : 'Computer use'}
        </span>
        {active && (
          <svg
            className="h-4 w-4 text-brand-accent-light"
            viewBox="0 0 20 20"
            fill="currentColor"
          >
            <path
              fillRule="evenodd"
              d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
              clipRule="evenodd"
            />
          </svg>
        )}
      </button>
    )
  }

  // Desktop: icon toggle in the same row as web search.
  return (
    <div className="group relative hidden md:block">
      <button
        id="computer-use-button"
        type="button"
        onClick={handleClick}
        disabled={!supported}
        aria-label={needsPair ? 'Pair computer driver' : 'Computer use'}
        aria-pressed={enabled}
        className={cn(
          'flex h-7 items-center justify-center gap-1.5 rounded-lg transition-colors',
          active
            ? cn(
                'px-2',
                isDarkMode
                  ? 'bg-brand-accent-light/20 text-brand-accent-light'
                  : 'bg-brand-accent-dark/20 text-brand-accent-dark',
              )
            : 'w-7 text-content-secondary hover:bg-surface-chat-background hover:text-content-primary',
          !supported && 'cursor-not-allowed opacity-40 hover:bg-transparent',
        )}
      >
        <span className="relative">
          <PiDesktop className="h-5 w-5" />
          {needsPair && (
            <span
              aria-hidden
              className="absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-amber-500"
            />
          )}
        </span>
        {active && (
          <span className="text-xs font-medium leading-none">Computer</span>
        )}
      </button>
      {!active && (
        <span className="pointer-events-none absolute -top-8 left-1/2 -translate-x-1/2 whitespace-nowrap rounded border border-border-subtle bg-surface-chat-background px-2 py-1 text-xs text-content-primary opacity-0 shadow-sm transition-opacity group-hover:opacity-100">
          {tooltip}
        </span>
      )}
    </div>
  )
}
