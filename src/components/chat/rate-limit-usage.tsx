'use client'

import { Progress } from '@/components/ui/progress'
import { cn } from '@/components/ui/utils'
import { useRateLimit } from '@/hooks/use-rate-limit'
import type {
  RateLimitInfo,
  TokenBudget,
} from '@/services/inference/tinfoil-client'
import { useEffect, useState } from 'react'

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

interface UsageBarProps {
  label: string
  budget: TokenBudget
}

function UsageBar({ label, budget }: UsageBarProps) {
  const percent = usagePercent(budget)
  const exhausted = budget.remaining <= 0
  const nearLimit = percent >= USAGE_WARNING_FRACTION * PERCENT_MAX

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
        value={percent}
        aria-label={`${label} token usage`}
        className={cn(
          'h-1.5 bg-border-subtle',
          exhausted
            ? '[&>div]:bg-destructive'
            : nearLimit
              ? '[&>div]:bg-amber-500'
              : '[&>div]:bg-content-muted',
        )}
      />
    </div>
  )
}

export function RateLimitUsage() {
  const rateLimit = useRateLimit()
  const countdown = useResetCountdown(rateLimit?.resetsAt ?? '')

  if (!hasTokenUsage(rateLimit)) return null

  const title = rateLimit.kind === 'hourly' ? 'Hourly usage' : 'Daily usage'

  return (
    <div className="relative z-10 flex-none px-2 pt-2">
      <div className="rounded-lg border border-border-subtle bg-surface-chat p-3">
        <div className="mb-2.5 flex items-center justify-between">
          <span className="font-aeonik text-xs font-medium text-content-primary">
            {title}
          </span>
          {countdown && (
            <span className="text-[11px] text-content-muted">
              Resets in {countdown}
            </span>
          )}
        </div>
        <div className="space-y-2">
          {rateLimit.inputTokens && (
            <UsageBar label="Input" budget={rateLimit.inputTokens} />
          )}
          {rateLimit.outputTokens && (
            <UsageBar label="Output" budget={rateLimit.outputTokens} />
          )}
        </div>
      </div>
    </div>
  )
}
