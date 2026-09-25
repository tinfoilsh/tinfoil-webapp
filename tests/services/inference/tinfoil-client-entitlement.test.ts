import { AUTH_ACTIVE_USER_ID } from '@/constants/storage-keys'
import {
  authTokenManager,
  AuthTokenRefreshError,
  AuthTokenUnavailableError,
} from '@/services/auth'
import { isRetryableError } from '@/services/inference/inference-client'
import {
  getRateLimitInfo,
  getSessionToken,
  getVerificationDocument,
  invalidateSessionCache,
  refreshRateLimit,
  resetTinfoilClient,
  TinfoilClientInitializationTimeoutError,
} from '@/services/inference/tinfoil-client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/config', () => ({
  API_BASE_URL: 'https://api.example.com',
  DEV_API_KEY: '',
  IS_DEV: false,
}))

vi.mock('@/utils/error-handling', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
}))

const CLERK_TOKEN = 'clerk-token'
const REFRESHED_CLERK_TOKEN = 'refreshed-clerk-token'
const CHAT_TOKEN_URL = 'https://api.example.com/api/chat/token'
const FREE_KEY_URL = 'https://api.example.com/api/keys/chat'

function subscriberResponse() {
  return Response.json({
    key: 'subscriber-token',
    expires_at: '2099-01-01T00:00:00Z',
    is_free_tier: false,
    rate_limit: {
      max_input_tokens: 20_000_000,
      input_tokens_used: 100,
      input_tokens_remaining: 19_999_900,
      max_output_tokens: 1_000_000,
      output_tokens_used: 10,
      output_tokens_remaining: 999_990,
      resets_at: '2099-01-01T00:00:00Z',
    },
  })
}

function freeResponse() {
  return Response.json({
    key: 'free-key',
    expires_at: '2099-01-01T00:00:00Z',
    is_free_tier: true,
    rate_limit: { max_requests: 3, remaining: 0 },
  })
}

function errorResponse(status: number) {
  return Response.json({ error: 'Request failed' }, { status })
}

describe('chat session entitlement', () => {
  const getToken = vi.fn<() => Promise<string | null>>()
  const fetchMock = vi.fn<typeof fetch>()

  beforeEach(() => {
    resetTinfoilClient()
    authTokenManager.reset()
    getToken.mockReset().mockResolvedValue(CLERK_TOKEN)
    fetchMock.mockReset().mockImplementation(async () => freeResponse())
    vi.stubGlobal('fetch', fetchMock)
    authTokenManager.initialize(getToken)
  })

  afterEach(() => {
    resetTinfoilClient()
    authTokenManager.reset()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it.each([403, 404, 408, 500, 502, 503])(
    'does not downgrade a signed-in user after HTTP %i',
    async (status) => {
      fetchMock.mockResolvedValueOnce(errorResponse(status))

      const error = await getSessionToken().catch((error: unknown) => error)

      expect(error).toBeInstanceOf(Error)
      expect(error).toMatchObject({ status })
      expect(isRetryableError(error)).toBe(status === 408 || status >= 500)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(getRateLimitInfo()).toBeNull()

      fetchMock.mockResolvedValueOnce(subscriberResponse())
      await expect(getSessionToken()).resolves.toBe('subscriber-token')
      expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
        CHAT_TOKEN_URL,
        CHAT_TOKEN_URL,
      ])
      expect(getRateLimitInfo()).toMatchObject({ kind: 'hourly' })
    },
  )

  it('propagates a network failure without requesting or caching a free key', async () => {
    const networkError = new TypeError('Failed to fetch')
    fetchMock.mockRejectedValueOnce(networkError)

    await expect(getSessionToken()).rejects.toBe(networkError)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(getRateLimitInfo()).toBeNull()
  })

  it.each(['not JSON', '{}', '{"key":""}', '{"key":"   "}', 'null'])(
    'rejects an invalid subscriber response: %s',
    async (body) => {
      fetchMock.mockResolvedValueOnce(new Response(body))

      const error = await getSessionToken().catch((error: unknown) => error)

      expect(error).toBeInstanceOf(Error)
      expect(isRetryableError(error)).toBe(true)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(getRateLimitInfo()).toBeNull()
    },
  )

  it('refreshes a rejected Clerk token once and obtains subscriber access', async () => {
    getToken.mockResolvedValueOnce(CLERK_TOKEN)
    getToken.mockResolvedValue(REFRESHED_CLERK_TOKEN)
    fetchMock
      .mockResolvedValueOnce(errorResponse(401))
      .mockResolvedValueOnce(subscriberResponse())

    await expect(getSessionToken()).resolves.toBe('subscriber-token')

    expect(getToken.mock.calls).toEqual([[], [{ skipCache: true }]])
    expect(fetchMock).toHaveBeenNthCalledWith(2, CHAT_TOKEN_URL, {
      headers: { Authorization: `Bearer ${REFRESHED_CLERK_TOKEN}` },
      signal: undefined,
    })
    expect(getRateLimitInfo()).toMatchObject({ kind: 'hourly' })
  })

  it('surfaces a repeated 401 without looping or downgrading', async () => {
    fetchMock.mockImplementation(async () => errorResponse(401))

    await expect(getSessionToken()).rejects.toMatchObject({ status: 401 })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(getToken).toHaveBeenCalledTimes(2)
    expect(getRateLimitInfo()).toBeNull()
  })

  it('does not downgrade when forced authentication refresh fails', async () => {
    getToken.mockResolvedValueOnce(CLERK_TOKEN).mockResolvedValueOnce(null)
    fetchMock.mockResolvedValueOnce(errorResponse(401))

    await expect(getSessionToken()).rejects.toBeInstanceOf(
      AuthTokenRefreshError,
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(getRateLimitInfo()).toBeNull()
  })

  it.each(['unavailable', 'network'])(
    'does not treat an initialized but %s auth session as anonymous',
    async (failure) => {
      if (failure === 'network') {
        getToken.mockRejectedValueOnce(new TypeError('Offline'))
      } else {
        getToken.mockResolvedValueOnce(null)
      }

      await expect(getSessionToken()).rejects.toBeInstanceOf(
        AuthTokenUnavailableError,
      )

      expect(fetchMock).not.toHaveBeenCalled()
      expect(getRateLimitInfo()).toBeNull()
    },
  )

  it('does not issue an anonymous key when persisted sign-in has not initialized', async () => {
    vi.useFakeTimers()
    authTokenManager.reset()
    localStorage.setItem(AUTH_ACTIVE_USER_ID, 'user-subscriber')

    const token = getSessionToken().catch((error: unknown) => error)
    await vi.runAllTimersAsync()
    expect(await token).toBeInstanceOf(AuthTokenUnavailableError)

    expect(fetchMock).not.toHaveBeenCalled()
    expect(getRateLimitInfo()).toBeNull()
  })

  it('waits for persisted sign-in to initialize before minting subscriber access', async () => {
    authTokenManager.reset()
    localStorage.setItem(AUTH_ACTIVE_USER_ID, 'user-subscriber')
    fetchMock.mockResolvedValueOnce(subscriberResponse())

    const token = getSessionToken()
    expect(fetchMock).not.toHaveBeenCalled()
    authTokenManager.initialize(getToken)

    await expect(token).resolves.toBe('subscriber-token')
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([CHAT_TOKEN_URL])
  })

  it('keeps anonymous free chat available', async () => {
    authTokenManager.reset()

    await expect(getSessionToken()).resolves.toBe('free-key')

    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(FREE_KEY_URL, {
      headers: {},
      signal: undefined,
    })
    expect(getRateLimitInfo()).toMatchObject({
      kind: 'free_daily',
      remaining: 0,
    })
  })

  it('uses the free tier only after an explicit subscription-required response', async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(402))

    await expect(getSessionToken()).resolves.toBe('free-key')

    expect(fetchMock).toHaveBeenNthCalledWith(2, FREE_KEY_URL, {
      headers: { Authorization: `Bearer ${CLERK_TOKEN}` },
      signal: undefined,
    })
    expect(getRateLimitInfo()).toMatchObject({
      kind: 'free_daily',
      remaining: 0,
    })
  })

  it('preserves the refreshed identity when an unsubscribed user needs a free key', async () => {
    getToken.mockResolvedValueOnce(CLERK_TOKEN)
    getToken.mockResolvedValue(REFRESHED_CLERK_TOKEN)
    fetchMock
      .mockResolvedValueOnce(errorResponse(401))
      .mockResolvedValueOnce(errorResponse(402))

    await expect(getSessionToken()).resolves.toBe('free-key')

    expect(fetchMock).toHaveBeenNthCalledWith(3, FREE_KEY_URL, {
      headers: { Authorization: `Bearer ${REFRESHED_CLERK_TOKEN}` },
      signal: undefined,
    })
  })

  it('preserves an hourly limit instead of falling back to free chat', async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(429))

    await expect(getSessionToken()).rejects.toMatchObject({
      code: 'HOURLY_LIMIT',
      status: 429,
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(getRateLimitInfo()).toMatchObject({ kind: 'hourly', remaining: 0 })
  })

  it('keeps a subscriber session and hourly budget on a failed background refresh', async () => {
    fetchMock.mockResolvedValueOnce(subscriberResponse())
    await getSessionToken()
    const budget = getRateLimitInfo()

    fetchMock.mockResolvedValueOnce(errorResponse(503))
    await refreshRateLimit()

    expect(getRateLimitInfo()).toEqual(budget)
    await expect(getSessionToken()).resolves.toBe('subscriber-token')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('replaces subscriber access after an explicit subscription loss during usage refresh', async () => {
    fetchMock.mockResolvedValueOnce(subscriberResponse())
    await getSessionToken()

    fetchMock
      .mockResolvedValueOnce(errorResponse(402))
      .mockResolvedValueOnce(errorResponse(402))
      .mockResolvedValueOnce(freeResponse())
    await refreshRateLimit()

    expect(getRateLimitInfo()).toMatchObject({
      kind: 'free_daily',
      remaining: 0,
    })
    await expect(getSessionToken()).resolves.toBe('free-key')
    expect(fetchMock).toHaveBeenLastCalledWith(FREE_KEY_URL, {
      headers: { Authorization: `Bearer ${CLERK_TOKEN}` },
      signal: undefined,
    })
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('does not retain a revoked subscriber token if resolving the new tier fails', async () => {
    fetchMock.mockResolvedValueOnce(subscriberResponse())
    await getSessionToken()

    fetchMock
      .mockResolvedValueOnce(errorResponse(402))
      .mockResolvedValueOnce(errorResponse(503))
    await refreshRateLimit()

    expect(getRateLimitInfo()).toBeNull()
    fetchMock.mockResolvedValueOnce(errorResponse(503))
    await expect(getSessionToken()).rejects.toMatchObject({ status: 503 })
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      CHAT_TOKEN_URL,
      CHAT_TOKEN_URL,
      CHAT_TOKEN_URL,
      CHAT_TOKEN_URL,
    ])
  })

  it('does not apply a stale subscription loss to a newly selected account', async () => {
    fetchMock.mockResolvedValueOnce(subscriberResponse())
    await getSessionToken()
    let resolveResponse!: (response: Response) => void
    fetchMock.mockImplementationOnce(
      () => new Promise<Response>((resolve) => (resolveResponse = resolve)),
    )
    const refresh = refreshRateLimit()
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))

    invalidateSessionCache()
    authTokenManager.initialize(vi.fn().mockResolvedValue('new-account-token'))
    fetchMock.mockResolvedValueOnce(subscriberResponse())
    await getSessionToken()
    const budget = getRateLimitInfo()
    resolveResponse(errorResponse(402))
    await refresh

    expect(getRateLimitInfo()).toEqual(budget)
    await expect(getSessionToken()).resolves.toBe('subscriber-token')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('replaces an exhausted anonymous session once authentication is available', async () => {
    authTokenManager.reset()
    await expect(getSessionToken()).resolves.toBe('free-key')
    expect(getRateLimitInfo()).toMatchObject({
      kind: 'free_daily',
      remaining: 0,
    })

    authTokenManager.initialize(getToken)
    fetchMock.mockResolvedValueOnce(subscriberResponse())

    await expect(getSessionToken()).resolves.toBe('subscriber-token')
    expect(getRateLimitInfo()).toMatchObject({ kind: 'hourly' })
    expect(getRateLimitInfo()!.remaining).toBeGreaterThan(0)
  })

  it('clears a depleted free quota on entitlement invalidation even when the mint fails', async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(402))
    await getSessionToken()
    expect(getRateLimitInfo()).toMatchObject({
      kind: 'free_daily',
      remaining: 0,
    })

    invalidateSessionCache()
    fetchMock.mockResolvedValueOnce(errorResponse(503))
    await expect(getSessionToken()).rejects.toMatchObject({ status: 503 })
    expect(getRateLimitInfo()).toBeNull()

    fetchMock.mockResolvedValueOnce(subscriberResponse())
    await expect(getSessionToken()).resolves.toBe('subscriber-token')
    expect(getRateLimitInfo()).toMatchObject({ kind: 'hourly' })
  })

  it('does not replay or fall back after initialization aborts during auth refresh', async () => {
    vi.useFakeTimers()
    let resolveRefresh!: (token: string) => void
    getToken
      .mockResolvedValueOnce(CLERK_TOKEN)
      .mockImplementationOnce(
        () => new Promise<string>((resolve) => (resolveRefresh = resolve)),
      )
    fetchMock.mockResolvedValueOnce(errorResponse(401))

    const initialization = getVerificationDocument().catch(
      (error: unknown) => error,
    )
    await vi.runAllTimersAsync()

    expect(await initialization).toBeInstanceOf(
      TinfoilClientInitializationTimeoutError,
    )
    resolveRefresh(REFRESHED_CLERK_TOKEN)
    await vi.runAllTimersAsync()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(getRateLimitInfo()).toBeNull()
  })

  it('does not refresh or downgrade a stale response after account invalidation', async () => {
    let resolveResponse!: (response: Response) => void
    fetchMock.mockImplementationOnce(
      () => new Promise<Response>((resolve) => (resolveResponse = resolve)),
    )
    const token = getSessionToken()
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

    invalidateSessionCache()
    authTokenManager.initialize(vi.fn().mockResolvedValue('new-account-token'))
    fetchMock.mockResolvedValueOnce(subscriberResponse())
    resolveResponse(errorResponse(401))

    await expect(token).resolves.toBe('subscriber-token')
    expect(getToken).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenLastCalledWith(CHAT_TOKEN_URL, {
      headers: { Authorization: 'Bearer new-account-token' },
      signal: undefined,
    })
    expect(getRateLimitInfo()).toMatchObject({ kind: 'hourly' })
  })
})
