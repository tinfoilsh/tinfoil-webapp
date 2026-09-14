import {
  getRateLimitInfo,
  invalidateSessionCache,
  refreshRateLimit,
  resetTinfoilClient,
} from '@/services/inference/tinfoil-client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/config', () => ({
  API_BASE_URL: 'https://api.example.com',
  DEV_API_KEY: '',
  IS_DEV: false,
}))

const authTokenManagerMock = vi.hoisted(() => ({
  isInitialized: vi.fn(() => false),
  waitForInit: vi.fn(),
  getValidToken: vi.fn<() => Promise<string>>(),
}))

vi.mock('@/services/auth', () => ({
  authTokenManager: authTokenManagerMock,
}))

vi.mock('@/utils/error-handling', () => ({
  logError: vi.fn(),
}))

const chatKeyResponse = (key: string, remaining: number) =>
  new Response(
    JSON.stringify({
      key,
      is_free_tier: true,
      rate_limit: {
        max_requests: 7,
        remaining,
        max_input_tokens: 2_000_000,
        input_tokens_used: 750_000,
        input_tokens_remaining: 1_250_000,
        max_output_tokens: 100_000,
        output_tokens_used: 20_000,
        output_tokens_remaining: 80_000,
        resets_at: '2026-07-24T00:00:00Z',
      },
    }),
    { status: 200 },
  )

describe('tinfoil-client session cache', () => {
  beforeEach(() => {
    resetTinfoilClient()
    localStorage.clear()
    authTokenManagerMock.isInitialized.mockReturnValue(false)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('surfaces the hourly token budget for subscribers', async () => {
    authTokenManagerMock.isInitialized.mockReturnValue(true)
    authTokenManagerMock.getValidToken.mockResolvedValue('clerk-jwt')
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          key: 'chat-jwt',
          expires_at: '2026-07-24T00:15:00Z',
          is_free_tier: false,
          rate_limit: {
            max_input_tokens: 20_000_000,
            input_tokens_used: 1_500,
            input_tokens_remaining: 19_998_500,
            max_output_tokens: 1_000_000,
            output_tokens_used: 250,
            output_tokens_remaining: 999_750,
            resets_at: '2026-07-24T01:00:00Z',
          },
        }),
        { status: 200 },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    await refreshRateLimit()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/chat/token')
    const limit = getRateLimitInfo()
    expect(limit).toMatchObject({
      kind: 'hourly',
      resetsAt: '2026-07-24T01:00:00Z',
      inputTokens: { max: 20_000_000, used: 1_500, remaining: 19_998_500 },
      outputTokens: { max: 1_000_000, used: 250, remaining: 999_750 },
    })
    // Subscribers have no request quota, so the hourly info must never gate
    // sending the way an exhausted free-tier count does.
    expect(limit!.remaining).toBeGreaterThan(0)
  })

  it('does not restore stale rate limits after invalidation', async () => {
    let resolveStaleResponse: (response: Response) => void = () => {}
    let resolveCurrentResponse: (response: Response) => void = () => {}
    const staleResponse = new Promise<Response>((resolve) => {
      resolveStaleResponse = resolve
    })
    const currentResponse = new Promise<Response>((resolve) => {
      resolveCurrentResponse = resolve
    })
    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(staleResponse)
      .mockReturnValueOnce(currentResponse)
    vi.stubGlobal('fetch', fetchMock)

    const staleRefresh = refreshRateLimit()
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

    invalidateSessionCache()
    const currentRefresh = refreshRateLimit()
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))

    resolveStaleResponse(chatKeyResponse('stale-key', 1))
    await staleRefresh
    resolveCurrentResponse(chatKeyResponse('current-key', 6))
    await currentRefresh

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(getRateLimitInfo()).toMatchObject({
      remaining: 6,
      kind: 'free_daily',
      inputTokens: { max: 2_000_000, used: 750_000, remaining: 1_250_000 },
      outputTokens: { max: 100_000, used: 20_000, remaining: 80_000 },
    })
  })

  it('keeps tracking a newer refresh when an older refresh finishes', async () => {
    let resolveOldResponse: (response: Response) => void = () => {}
    let resolveNewResponse: (response: Response) => void = () => {}
    const oldResponse = new Promise<Response>((resolve) => {
      resolveOldResponse = resolve
    })
    const newResponse = new Promise<Response>((resolve) => {
      resolveNewResponse = resolve
    })
    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(oldResponse)
      .mockReturnValueOnce(newResponse)
      .mockResolvedValue(chatKeyResponse('unexpected-key', 4))
    vi.stubGlobal('fetch', fetchMock)

    const oldRefresh = refreshRateLimit()
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

    resetTinfoilClient()
    const newRefresh = refreshRateLimit()
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))

    resolveOldResponse(chatKeyResponse('stale-key', 1))
    await oldRefresh
    expect(fetchMock).toHaveBeenCalledTimes(2)

    const coalescedRefresh = refreshRateLimit()
    expect(fetchMock).toHaveBeenCalledTimes(2)

    resolveNewResponse(chatKeyResponse('current-key', 6))
    await Promise.all([newRefresh, coalescedRefresh])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
