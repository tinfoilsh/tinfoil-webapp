'use client'

import { cn } from '@/components/ui/utils'
import { useSessionFeature } from '@/services/harness/provider'

export type ContextUsage = {
  percentage: number
  usedTokens: number
  limitTokens: number
}

// Usage percentage at which the indicator switches to the warning color
const WARNING_THRESHOLD_PERCENT = 80

// The session feature of a harness that summarizes a chat's earlier messages
// when its prompt outgrows the budget.
const COMPACTION_FEATURE = 'compaction'
const COMPACTION_NOTE = 'Earlier messages will be summarized to make room.'

const RING_RADIUS = 7
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

function formatTokens(tokens: number): string {
  if (tokens >= 1000) {
    return `${Math.round(tokens / 1000)}k`
  }
  return tokens.toString()
}

/**
 * Small circular gauge showing how much of the prompt budget (the share of
 * the model's context window a prompt may fill) the chat's last prompt used.
 * A prompt over the budget has its earlier messages summarized when the
 * harness compacts chats; otherwise older messages are left out, which
 * cannot make a prompt fit whose latest message alone exceeds the budget.
 */
export function ContextUsageIndicator({
  usage,
  className,
}: {
  usage: ContextUsage
  className?: string
}) {
  const compacts = useSessionFeature(COMPACTION_FEATURE)
  const percentage = Math.min(Math.round(usage.percentage), 100)

  const isNearLimit = percentage >= WARNING_THRESHOLD_PERCENT
  const isFull = usage.usedTokens >= usage.limitTokens
  const isOverBudget = usage.usedTokens > usage.limitTokens
  const dashOffset = RING_CIRCUMFERENCE * (1 - percentage / 100)

  const tooltip = isOverBudget
    ? `Context exceeds this model's input budget (~${formatTokens(usage.usedTokens)} of ${formatTokens(usage.limitTokens)} tokens). ${compacts ? COMPACTION_NOTE : 'Replies may fail. Reduce project documents or instructions, remove attachments, or shorten your message.'}`
    : isFull
      ? `Context window full (~${formatTokens(usage.limitTokens)} tokens). ${compacts ? COMPACTION_NOTE : 'Older messages may be omitted to make room.'}`
      : `Context window ${percentage}% used (~${formatTokens(usage.usedTokens)} of ${formatTokens(usage.limitTokens)} tokens)`

  return (
    <div className={cn('group relative flex items-center', className)}>
      <span
        role="img"
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
        <span className="text-xs font-medium leading-none">
          {isOverBudget ? 'Over limit' : `${percentage}%`}
        </span>
      </span>
      <span className="pointer-events-none absolute bottom-full right-0 z-20 mb-1 w-max max-w-xs whitespace-normal rounded border border-border-subtle bg-surface-chat-background px-2 py-1 text-center text-xs text-content-primary opacity-0 shadow-sm transition-opacity group-hover:opacity-100">
        {tooltip}
      </span>
    </div>
  )
}
