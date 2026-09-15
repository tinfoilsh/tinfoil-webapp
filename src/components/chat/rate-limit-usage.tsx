'use client'

import { Progress } from '@/components/ui/progress'
import { cn } from '@/components/ui/utils'
import { UI_SIDEBAR_USAGE_EXPANDED } from '@/constants/storage-keys'
import { useRateLimit } from '@/hooks/use-rate-limit'
import type {
  RateLimitInfo,
  TokenBudget,
} from '@/services/inference/tinfoil-client'
import { ChevronDownIcon, ChevronRightIcon } from '@heroicons/react/24/outline'
import { AnimatePresence, motion } from 'framer-motion'
import { useEffect, useState } from 'react'
import { CONSTANTS } from './constants'

const USAGE_PANEL_ID = 'sidebar-usage-panel'
const COUNTDOWN_TICK_MS = 60 * 1000
const MS_PER_MINUTE = 60 * 1000
const MINUTES_PER_HOUR = 60
const PERCENT_MAX = 100
/** Usage fraction at which the bar switches from neutral to warning color. */
const USAGE_WARNING_FRACTION = 0.8

const compactNumber = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 1,
})

export function formatTokenCount(count: number): string {
  return compactNumber.format(Math.max(0, count))
}

/**
 * Human-readable countdown to the reset instant, rounded up to whole
 * minutes. Returns null when the timestamp is missing, unparseable, or
 * already past so the caller can fall back to a neutral label.
 */
export function formatResetCountdown(
  resetsAt: string,
  now: number = Date.now(),
): string | null {
  if (!resetsAt) return null
  const at = new Date(resetsAt).getTime()
  if (Number.isNaN(at)) return null
  const remainingMs = at - now
  if (remainingMs <= 0) return null
  const totalMinutes = Math.ceil(remainingMs / MS_PER_MINUTE)
  const hours = Math.floor(totalMinutes / MINUTES_PER_HOUR)
  const minutes = totalMinutes % MINUTES_PER_HOUR
  if (hours === 0) return `${minutes}m`
  if (minutes === 0) return `${hours}h`
  return `${hours}h ${minutes}m`
}

export function usagePercent(budget: TokenBudget): number {
  if (budget.max <= 0) return 0
  return Math.min(PERCENT_MAX, (budget.used / budget.max) * PERCENT_MAX)
}

/** Whether the indicator has anything to show for this rate limit. */
export function hasTokenUsage(
  rateLimit: RateLimitInfo | null,
): rateLimit is RateLimitInfo {
  return (
    rateLimit !== null &&
    (rateLimit.inputTokens !== undefined ||
      rateLimit.outputTokens !== undefined)
  )
}

/**
 * Re-renders on each whole-minute boundary before the reset instant so the
 * displayed minute count is never stale, then stops once the reset passes.
 */
function useResetCountdown(resetsAt: string): string | null {
  const [, setTick] = useState(0)

  useEffect(() => {
    const at = new Date(resetsAt).getTime()
    if (Number.isNaN(at)) return

    let timeout: ReturnType<typeof setTimeout> | null = null
    const scheduleNextTick = () => {
      const remainingMs = at - Date.now()
      if (remainingMs <= 0) return
      const untilBoundary = remainingMs % COUNTDOWN_TICK_MS || COUNTDOWN_TICK_MS
      timeout = setTimeout(() => {
        setTick((t) => t + 1)
        scheduleNextTick()
      }, untilBoundary)
    }
    scheduleNextTick()

    return () => {
      if (timeout !== null) clearTimeout(timeout)
    }
  }, [resetsAt])

  return formatResetCountdown(resetsAt)
}

function usageBarClassName(budget: TokenBudget): string {
  const exhausted = budget.remaining <= 0
  const nearLimit = usagePercent(budget) >= USAGE_WARNING_FRACTION * PERCENT_MAX
  return cn(
    'bg-border-subtle',
    exhausted
      ? '[&>div]:bg-destructive'
      : nearLimit
        ? '[&>div]:bg-amber-500'
        : '[&>div]:bg-content-muted',
  )
}

/**
 * The dimension closest to its cap. Drives the collapsed summary bar so the
 * at-a-glance view always reflects whichever budget will run out first.
 */
export function mostConstrainedBudget(
  rateLimit: RateLimitInfo,
): TokenBudget | undefined {
  const { inputTokens, outputTokens } = rateLimit
  if (!inputTokens) return outputTokens
  if (!outputTokens) return inputTokens
  return usagePercent(outputTokens) > usagePercent(inputTokens)
    ? outputTokens
    : inputTokens
}

interface UsageBarProps {
  label: string
  budget: TokenBudget
}

function UsageBar({ label, budget }: UsageBarProps) {
  const exhausted = budget.remaining <= 0

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[11px] leading-none">
        <span className="text-content-secondary">{label}</span>
        <span
          className={cn(
            'tabular-nums',
            exhausted ? 'text-destructive' : 'text-content-muted',
          )}
        >
          {formatTokenCount(budget.used)} / {formatTokenCount(budget.max)}
        </span>
      </div>
      <Progress
        value={usagePercent(budget)}
        aria-label={`${label} token usage`}
        className={cn('h-1.5', usageBarClassName(budget))}
      />
    </div>
  )
}

function readExpandedPreference(): boolean {
  if (typeof window === 'undefined') return false
  return localStorage.getItem(UI_SIDEBAR_USAGE_EXPANDED) === 'true'
}

export function RateLimitUsage() {
  const rateLimit = useRateLimit()
  const countdown = useResetCountdown(rateLimit?.resetsAt ?? '')
  const [isExpanded, setIsExpanded] = useState(readExpandedPreference)

  if (!hasTokenUsage(rateLimit)) return null

  const title = rateLimit.kind === 'hourly' ? 'Hourly usage' : 'Daily usage'
  const summary = mostConstrainedBudget(rateLimit)

  const toggleExpanded = () => {
    const next = !isExpanded
    setIsExpanded(next)
    localStorage.setItem(UI_SIDEBAR_USAGE_EXPANDED, next ? 'true' : 'false')
  }

  return (
    <div className="relative z-10 flex-none px-2 py-2">
      <div className="rounded-lg border border-border-subtle bg-surface-chat">
        <button
          type="button"
          aria-expanded={isExpanded}
          aria-controls={USAGE_PANEL_ID}
          onClick={toggleExpanded}
          className="flex w-full flex-col gap-2 rounded-lg p-3 text-left transition-colors hover:bg-surface-chat/80"
        >
          <span className="flex w-full items-center justify-between">
            <span className="font-aeonik text-xs font-medium text-content-primary">
              {title}
            </span>
            <span className="flex items-center gap-1.5">
              {countdown && (
                <span className="text-[11px] text-content-muted">
                  Resets in {countdown}
                </span>
              )}
              {isExpanded ? (
                <ChevronDownIcon className="h-3.5 w-3.5 text-content-muted" />
              ) : (
                <ChevronRightIcon className="h-3.5 w-3.5 text-content-muted" />
              )}
            </span>
          </span>
          {!isExpanded && summary && (
            <Progress
              value={usagePercent(summary)}
              aria-label={`${title} summary`}
              className={cn('h-1', usageBarClassName(summary))}
            />
          )}
        </button>
        <AnimatePresence initial={false}>
          {isExpanded && (
            <motion.div
              id={USAGE_PANEL_ID}
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{
                duration: CONSTANTS.SIDEBAR_SECTION_ANIMATION_S,
                ease: 'easeInOut',
              }}
              className="overflow-hidden"
            >
              <div className="space-y-2 px-3 pb-3">
                {rateLimit.inputTokens && (
                  <UsageBar label="Input" budget={rateLimit.inputTokens} />
                )}
                {rateLimit.outputTokens && (
                  <UsageBar label="Output" budget={rateLimit.outputTokens} />
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}
