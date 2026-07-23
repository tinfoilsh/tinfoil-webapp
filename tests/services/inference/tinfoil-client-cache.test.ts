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

const chatKeyResponse = (key: string, remaining: number) =>
  new Response(
    JSON.stringify({
      key,
      is_free_tier: true,
      rate_limit: {
        max_requests: 7,
        remaining,
        resets_at: '2026-07-24T00:00:00Z',
      },
    }),
    { status: 200 },
  )

describe('tinfoil-client session cache', () => {
  beforeEach(() => {
    resetTinfoilClient()
    localStorage.clear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('does not restore stale rate limits after invalidation', async () => {
    let resolveStaleResponse: (response: Response) => void = () => {}
    const staleResponse = new Promise<Response>((resolve) => {
      resolveStaleResponse = resolve
    })
    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(staleResponse)
      .mockResolvedValueOnce(chatKeyResponse('current-key', 6))
    vi.stubGlobal('fetch', fetchMock)

    const refresh = refreshRateLimit()
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

    invalidateSessionCache()
    resolveStaleResponse(chatKeyResponse('stale-key', 1))
    await refresh

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(getRateLimitInfo()?.remaining).toBe(6)
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
      .mockResolvedValueOnce(chatKeyResponse('retried-key', 5))
      .mockResolvedValue(chatKeyResponse('unexpected-key', 4))
    vi.stubGlobal('fetch', fetchMock)

    const oldRefresh = refreshRateLimit()
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

    resetTinfoilClient()
    const newRefresh = refreshRateLimit()
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))

    resolveOldResponse(chatKeyResponse('stale-key', 1))
    await oldRefresh
    expect(fetchMock).toHaveBeenCalledTimes(3)

    const coalescedRefresh = refreshRateLimit()
    expect(fetchMock).toHaveBeenCalledTimes(3)

    resolveNewResponse(chatKeyResponse('current-key', 6))
    await Promise.all([newRefresh, coalescedRefresh])
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
})
