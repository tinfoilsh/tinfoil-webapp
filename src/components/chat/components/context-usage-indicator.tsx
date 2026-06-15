'use client'

import { cn } from '@/components/ui/utils'

export type ContextUsage = {
  percentage: number
  usedTokens: number
  limitTokens: number
}

// Usage percentage at which the indicator switches to the warning color
const WARNING_THRESHOLD_PERCENT = 80

const RING_RADIUS = 7
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

function formatTokens(tokens: number): string {
  if (tokens >= 1000) {
    return `${Math.round(tokens / 1000)}k`
  }
  return tokens.toString()
}

/**
 * Small circular gauge showing how much of the model's context window the
 * current conversation occupies. Once usage passes 100%, older messages get
 * archived and are no longer sent to the model.
 */
export function ContextUsageIndicator({ usage }: { usage: ContextUsage }) {
  const percentage = Math.min(Math.round(usage.percentage), 100)

  const isNearLimit = percentage >= WARNING_THRESHOLD_PERCENT
  const isFull = percentage >= 100
  const dashOffset = RING_CIRCUMFERENCE * (1 - percentage / 100)

  const tooltip = isFull
    ? `Context window full (~${formatTokens(usage.limitTokens)} tokens). Older messages are archived and no longer sent to the model.`
    : `Context window ${percentage}% used (~${formatTokens(usage.usedTokens)} of ${formatTokens(usage.limitTokens)} tokens)`

  return (
    <div className="group relative hidden items-center md:flex">
      <span
        role="status"
        aria-label={tooltip}
        className={cn(
          'flex h-7 items-center gap-1 rounded-lg px-1.5',
          isNearLimit ? 'text-amber-500' : 'text-content-secondary',
        )}
      >
        <svg
          className="h-4 w-4 -rotate-90"
          viewBox="0 0 18 18"
          aria-hidden="true"
        >
          <circle
            cx="9"
            cy="9"
            r={RING_RADIUS}
            fill="none"
            strokeWidth="2"
            className="stroke-border-subtle"
          />
          <circle
            cx="9"
            cy="9"
            r={RING_RADIUS}
            fill="none"
            strokeWidth="2"
            strokeLinecap="round"
            stroke="currentColor"
            strokeDasharray={RING_CIRCUMFERENCE}
            strokeDashoffset={dashOffset}
          />
        </svg>
        <span className="text-xs font-medium leading-none">{percentage}%</span>
      </span>
      <span className="pointer-events-none absolute -top-9 right-0 z-20 max-w-64 whitespace-normal rounded border border-border-subtle bg-surface-chat-background px-2 py-1 text-center text-xs text-content-primary opacity-0 shadow-sm transition-opacity group-hover:opacity-100">
        {tooltip}
      </span>
    </div>
  )
}
