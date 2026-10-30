'use client'

import { cn } from '@/components/ui/utils'
import { DAILY_RATE_LIMIT_MESSAGE } from '@/constants/rate-limits'
import type { RateLimit as RateLimitInfo } from '@/services/harness/types'
import { logError } from '@/utils/error-handling'
import { useState } from 'react'

const RATE_LIMIT_WARNING_THRESHOLD = 3

interface RateLimitBannerProps {
  rateLimit: RateLimitInfo & { remaining: number }
  isDarkMode: boolean
  /** Tailwind classes applied to the outer wrapper (positioning, visibility). */
  className?: string
  /** Tailwind classes applied to the inner pill (e.g. corner radius). */
  pillClassName?: string
  /** Reads the quota again, as a capped subscriber's may lift early. */
  onCheckAgain?: () => Promise<unknown>
}

// A subscriber has no request quota until the hourly cap refuses requests.
export function shouldShowRateLimitBanner(
  rateLimit: RateLimitInfo | null,
): rateLimit is RateLimitInfo & { remaining: number } {
  return (
    rateLimit !== null &&
    rateLimit.kind !== null &&
    typeof rateLimit.remaining === 'number' &&
    rateLimit.remaining <= RATE_LIMIT_WARNING_THRESHOLD
  )
}

function formatResetTime(resetsAt?: string): string | null {
  if (!resetsAt) return null
  const at = new Date(resetsAt)
  if (Number.isNaN(at.getTime())) return null
  return at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

export function RateLimitBanner({
  rateLimit,
  isDarkMode,
  className,
  pillClassName,
  onCheckAgain,
}: RateLimitBannerProps) {
  const [isChecking, setIsChecking] = useState(false)
  const exhausted = rateLimit.remaining <= 0
  const isHourly = rateLimit.kind === 'hourly'
  const resetLabel = formatResetTime(rateLimit.resetsAt)

  const checkAgain = async () => {
    if (!onCheckAgain) return
    setIsChecking(true)
    try {
      await onCheckAgain()
    } catch (error) {
      // The limit stays shown until a check reads that it lifted.
      logError('Failed to check the usage limit again', error, {
        component: 'RateLimitBanner',
        action: 'checkAgain',
      })
    } finally {
      setIsChecking(false)
    }
  }

  return (
    <div
      className={cn(
        'pointer-events-none relative z-10 flex w-full flex-none justify-center px-3',
        className,
      )}
    >
      <div
        role="status"
        aria-live={exhausted ? 'assertive' : 'polite'}
        className={cn(
          'pointer-events-auto flex items-center gap-2 rounded-b-xl border-x border-b px-4 py-1.5 transition-colors',
          isDarkMode
            ? 'border-amber-500/30 bg-amber-950/20 text-amber-400'
            : 'border-amber-300 bg-amber-50 text-amber-600',
          pillClassName,
        )}
      >
        <span className="font-aeonik text-xs font-medium">
          {isHourly
            ? `You've reached your hourly usage limit${resetLabel ? ` — resets at ${resetLabel}` : ''}`
            : exhausted
              ? DAILY_RATE_LIMIT_MESSAGE
              : `You have ${rateLimit.remaining} free request${rateLimit.remaining === 1 ? '' : 's'} left today`}
        </span>
        {isHourly && onCheckAgain && (
          <button
            type="button"
            onClick={checkAgain}
            disabled={isChecking}
            className="shrink-0 font-aeonik text-xs underline underline-offset-2 disabled:opacity-50"
          >
            {isChecking ? 'Checking…' : 'Check again'}
          </button>
        )}
      </div>
    </div>
  )
}
