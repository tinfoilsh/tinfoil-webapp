'use client'

import { cn } from '@/components/ui/utils'
import type { RateLimitInfo } from '@/services/inference/tinfoil-client'
import { useTranslation } from 'react-i18next'

const RATE_LIMIT_WARNING_THRESHOLD = 3

interface RateLimitBannerProps {
  rateLimit: RateLimitInfo
  isDarkMode: boolean
  /** Tailwind classes applied to the outer wrapper (positioning, visibility). */
  className?: string
  /** Tailwind classes applied to the inner pill (e.g. corner radius). */
  pillClassName?: string
}

export function shouldShowRateLimitBanner(
  rateLimit: RateLimitInfo | null,
): rateLimit is RateLimitInfo {
  return (
    rateLimit !== null && rateLimit.remaining <= RATE_LIMIT_WARNING_THRESHOLD
  )
}

function formatResetTime(resetsAt: string): string | null {
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
}: RateLimitBannerProps) {
  const { t } = useTranslation('chat')
  const exhausted = rateLimit.remaining <= 0
  const isHourly = rateLimit.kind === 'hourly'
  const resetLabel = formatResetTime(rateLimit.resetsAt)

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
              ? t('rateLimit.exhausted')
              : t('rateLimit.remaining', { count: rateLimit.remaining })}
        </span>
      </div>
    </div>
  )
}
