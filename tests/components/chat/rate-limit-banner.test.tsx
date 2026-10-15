import {
  RateLimitBanner,
  shouldShowRateLimitBanner,
} from '@/components/chat/rate-limit-banner'
import type { RateLimit } from '@/services/harness/types'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

const RESET_AT = '2026-09-26T11:00:00Z'

describe('shouldShowRateLimitBanner', () => {
  it.each([
    { name: 'no quota', rateLimit: null, visible: false },
    {
      name: 'an unmetered account',
      rateLimit: { kind: null, maxRequests: 0, remaining: 0 },
      visible: false,
    },
    {
      name: 'a quota above the warning threshold',
      rateLimit: { kind: 'free_daily', maxRequests: 10, remaining: 4 },
      visible: false,
    },
    {
      name: 'a quota at the warning threshold',
      rateLimit: { kind: 'free_daily', maxRequests: 10, remaining: 3 },
      visible: true,
    },
  ])('returns $visible for $name', ({ rateLimit, visible }) => {
    expect(shouldShowRateLimitBanner(rateLimit as RateLimit | null)).toBe(
      visible,
    )
  })
})

describe('RateLimitBanner', () => {
  it('counts down the remaining free requests politely', () => {
    render(
      <RateLimitBanner
        rateLimit={{ kind: 'free_daily', maxRequests: 10, remaining: 1 }}
        isDarkMode={false}
      />,
    )
    const status = screen.getByRole('status')
    expect(status).toHaveTextContent('You have 1 free request left today')
    expect(status).toHaveAttribute('aria-live', 'polite')
  })

  it('announces an exhausted free daily quota without an hourly recheck', () => {
    render(
      <RateLimitBanner
        rateLimit={{
          maxRequests: 3,
          remaining: 0,
          resetsAt: RESET_AT,
          kind: 'free_daily',
        }}
        isDarkMode={false}
      />,
    )
    const status = screen.getByRole('status')
    expect(status).toHaveTextContent("You've reached your daily rate limit.")
    expect(status).toHaveAttribute('aria-live', 'assertive')
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it.each([
    {
      resetsAt: RESET_AT,
      text: /^You've reached your hourly usage limit — resets at \d{1,2}:\d{2}/,
    },
    {
      resetsAt: 'not-a-date',
      text: /^You've reached your hourly usage limit$/,
    },
  ])(
    'shows when an hourly limit resets only for a valid time: $resetsAt',
    ({ resetsAt, text }) => {
      render(
        <RateLimitBanner
          rateLimit={{
            maxRequests: 50,
            remaining: 0,
            resetsAt,
            kind: 'hourly',
          }}
          isDarkMode={false}
        />,
      )
      expect(screen.getByRole('status')).toHaveTextContent(text)
    },
  )
})
