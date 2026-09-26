import {
  CHAT_TOKEN_MAX_COOLDOWN_MS,
  CHAT_TOKEN_RATE_LIMIT_FALLBACK_MS,
  INFERENCE_CLIENT_INITIALIZATION_TIMEOUT_MS,
} from '@/services/inference/constants'
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

const auth = vi.hoisted(() => ({
  isInitialized: () => true,
  getValidToken: vi.fn<() => Promise<string>>(),
  refreshToken: vi.fn<() => Promise<string>>(),
}))

vi.mock('@/config', () => ({
  API_BASE_URL: 'https://api.example.com',
  DEV_API_KEY: '',
  IS_DEV: false,
}))
vi.mock('@/services/auth', () => ({ authTokenManager: auth }))
vi.mock('@/utils/error-handling', () => ({ logError: vi.fn() }))
vi.mock('tinfoil', () => ({
  AuthenticationError: class AuthenticationError extends Error {},
  SecureClient: class SecureClient {
    ready = async () => {}
    getVerificationDocument = () => ({ securityVerified: true })
    getBaseURL = () => 'https://enclave.example.com'
    fetch = vi.fn()
  },
}))

const NOW = Date.parse('2026-09-26T10:58:00Z')
const RESET_AT = '2026-09-26T11:00:00Z'
const RESET_DELAY_MS = Date.parse(RESET_AT) - NOW
const POLL_INTERVAL_MS = 30_000
const CHAT_TOKEN_URL = 'https://api.example.com/api/chat/token'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill
  })
  return { promise, resolve }
}

function subscriberResponse(
  key = 'subscriber-token',
  expiresAt = '2099-01-01T00:00:00Z',
) {
  return Response.json({
    key,
    expires_at: expiresAt,
    rate_limit: {
      max_input_tokens: 1_000,
      input_tokens_used: 100,
      input_tokens_remaining: 900,
      resets_at: RESET_AT,
    },
  })
}

function limitedResponse(
  details: Record<string, unknown> = { resets_at: RESET_AT },
  headers?: HeadersInit,
) {
  return Response.json(
    {
      error: 'Hourly cap reached',
      code: 'HOURLY_LIMIT_REACHED',
      ...details,
    },
    { status: 429, headers },
  )
}

describe('chat token request sharing and cooldown', () => {
  const fetchMock = vi.fn<typeof fetch>()

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    resetTinfoilClient()
    auth.getValidToken.mockReset().mockResolvedValue('account-a')
    auth.refreshToken.mockReset().mockResolvedValue('refreshed-account-a')
    fetchMock.mockReset().mockImplementation(async () => subscriberResponse())
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    resetTinfoilClient()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('starts immediately and shares one mint across token, verification, and usage callers', async () => {
    const response = deferred<Response>()
    fetchMock.mockReturnValueOnce(response.promise)
    const tokens = Promise.all([getSessionToken(), getSessionToken()])
    const verification = getVerificationDocument()
    const refresh = refreshRateLimit()

    await vi.advanceTimersByTimeAsync(0)
    expect(Date.now()).toBe(NOW)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(CHAT_TOKEN_URL, {
      headers: { Authorization: 'Bearer account-a' },
      signal: expect.any(AbortSignal),
    })

    response.resolve(subscriberResponse())
    await expect(tokens).resolves.toEqual([
      'subscriber-token',
      'subscriber-token',
    ])
    await expect(verification).resolves.toMatchObject({
      securityVerified: true,
    })
    await refresh
    await expect(getSessionToken()).resolves.toBe('subscriber-token')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('shares one 429 and returns the known limit immediately to later callers', async () => {
    fetchMock.mockResolvedValueOnce(limitedResponse())
    const results = await Promise.allSettled([
      getSessionToken(),
      getSessionToken(),
      getVerificationDocument(),
    ])
    for (const result of results) {
      expect(result).toMatchObject({
        status: 'rejected',
        reason: { code: 'HOURLY_LIMIT', status: 429 },
      })
    }
    await expect(getSessionToken()).rejects.toMatchObject({
      code: 'HOURLY_LIMIT',
    })
    await refreshRateLimit()
    expect(Date.now()).toBe(NOW)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(getRateLimitInfo()).toMatchObject({
      kind: 'hourly',
      remaining: 0,
      resetsAt: RESET_AT,
    })
  })

  it('skips 30-second polls and performs one successful refresh exactly at reset', async () => {
    fetchMock.mockResolvedValueOnce(limitedResponse())
    await expect(getSessionToken()).rejects.toMatchObject({
      code: 'HOURLY_LIMIT',
    })
    for (let poll = 0; poll < 3; poll++) {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
      await refreshRateLimit()
      await expect(getSessionToken()).rejects.toMatchObject({
        code: 'HOURLY_LIMIT',
      })
    }
    await vi.advanceTimersByTimeAsync(Date.parse(RESET_AT) - Date.now() - 1)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(getRateLimitInfo()).toMatchObject({
      inputTokens: { remaining: 900 },
    })
    await expect(getSessionToken()).resolves.toBe('subscriber-token')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not wait for a throttled browser timer after the reset has passed', async () => {
    fetchMock.mockResolvedValueOnce(limitedResponse())
    await expect(getSessionToken()).rejects.toMatchObject({
      code: 'HOURLY_LIMIT',
    })
    vi.setSystemTime(Date.parse(RESET_AT))

    await expect(getSessionToken()).resolves.toBe('subscriber-token')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(RESET_DELAY_MS)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it.each([
    {
      name: 'nested reset',
      details: { rate_limit: { resets_at: RESET_AT } },
      headers: {},
      delay: RESET_DELAY_MS,
    },
    {
      name: 'Retry-After seconds',
      details: {},
      headers: { 'Retry-After': '120' },
      delay: RESET_DELAY_MS,
    },
    {
      name: 'Retry-After HTTP date',
      details: {},
      headers: { 'Retry-After': 'Sat, 26 Sep 2026 11:00:00 GMT' },
      delay: RESET_DELAY_MS,
    },
    {
      name: 'invalid reset with valid header',
      details: { resets_at: 'invalid' },
      headers: { 'Retry-After': '120' },
      delay: RESET_DELAY_MS,
    },
    {
      name: 'missing retry metadata',
      details: {},
      headers: {},
      delay: CHAT_TOKEN_RATE_LIMIT_FALLBACK_MS,
    },
    {
      name: 'malformed retry metadata',
      details: { resets_at: 'invalid' },
      headers: { 'Retry-After': 'invalid' },
      delay: CHAT_TOKEN_RATE_LIMIT_FALLBACK_MS,
    },
    {
      name: 'past reset and negative retry',
      details: { resets_at: '2026-09-26T10:00:00Z' },
      headers: { 'Retry-After': '-1' },
      delay: CHAT_TOKEN_RATE_LIMIT_FALLBACK_MS,
    },
    {
      name: 'excessive retry',
      details: {},
      headers: { 'Retry-After': '999999999' },
      delay: CHAT_TOKEN_MAX_COOLDOWN_MS,
    },
    {
      name: 'server clock skew',
      details: { resets_at: RESET_AT },
      headers: { Date: 'Sat, 26 Sep 2026 10:59:00 GMT' },
      delay: 60_000,
    },
  ])('bounds the cooldown using $name', async ({ details, headers, delay }) => {
    fetchMock.mockResolvedValueOnce(
      limitedResponse(details, headers as HeadersInit),
    )
    await expect(getSessionToken()).rejects.toMatchObject({
      code: 'HOURLY_LIMIT',
    })
    await vi.advanceTimersByTimeAsync(delay - 1)
    await refreshRateLimit()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1)
    await expect(getSessionToken()).resolves.toBe('subscriber-token')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('serves a valid cached token without waiting for a background refresh or its cooldown', async () => {
    await getSessionToken()
    const response = deferred<Response>()
    fetchMock.mockReturnValueOnce(response.promise)
    const refresh = refreshRateLimit()
    await vi.advanceTimersByTimeAsync(0)

    await expect(getSessionToken()).resolves.toBe('subscriber-token')
    response.resolve(limitedResponse())
    await refresh
    await expect(getSessionToken()).resolves.toBe('subscriber-token')
    await refreshRateLimit()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('retains the reset-time mint when the previous token expired during cooldown', async () => {
    fetchMock.mockResolvedValueOnce(
      subscriberResponse('expiring-token', RESET_AT),
    )
    await getSessionToken()
    fetchMock.mockResolvedValueOnce(limitedResponse())
    await refreshRateLimit()

    await vi.advanceTimersByTimeAsync(RESET_DELAY_MS)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    await expect(getSessionToken()).resolves.toBe('subscriber-token')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('shares background usage and foreground renewal when the cached token expires', async () => {
    fetchMock.mockResolvedValueOnce(
      subscriberResponse('expiring-token', RESET_AT),
    )
    await getSessionToken()
    await vi.advanceTimersByTimeAsync(RESET_DELAY_MS - POLL_INTERVAL_MS)
    const response = deferred<Response>()
    fetchMock.mockReturnValueOnce(response.promise)

    const refresh = refreshRateLimit()
    const renewal = getSessionToken()
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    response.resolve(subscriberResponse('renewed-token'))
    await refresh
    await expect(renewal).resolves.toBe('renewed-token')
    await expect(getSessionToken()).resolves.toBe('renewed-token')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('allows an explicit early recheck and cancels the reset timer on success', async () => {
    fetchMock.mockResolvedValueOnce(limitedResponse())
    await expect(getSessionToken()).rejects.toMatchObject({
      code: 'HOURLY_LIMIT',
    })

    await Promise.all([
      refreshRateLimit({ force: true }),
      refreshRateLimit({ force: true }),
    ])
    await expect(getSessionToken()).resolves.toBe('subscriber-token')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(Date.now()).toBe(NOW)
    await vi.advanceTimersByTimeAsync(RESET_DELAY_MS)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('keeps the cooldown and scheduled reset when an early recheck fails transiently', async () => {
    fetchMock.mockResolvedValueOnce(limitedResponse())
    await expect(getSessionToken()).rejects.toMatchObject({
      code: 'HOURLY_LIMIT',
    })
    fetchMock.mockResolvedValueOnce(Response.json({}, { status: 503 }))

    await refreshRateLimit({ force: true })
    await refreshRateLimit()
    await expect(getSessionToken()).rejects.toMatchObject({
      code: 'HOURLY_LIMIT',
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(RESET_DELAY_MS)
    await expect(getSessionToken()).resolves.toBe('subscriber-token')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it.each([invalidateSessionCache, resetTinfoilClient])(
    'clears the cooldown and old timer on %s',
    async (invalidate) => {
      fetchMock.mockResolvedValueOnce(limitedResponse())
      await expect(getSessionToken()).rejects.toMatchObject({
        code: 'HOURLY_LIMIT',
      })
      invalidate()
      auth.getValidToken.mockResolvedValue('account-b')

      await expect(getSessionToken()).resolves.toBe('subscriber-token')
      expect(fetchMock).toHaveBeenLastCalledWith(CHAT_TOKEN_URL, {
        headers: { Authorization: 'Bearer account-b' },
        signal: expect.any(AbortSignal),
      })
      await vi.advanceTimersByTimeAsync(RESET_DELAY_MS)
      expect(fetchMock).toHaveBeenCalledTimes(2)
    },
  )

  it('ignores an old account response without clearing the new shared request', async () => {
    const oldResponse = deferred<Response>()
    const newResponse = deferred<Response>()
    fetchMock
      .mockReturnValueOnce(oldResponse.promise)
      .mockReturnValueOnce(newResponse.promise)
    const oldCaller = getSessionToken()
    await vi.advanceTimersByTimeAsync(0)

    invalidateSessionCache()
    auth.getValidToken.mockResolvedValue('account-b')
    const newCaller = getSessionToken()
    await vi.advanceTimersByTimeAsync(0)
    oldResponse.resolve(limitedResponse())
    await vi.advanceTimersByTimeAsync(0)
    const thirdCaller = getSessionToken()
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(getRateLimitInfo()).toBeNull()

    newResponse.resolve(subscriberResponse('account-b-token'))
    await expect(
      Promise.all([oldCaller, newCaller, thirdCaller]),
    ).resolves.toEqual([
      'account-b-token',
      'account-b-token',
      'account-b-token',
    ])
    await vi.advanceTimersByTimeAsync(RESET_DELAY_MS)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not cancel another caller when initialization reaches its earlier deadline', async () => {
    const bearer = deferred<string>()
    auth.getValidToken.mockReturnValueOnce(bearer.promise)
    const initialization = getVerificationDocument().catch(
      (error: unknown) => error,
    )
    const halfDeadline = INFERENCE_CLIENT_INITIALIZATION_TIMEOUT_MS / 2
    await vi.advanceTimersByTimeAsync(halfDeadline)
    const response = deferred<Response>()
    fetchMock.mockReturnValueOnce(response.promise)
    bearer.resolve('account-a')
    const token = getSessionToken()
    await vi.advanceTimersByTimeAsync(halfDeadline)

    expect(await initialization).toBeInstanceOf(
      TinfoilClientInitializationTimeoutError,
    )
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(false)
    response.resolve(subscriberResponse())
    await expect(token).resolves.toBe('subscriber-token')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('times out a stuck shared mint, permits a retry, and ignores its late 429', async () => {
    const response = deferred<Response>()
    fetchMock.mockReturnValueOnce(response.promise)
    const result = getSessionToken().catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(
      INFERENCE_CLIENT_INITIALIZATION_TIMEOUT_MS,
    )

    expect(await result).toMatchObject({ status: 408 })
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true)
    await expect(getSessionToken()).resolves.toBe('subscriber-token')
    response.resolve(limitedResponse())
    await vi.advanceTimersByTimeAsync(0)
    expect(getRateLimitInfo()).toMatchObject({
      inputTokens: { remaining: 900 },
    })
    await vi.advanceTimersByTimeAsync(RESET_DELAY_MS)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('shares the single authentication refresh after concurrent callers receive a 401', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({}, { status: 401 }))

    await expect(
      Promise.all([getSessionToken(), getSessionToken()]),
    ).resolves.toEqual(['subscriber-token', 'subscriber-token'])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(auth.refreshToken).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenLastCalledWith(CHAT_TOKEN_URL, {
      headers: { Authorization: 'Bearer refreshed-account-a' },
      signal: expect.any(AbortSignal),
    })
  })
})
