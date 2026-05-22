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
}

export function ComputerUseToolButton({
  variant = 'desktop',
  enabled,
  onToggle,
  isDarkMode,
  supported,
  reason,
}: ComputerUseToolButtonProps) {
  const active = enabled && supported
  const tooltip = supported
    ? 'Computer use'
    : (reason ?? 'Computer use is unavailable for this model.')

  // Mobile: a row in the "+" menu, matching the web-search / code-execution items.
  if (variant === 'mobile') {
    return (
      <button
        type="button"
        onClick={supported ? onToggle : undefined}
        disabled={!supported}
        aria-pressed={enabled}
        className={cn(
          'flex w-full items-center gap-3 px-3 py-2 text-left text-sm text-content-primary hover:bg-surface-chat-background',
          !supported && 'cursor-not-allowed opacity-50',
        )}
      >
        <PiDesktop className="h-5 w-5 text-content-secondary" />
        <span className="flex-1">Computer use</span>
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
        onClick={supported ? onToggle : undefined}
        disabled={!supported}
        aria-label="Computer use"
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
        <PiDesktop className="h-5 w-5" />
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
