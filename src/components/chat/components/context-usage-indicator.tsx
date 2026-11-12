'use client'

import { cn } from '@/components/ui/utils'
import { useSessionFeature } from '@/services/harness/provider'
import { useEffect, useRef, useState } from 'react'
import { PiSpinner } from 'react-icons/pi'

export type ContextUsage = {
  percentage: number
  usedTokens: number
  limitTokens: number
}

// Compacting the open chat on request, which the indicator's popover offers.
export type ChatCompaction = {
  canCompact: boolean
  compacting: boolean
  onCompact: () => void
}

// Usage percentage at which the indicator switches to the warning color
const WARNING_THRESHOLD_PERCENT = 80

// The session feature of a harness that summarizes a chat's earlier messages
// when its prompt outgrows the budget.
const COMPACTION_FEATURE = 'compaction'
const COMPACTION_NOTE = 'Earlier messages will be summarized to make room.'
const COMPACT_EXPLANATION =
  'Compacting summarizes earlier messages so the chat uses less of the context window. The latest exchange is kept as it is.'
// The session feature of a harness that summarizes the latest exchange too
// when the user compacts a chat.
const COMPACT_LATEST_FEATURE = 'compactLatest'
const COMPACT_LATEST_EXPLANATION =
  'Compacting summarizes the conversation so far, including the latest exchange, so the chat uses less of the context window.'
const NOTHING_TO_COMPACT_NOTE = 'Nothing to compact right now.'
export const COMPACT_LABEL = 'Compact chat'
export const COMPACTING_LABEL = 'Compacting…'

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
 * Given a compaction, the gauge opens a popover that compacts the chat on
 * request.
 */
export function ContextUsageIndicator({
  usage,
  className,
  compaction,
}: {
  usage: ContextUsage
  className?: string
  compaction?: ChatCompaction
}) {
  const compacts = useSessionFeature(COMPACTION_FEATURE)
  const compactsLatest = useSessionFeature(COMPACT_LATEST_FEATURE)
  const [isOpen, setIsOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const percentage = Math.min(Math.round(usage.percentage), 100)

  const isNearLimit = percentage >= WARNING_THRESHOLD_PERCENT
  const isFull = usage.usedTokens >= usage.limitTokens
  const isOverBudget = usage.usedTokens > usage.limitTokens
  const dashOffset = RING_CIRCUMFERENCE * (1 - percentage / 100)

  // What happens to a prompt over the budget, or one that fills it.
  const note = isOverBudget
    ? compacts
      ? COMPACTION_NOTE
      : 'Replies may fail. Reduce project documents or instructions, remove attachments, or shorten your message.'
    : isFull
      ? compacts
        ? COMPACTION_NOTE
        : 'Older messages may be omitted to make room.'
      : undefined
  const tooltip = isOverBudget
    ? `Context exceeds this model's input budget (~${formatTokens(usage.usedTokens)} of ${formatTokens(usage.limitTokens)} tokens). ${note}`
    : isFull
      ? `Context window full (~${formatTokens(usage.limitTokens)} tokens). ${note}`
      : `Context window ${percentage}% used (~${formatTokens(usage.usedTokens)} of ${formatTokens(usage.limitTokens)} tokens)`
  // The popover's title, with the tokens used on a line of their own.
  const headline = isOverBudget
    ? "Context exceeds this model's input budget"
    : isFull
      ? 'Context window full'
      : `Context window ${percentage}% used`
  const tokensUsed = `~${formatTokens(usage.usedTokens)} out of ${formatTokens(usage.limitTokens)} tokens`

  const compacting = !!compaction?.compacting

  // Focus moves into the popover as it opens, so Escape closes it: onto its
  // button, or the popover itself while the button is disabled.
  useEffect(() => {
    if (!isOpen) return
    const popover = popoverRef.current
    ;(
      popover?.querySelector<HTMLButtonElement>('button:not(:disabled)') ??
      popover
    )?.focus()
  }, [isOpen])

  const close = (restoreFocus: boolean) => {
    setIsOpen(false)
    if (restoreFocus) triggerRef.current?.focus()
  }

  const gauge = (
    <>
      <svg
        className={cn('h-4 w-4 -rotate-90', compacting && 'animate-pulse')}
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
        {compacting
          ? COMPACTING_LABEL
          : isOverBudget
            ? 'Over limit'
            : `${percentage}%`}
      </span>
    </>
  )
  const gaugeClassName = cn(
    'flex h-7 items-center gap-1 rounded-lg px-1.5',
    isNearLimit ? 'text-amber-500' : 'text-content-secondary',
  )

  return (
    <div className={cn('group relative flex items-center', className)}>
      {compaction ? (
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setIsOpen(!isOpen)}
          aria-label={compacting ? `${COMPACTING_LABEL} ${tooltip}` : tooltip}
          aria-haspopup="dialog"
          aria-expanded={isOpen}
          className={cn(
            gaugeClassName,
            'transition-colors hover:bg-surface-chat-background',
          )}
        >
          {gauge}
        </button>
      ) : (
        <span role="img" aria-label={tooltip} className={gaugeClassName}>
          {gauge}
        </span>
      )}
      {!isOpen && (
        <span className="pointer-events-none absolute bottom-full right-0 z-20 mb-1 w-max max-w-xs whitespace-normal text-balance rounded border border-border-subtle bg-surface-chat-background px-2 py-1 text-center text-xs text-content-primary opacity-0 shadow-sm transition-opacity group-hover:opacity-100">
          {tooltip}
        </span>
      )}
      {compaction && isOpen && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => close(true)} />
          <div
            ref={popoverRef}
            role="dialog"
            aria-label="Context window"
            tabIndex={-1}
            onKeyDown={(e) => {
              if (e.key !== 'Escape') return
              e.preventDefault()
              e.stopPropagation()
              close(true)
            }}
            className="absolute bottom-full right-0 z-20 mb-2 w-72 rounded-xl border border-border-subtle bg-surface-chat p-3 text-left shadow-lg outline-none"
          >
            <p className="text-sm font-medium text-content-primary">
              {headline}
            </p>
            <p className="mt-0.5 text-xs text-content-secondary">
              {tokensUsed}
            </p>
            {note && (
              <p className="mt-2 text-xs text-content-secondary">{note}</p>
            )}
            <p className="mt-2 text-xs text-content-secondary">
              {compactsLatest
                ? COMPACT_LATEST_EXPLANATION
                : COMPACT_EXPLANATION}
            </p>
            <button
              type="button"
              disabled={!compaction.canCompact}
              onClick={() => {
                compaction.onCompact()
                close(true)
              }}
              className="mt-3 flex h-8 w-full items-center justify-center gap-2 rounded-lg border border-border-subtle bg-surface-chat-background text-sm font-medium text-content-primary transition-colors hover:bg-surface-chat disabled:cursor-default disabled:opacity-50 disabled:hover:bg-surface-chat-background"
            >
              {compacting && (
                <PiSpinner
                  className="h-4 w-4 animate-spin"
                  aria-hidden="true"
                />
              )}
              {compacting ? COMPACTING_LABEL : COMPACT_LABEL}
            </button>
            {!compaction.canCompact && !compacting && (
              <p className="mt-2 text-xs text-content-muted">
                {NOTHING_TO_COMPACT_NOTE}
              </p>
            )}
          </div>
        </>
      )}
    </div>
  )
}
