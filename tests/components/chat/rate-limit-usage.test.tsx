import {
  RateLimitUsage,
  formatResetCountdown,
  formatTokenCount,
} from '@/components/chat/rate-limit-usage'
import { UI_SIDEBAR_USAGE_EXPANDED } from '@/constants/storage-keys'
import {
  refreshRateLimit,
  resetTinfoilClient,
} from '@/services/inference/tinfoil-client'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/config', () => ({
  API_BASE_URL: 'https://api.example.com',
  DEV_API_KEY: '',
  IS_DEV: false,
}))

vi.mock('@/services/auth', () => ({
  authTokenManager: {
    isInitialized: () => false,
    waitForInit: vi.fn(),
    getValidToken: vi.fn(),
  },
}))

vi.mock('@/utils/error-handling', () => ({
  logError: vi.fn(),
}))

const NOW = new Date('2026-07-24T10:15:30Z')

function freeTierResponse(rateLimit: Record<string, unknown>) {
  return new Response(
    JSON.stringify({
      key: 'free-key',
      expires_at: '2026-07-25T00:00:00Z',
      is_free_tier: true,
      rate_limit: rateLimit,
    }),
    { status: 200 },
  )
}

describe('formatResetCountdown', () => {
  const now = NOW.getTime()

  it('shows only minutes under an hour and rounds up partial minutes', () => {
    expect(formatResetCountdown('2026-07-24T10:27:00Z', now)).toBe('12m')
  })

  it('shows hours and minutes past an hour', () => {
    expect(formatResetCountdown('2026-07-24T14:27:00Z', now)).toBe('4h 12m')
  })

  it('omits the minute part on an exact hour boundary', () => {
    expect(formatResetCountdown('2026-07-24T12:15:30Z', now)).toBe('2h')
  })

  it('returns null for past, empty, or invalid timestamps', () => {
    expect(formatResetCountdown('2026-07-24T10:15:30Z', now)).toBeNull()
    expect(formatResetCountdown('2026-07-24T09:00:00Z', now)).toBeNull()
    expect(formatResetCountdown('', now)).toBeNull()
    expect(formatResetCountdown('not-a-date', now)).toBeNull()
  })
})

describe('formatTokenCount', () => {
  it('compacts large counts', () => {
    expect(formatTokenCount(750_000)).toBe('750K')
    expect(formatTokenCount(2_000_000)).toBe('2M')
    expect(formatTokenCount(1_250_000)).toBe('1.3M')
    expect(formatTokenCount(0)).toBe('0')
  })
})

describe('RateLimitUsage', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    resetTinfoilClient()
    localStorage.clear()
    sessionStorage.clear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('renders nothing until token budgets are known', () => {
    const { container } = render(<RateLimitUsage isPremium />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders input and output bars with a reset countdown from the live store', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        freeTierResponse({
          max_requests: 7,
          remaining: 5,
          max_input_tokens: 2_000_000,
          input_tokens_used: 500_000,
          input_tokens_remaining: 1_500_000,
          max_output_tokens: 100_000,
          output_tokens_used: 90_000,
          output_tokens_remaining: 10_000,
          resets_at: '2026-07-25T00:00:00Z',
        }),
      ),
    )
    render(<RateLimitUsage isPremium />)

    await act(async () => {
      await refreshRateLimit()
    })

    expect(screen.getByText('Daily usage')).toBeInTheDocument()
    expect(screen.getByText('Resets in 13h 45m')).toBeInTheDocument()

    // Collapsed by default: a single summary bar tracks the more constrained
    // dimension (output at 90%) and the per-dimension detail is hidden.
    const toggle = screen.getByRole('button', { name: /Daily usage/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(
      screen.getByRole('progressbar', { name: 'Daily usage summary' }),
    ).toHaveAttribute('aria-valuenow', '90')
    expect(screen.queryByText('500K / 2M')).not.toBeInTheDocument()

    fireEvent.click(toggle)

    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(sessionStorage.getItem(UI_SIDEBAR_USAGE_EXPANDED)).toBe('true')
    expect(screen.getByText('500K / 2M')).toBeInTheDocument()
    expect(screen.getByText('90K / 100K')).toBeInTheDocument()
    expect(
      screen.queryByRole('progressbar', { name: 'Daily usage summary' }),
    ).not.toBeInTheDocument()

    const input = screen.getByRole('progressbar', { name: 'Input token usage' })
    expect(input).toHaveAttribute('aria-valuenow', '25')
    const output = screen.getByRole('progressbar', {
      name: 'Output token usage',
    })
    expect(output).toHaveAttribute('aria-valuenow', '90')

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(sessionStorage.getItem(UI_SIDEBAR_USAGE_EXPANDED)).toBe('false')
  })

  it('restores the expanded preference on mount', async () => {
    sessionStorage.setItem(UI_SIDEBAR_USAGE_EXPANDED, 'true')
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        freeTierResponse({
          max_requests: 7,
          remaining: 5,
          max_input_tokens: 1_000,
          input_tokens_used: 10,
          input_tokens_remaining: 990,
          max_output_tokens: 1_000,
          output_tokens_used: 10,
          output_tokens_remaining: 990,
          resets_at: '2026-07-25T00:00:00Z',
        }),
      ),
    )
    render(<RateLimitUsage isPremium />)
    await act(async () => {
      await refreshRateLimit()
    })

    expect(screen.getByRole('button', { name: /Daily usage/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    expect(screen.getByText('Input')).toBeInTheDocument()
    expect(screen.getByText('Output')).toBeInTheDocument()
  })

  it('advances the countdown as time passes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        freeTierResponse({
          max_requests: 7,
          remaining: 5,
          max_input_tokens: 1_000,
          input_tokens_used: 10,
          input_tokens_remaining: 990,
          max_output_tokens: 1_000,
          output_tokens_used: 10,
          output_tokens_remaining: 990,
          resets_at: '2026-07-24T10:20:00Z',
        }),
      ),
    )
    render(<RateLimitUsage isPremium />)
    await act(async () => {
      await refreshRateLimit()
    })
    expect(screen.getByText('Resets in 5m')).toBeInTheDocument()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(31 * 1000)
    })
    expect(screen.getByText('Resets in 4m')).toBeInTheDocument()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4 * 60 * 1000)
    })
    expect(screen.queryByText(/Resets in/)).not.toBeInTheDocument()
  })

  it('hides known token budgets without a confirmed subscription and after it ends', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        freeTierResponse({
          max_requests: 7,
          remaining: 3,
          max_input_tokens: 2_000_000,
          input_tokens_used: 0,
          input_tokens_remaining: 2_000_000,
          max_output_tokens: 100_000,
          output_tokens_used: 0,
          output_tokens_remaining: 100_000,
          resets_at: '2026-07-25T00:00:00Z',
        }),
      ),
    )
    sessionStorage.setItem(UI_SIDEBAR_USAGE_EXPANDED, 'true')
    const { container, rerender } = render(<RateLimitUsage isPremium={false} />)

    await act(async () => {
      await refreshRateLimit()
    })

    expect(container).toBeEmptyDOMElement()

    rerender(<RateLimitUsage isPremium />)
    expect(screen.getByText('Daily usage')).toBeInTheDocument()
    expect(screen.getByText('0 / 2M')).toBeInTheDocument()

    rerender(<RateLimitUsage isPremium={false} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('labels the subscriber hourly budget and flags an exhausted dimension', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: 'You have reached your hourly usage limit.',
            code: 'HOURLY_LIMIT_REACHED',
            resets_at: '2026-07-24T11:00:00Z',
            rate_limit: {
              max_input_tokens: 20_000_000,
              input_tokens_used: 3_000_000,
              input_tokens_remaining: 17_000_000,
              max_output_tokens: 1_000_000,
              output_tokens_used: 1_000_000,
              output_tokens_remaining: 0,
              resets_at: '2026-07-24T11:00:00Z',
            },
          }),
          { status: 429 },
        ),
      ),
    )
    render(<RateLimitUsage isPremium />)
    await act(async () => {
      await refreshRateLimit()
    })

    expect(screen.getByText('Hourly usage')).toBeInTheDocument()
    expect(screen.getByText('Resets in 45m')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Hourly usage/ }))
    expect(screen.getByText('1M / 1M')).toHaveClass('text-destructive')
    expect(
      screen.getByRole('progressbar', { name: 'Output token usage' }),
    ).toHaveAttribute('aria-valuenow', '100')
  })
})
