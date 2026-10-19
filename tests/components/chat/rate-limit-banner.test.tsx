import {
  RateLimitBanner,
  shouldShowRateLimitBanner,
} from '@/components/chat/rate-limit-banner'
import { useRateLimit } from '@/hooks/use-rate-limit'
import { harnessAPI } from '@/services/harness/runtime'
import type { RateLimit } from '@/services/harness/types'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { testSession } from '../../harness-fixture'

vi.mock('@/utils/error-handling', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarning: vi.fn(),
}))

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

describe('hourly limit recheck', () => {
  const capped: RateLimit = {
    kind: 'hourly',
    maxRequests: 0,
    remaining: 0,
    resetsAt: RESET_AT,
    inputTokens: { max: 1_000, used: 1_000, remaining: 0 },
  }
  const session = vi.fn<() => Promise<unknown>>()

  function LiveBanner() {
    const rateLimit = useRateLimit()
    return shouldShowRateLimitBanner(rateLimit) ? (
      <RateLimitBanner
        rateLimit={rateLimit}
        isDarkMode={false}
        onCheckAgain={() => harnessAPI().refresh()}
      />
    ) : null
  }

  beforeEach(async () => {
    session
      .mockReset()
      .mockResolvedValueOnce({
        ...structuredClone(testSession),
        rateLimit: capped,
      })
    vi.mocked(harnessAPI().client.post).mockImplementation(async (path) =>
      path === '/v1/session' ? session() : {},
    )
    await act(async () => {
      await harnessAPI().refresh()
    })
  })

  it('rechecks the session, disables duplicate clicks, and removes the banner when access returns', async () => {
    render(<LiveBanner />)
    expect(screen.getByRole('status')).toHaveTextContent('hourly usage limit')
    let respond!: (value: unknown) => void
    session.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          respond = resolve
        }),
    )

    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    expect(screen.getByRole('button', { name: 'Checking…' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Checking…' }))
    expect(session).toHaveBeenCalledTimes(2)

    await act(async () =>
      respond({
        ...structuredClone(testSession),
        rateLimit: {
          kind: 'hourly',
          resetsAt: RESET_AT,
          inputTokens: { max: 1_000, used: 1_000, remaining: 0 },
        },
      }),
    )
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('keeps the limit visible and re-enables the action after a failed recheck', async () => {
    render(<LiveBanner />)
    session.mockRejectedValueOnce(new Error('offline'))

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    })

    expect(screen.getByRole('status')).toHaveTextContent('hourly usage limit')
    expect(screen.getByRole('button', { name: 'Check again' })).toBeEnabled()
  })
})
