import {
  RateLimitBanner,
  shouldShowRateLimitBanner,
} from '@/components/chat/rate-limit-banner'
import { useRateLimit } from '@/hooks/use-rate-limit'
import {
  refreshRateLimit,
  resetTinfoilClient,
} from '@/services/inference/tinfoil-client'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/config', () => ({
  API_BASE_URL: 'https://api.example.com',
  IS_DEV: false,
}))
vi.mock('@/services/auth', () => ({
  authTokenManager: {
    isInitialized: () => true,
    getValidToken: async () => 'account-a',
  },
}))
vi.mock('@/utils/error-handling', () => ({ logError: vi.fn() }))

const NOW = Date.parse('2026-09-26T10:58:00Z')
const RESET_AT = '2026-09-26T11:00:00Z'

function LiveBanner() {
  const rateLimit = useRateLimit()
  return shouldShowRateLimitBanner(rateLimit) ? (
    <RateLimitBanner rateLimit={rateLimit} isDarkMode={false} />
  ) : null
}

describe('hourly limit recheck', () => {
  const fetchMock = vi.fn<typeof fetch>()

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    resetTinfoilClient()
    fetchMock.mockReset().mockResolvedValueOnce(
      Response.json(
        {
          code: 'HOURLY_LIMIT_REACHED',
          resets_at: RESET_AT,
        },
        { status: 429 },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    resetTinfoilClient()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('rechecks early, disables duplicate clicks, and removes the banner when access returns', async () => {
    await refreshRateLimit()
    render(<LiveBanner />)
    let resolveResponse!: (response: Response) => void
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveResponse = resolve
        }),
    )

    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    expect(screen.getByRole('button', { name: 'Checking…' })).toBeDisabled()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(Date.now()).toBe(NOW)
    await act(async () => {
      resolveResponse(
        Response.json({
          key: 'subscriber-token',
          expires_at: RESET_AT,
          rate_limit: {},
        }),
      )
    })

    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(Date.parse(RESET_AT) - NOW)
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('keeps the limit visible and re-enables the action after a failed recheck', async () => {
    await refreshRateLimit()
    render(<LiveBanner />)
    fetchMock.mockResolvedValueOnce(Response.json({}, { status: 503 }))

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    })

    expect(screen.getByRole('status')).toHaveTextContent('hourly usage limit')
    expect(screen.getByRole('button', { name: 'Check again' })).toBeEnabled()
    await refreshRateLimit()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not offer an hourly recheck for a free daily quota', () => {
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
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
})
