import { API_BASE_URL, DEV_API_KEY, IS_DEV } from '@/config'
import { AUTH_ACTIVE_USER_ID } from '@/constants/storage-keys'
import { logError } from '@/utils/error-handling'
import {
  TINFOIL_EVENTS_HEADER,
  TINFOIL_EVENTS_VALUE_CODE_EXECUTION,
  TINFOIL_EVENTS_VALUE_WEB_SEARCH,
} from '@/utils/tinfoil-events'
import OpenAI from 'openai'
import {
  AuthenticationError,
  SecureClient,
  type VerificationDocument,
} from 'tinfoil'
import { authTokenManager } from '../auth'

export interface RateLimitInfo {
  maxRequests: number
  remaining: number
  resetsAt: string
  /**
   * Which limit this represents. Absent or `free_daily` is the anonymous/
   * free-tier daily request limit; `hourly` is the per-account hourly usage
   * cap that subscribers hit (surfaced through the same indicator channel).
   */
  kind?: 'free_daily' | 'hourly'
}

const SESSION_TOKEN_EXPIRY_BUFFER_MS = 1 * 60 * 1000
const AUTH_INIT_WAIT_MS = 3000

let clientInstance: OpenAI | null = null
let secureClient: SecureClient | null = null
let lastSessionToken: string | null = null
let cachedSessionToken: string | null = null
let cachedSessionTokenExpiresAt: number | null = null
let cachedSessionTokenWasAuthenticated = false
let cachedRateLimit: RateLimitInfo | null = null
let remainingBeforeRequest: number | null = null
let refreshInFlight: Promise<void> | null = null
let sessionCacheGeneration = 0

function dispatchRateLimitUpdate(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('rateLimitUpdated'))
  }
}

type ServerErrorBody = {
  error?: string
  code?: string
  resets_at?: string
}

function parseErrorBody(errorText: string): ServerErrorBody | null {
  try {
    return JSON.parse(errorText) as ServerErrorBody
  } catch {
    return null
  }
}

function isHourlyLimit(
  status: number,
  parsedError: ServerErrorBody | null,
): boolean {
  return status === 429 || parsedError?.code === 'HOURLY_LIMIT_REACHED'
}

// Surfaces the per-account hourly usage cap through the shared rate-limit
// channel (so the banner renders) and throws a message the chat recognizes as a
// rate limit rather than a generic failure. Never returns.
function surfaceHourlyLimit(parsedError: ServerErrorBody | null): never {
  cachedRateLimit = {
    maxRequests: 0,
    remaining: 0,
    resetsAt: parsedError?.resets_at ?? '',
    kind: 'hourly',
  }
  dispatchRateLimitUpdate()
  throw new Error(
    parsedError?.error ?? 'You have reached your hourly usage limit.',
  )
}

// Mints a stateless JWT inference token for a signed-in user via
// /api/chat/token. Returns the token on success, or null on any non-rate-limit
// failure (no active subscription, endpoint disabled, network error) so the
// caller falls back to the opaque /api/keys/chat path. A subscriber over the
// hourly cap is surfaced here and not fallen back, so the cap cannot be bypassed
// through the opaque path.
async function fetchChatJWT(
  authBearer: string,
  cacheGeneration: number,
): Promise<{ key: string; expiresAt: number | null } | null> {
  let response: Response
  try {
    response = await fetch(`${API_BASE_URL}/api/chat/token`, {
      headers: { Authorization: `Bearer ${authBearer}` },
    })
  } catch {
    return null
  }

  if (response.ok) {
    try {
      const data = await response.json()
      if (typeof data?.key === 'string' && data.key !== '') {
        const expiresAtMs = data.expires_at
          ? new Date(data.expires_at).getTime()
          : null
        return {
          key: data.key,
          expiresAt:
            expiresAtMs !== null && !Number.isNaN(expiresAtMs)
              ? expiresAtMs
              : null,
        }
      }
    } catch {
      // Malformed / non-JSON 200 body: treat as a miss and fall back to the
      // opaque /api/keys/chat path rather than throwing.
    }
    return null
  }

  const parsedError = parseErrorBody(await response.text())
  if (isHourlyLimit(response.status, parsedError)) {
    if (cacheGeneration !== sessionCacheGeneration) return null
    surfaceHourlyLimit(parsedError)
  }
  return null
}

async function fetchSessionToken(): Promise<string> {
  if (IS_DEV) {
    return DEV_API_KEY
  }

  const cacheGeneration = sessionCacheGeneration

  // If the user was previously signed in, wait for Clerk to initialize
  // the auth token manager before fetching — otherwise we'd get an
  // anonymous free-tier key that gets cached until expiry.
  if (
    !authTokenManager.isInitialized() &&
    typeof window !== 'undefined' &&
    localStorage.getItem(AUTH_ACTIVE_USER_ID) !== null
  ) {
    await authTokenManager.waitForInit(AUTH_INIT_WAIT_MS)
  }

  // Resolve the auth bearer (if any) up front so the cache-validity
  // check and the actual request use the same authenticated/anonymous
  // decision.  This avoids a stale-cache loop when getValidToken()
  // intermittently fails for a signed-in user.
  let authBearer: string | null = null
  if (authTokenManager.isInitialized()) {
    try {
      authBearer = await authTokenManager.getValidToken()
    } catch (error) {
      logError(
        'Failed to get auth token, falling back to anonymous key',
        error,
        {
          component: 'tinfoil-client',
          action: 'fetchSessionToken',
        },
      )
    }
  }
  if (cacheGeneration !== sessionCacheGeneration) {
    return fetchSessionToken()
  }
  const usedAuthHeader = authBearer !== null

  // If the cached token was fetched anonymously but we now have an
  // authenticated bearer, discard it so the next fetch goes out with
  // the user's token and returns the correct (possibly premium) rate
  // limit info.
  if (
    cachedSessionToken &&
    !cachedSessionTokenWasAuthenticated &&
    usedAuthHeader
  ) {
    cachedSessionToken = null
    cachedSessionTokenExpiresAt = null
    cachedRateLimit = null
    dispatchRateLimitUpdate()
  }

  if (cachedSessionToken) {
    const isExpired =
      cachedSessionTokenExpiresAt !== null &&
      Date.now() > cachedSessionTokenExpiresAt - SESSION_TOKEN_EXPIRY_BUFFER_MS
    if (!isExpired) {
      return cachedSessionToken
    }
    cachedSessionToken = null
    cachedSessionTokenExpiresAt = null
  }

  // Signed-in clients mint a stateless JWT inference token via /api/chat/token.
  // Anonymous users (and signed-in users without an active subscription) fall
  // back to the opaque /api/keys/chat path below.
  if (authBearer) {
    const jwt = await fetchChatJWT(authBearer, cacheGeneration)
    if (cacheGeneration !== sessionCacheGeneration) {
      return fetchSessionToken()
    }
    if (jwt !== null) {
      cachedSessionToken = jwt.key
      cachedSessionTokenWasAuthenticated = true
      cachedSessionTokenExpiresAt = jwt.expiresAt
      cachedRateLimit = null
      dispatchRateLimitUpdate()
      return jwt.key
    }
  }

  // Build request headers: include auth if we resolved a bearer above
  const headers: Record<string, string> = {}
  if (authBearer) {
    headers['Authorization'] = `Bearer ${authBearer}`
  }

  const response = await fetch(`${API_BASE_URL}/api/keys/chat`, {
    headers,
  })
  if (cacheGeneration !== sessionCacheGeneration) {
    return fetchSessionToken()
  }

  if (!response.ok) {
    const errorText = await response.text()
    if (cacheGeneration !== sessionCacheGeneration) {
      return fetchSessionToken()
    }
    logError('Failed to fetch session token from server', undefined, {
      component: 'tinfoil-client',
      action: 'fetchSessionToken',
      metadata: {
        status: response.status,
        statusText: response.statusText,
        error: errorText,
      },
    })

    const parsedError = parseErrorBody(errorText)

    // Per-account hourly usage cap: surface it through the shared rate-limit
    // channel so the existing banner renders, and throw a message the chat
    // recognizes as a rate limit rather than a generic failure.
    if (isHourlyLimit(response.status, parsedError)) {
      surfaceHourlyLimit(parsedError)
    }

    throw new Error(`Failed to get session token: ${response.status}`)
  }

  const data = await response.json()
  if (cacheGeneration !== sessionCacheGeneration) {
    return fetchSessionToken()
  }
  cachedSessionToken = data.key
  cachedSessionTokenWasAuthenticated = usedAuthHeader
  if (data.expires_at) {
    cachedSessionTokenExpiresAt = new Date(data.expires_at).getTime()
  }

  if (data.is_free_tier && data.rate_limit) {
    cachedRateLimit = {
      maxRequests: data.rate_limit.max_requests,
      remaining: data.rate_limit.remaining,
      resetsAt: data.rate_limit.resets_at,
      kind: 'free_daily',
    }
  } else {
    cachedRateLimit = null
  }

  dispatchRateLimitUpdate()

  return data.key
}

export function getRateLimitInfo(): RateLimitInfo | null {
  return cachedRateLimit ? { ...cachedRateLimit } : null
}

/**
 * Snapshots the current remaining count and optimistically decrements it.
 * Called when a request starts so the UI updates immediately and
 * refreshRateLimit can later detect stale server responses.
 */
export function snapshotAndDecrementRemaining(): void {
  if (!cachedRateLimit) return
  remainingBeforeRequest = cachedRateLimit.remaining
  cachedRateLimit = {
    ...cachedRateLimit,
    remaining: Math.max(0, cachedRateLimit.remaining - 1),
  }
  dispatchRateLimitUpdate()
}

/**
 * Forces a fresh fetch of the session token (and rate limit info) from
 * the server, bypassing the local cache.  Called after each stream
 * completes so the UI reflects the server's actual remaining count.
 *
 * If the server returns a stale count (>= the pre-request snapshot),
 * falls back to snapshot - 1 so the UI stays accurate.
 * Concurrent calls are coalesced into a single in-flight request.
 */
export async function refreshRateLimit(): Promise<void> {
  if (refreshInFlight) return refreshInFlight

  const refresh = (async () => {
    const refreshGeneration = sessionCacheGeneration
    const snapshot = remainingBeforeRequest
    remainingBeforeRequest = null
    cachedSessionToken = null
    cachedSessionTokenExpiresAt = null
    try {
      await fetchSessionToken()
      if (
        refreshGeneration === sessionCacheGeneration &&
        snapshot !== null &&
        cachedRateLimit &&
        cachedRateLimit.remaining >= snapshot
      ) {
        cachedRateLimit = {
          ...cachedRateLimit,
          remaining: Math.max(0, snapshot - 1),
        }
        dispatchRateLimitUpdate()
      }
    } catch (error) {
      logError('Failed to refresh rate limit from server', error, {
        component: 'tinfoil-client',
        action: 'refreshRateLimit',
      })
    }
  })()
  refreshInFlight = refresh

  try {
    await refresh
  } finally {
    if (refreshInFlight === refresh) {
      refreshInFlight = null
    }
  }
}

export function resetTinfoilClient(): void {
  sessionCacheGeneration++
  clientInstance = null
  secureClient = null
  lastSessionToken = null
  cachedSessionToken = null
  cachedSessionTokenExpiresAt = null
  cachedSessionTokenWasAuthenticated = false
  cachedRateLimit = null
  remainingBeforeRequest = null
  refreshInFlight = null
}

export function invalidateSessionCache(): void {
  sessionCacheGeneration++
  cachedSessionToken = null
  cachedSessionTokenExpiresAt = null
  cachedSessionTokenWasAuthenticated = false
  remainingBeforeRequest = null
  if (cachedRateLimit !== null) {
    cachedRateLimit = null
    dispatchRateLimitUpdate()
  }
}

async function initClient(sessionToken: string): Promise<OpenAI> {
  try {
    if (IS_DEV) {
      clientInstance = new OpenAI({
        apiKey: sessionToken,
        baseURL: `${window.location.origin}/api/local-router/v1`,
        dangerouslyAllowBrowser: true,
        defaultHeaders: {
          [TINFOIL_EVENTS_HEADER]: `${TINFOIL_EVENTS_VALUE_WEB_SEARCH},${TINFOIL_EVENTS_VALUE_CODE_EXECUTION}`,
        },
      })
    } else {
      secureClient = new SecureClient({})
      // Run the enclave attestation + transport setup here so getBaseURL returns the resolved enclave URL
      await secureClient.ready()
      clientInstance = new OpenAI({
        apiKey: sessionToken,
        baseURL: secureClient.getBaseURL(),
        dangerouslyAllowBrowser: true,
        // Opt into the router's inline progress-marker stream.
        defaultHeaders: {
          [TINFOIL_EVENTS_HEADER]: `${TINFOIL_EVENTS_VALUE_WEB_SEARCH},${TINFOIL_EVENTS_VALUE_CODE_EXECUTION}`,
        },
        fetch: secureClient.fetch,
      })
    }
    lastSessionToken = sessionToken
    return clientInstance
  } catch (error) {
    logError('Failed to initialize Tinfoil client', error, {
      component: 'tinfoil-client',
      action: 'initClient',
    })
    throw error
  }
}

export async function getSessionToken(): Promise<string> {
  return fetchSessionToken()
}

/**
 * Returns a fetch bound to the shared attested SecureClient so callers
 * outside the OpenAI SDK (e.g. document upload) can reuse the same
 * verified channel instead of running attestation a second time.
 *
 * Falls back to the global fetch in dev mode, where requests are routed
 * through the local proxy and SecureClient is intentionally not created.
 */
export async function getSecureFetch(): Promise<typeof fetch> {
  await ensureInitialized()
  if (!secureClient) {
    return fetch
  }
  return secureClient.fetch
}

/**
 * Lazily build the OpenAI client (and SecureClient on prod) the first
 * time anything needs them, and rebuild on session-token rotation.
 */
async function ensureInitialized(): Promise<void> {
  const sessionToken = await fetchSessionToken()
  if (!clientInstance || lastSessionToken !== sessionToken) {
    await initClient(sessionToken)
  }
}

/**
 * Returns the enclave verification document, or `null` in dev mode
 */
export async function getVerificationDocument(): Promise<VerificationDocument | null> {
  await ensureInitialized()
  return secureClient ? secureClient.getVerificationDocument() : null
}

async function getRawClient(): Promise<OpenAI> {
  await ensureInitialized()
  return clientInstance!
}

/**
 * Returns a proxy that behaves like the underlying OpenAI client with
 * one extra behavior: on `AuthenticationError`, the proxy resets the
 * session token cache, rebuilds the client, and replays the call once
 * with the refreshed handle.
 *
 */
export async function getTinfoilClient(): Promise<OpenAI> {
  await getRawClient()

  function resolvePath(path: PropertyKey[]): { fn: any; thisArg: any } {
    let thisArg: any = clientInstance
    let fn: any = clientInstance
    for (const p of path) {
      thisArg = fn
      fn = fn[p]
    }
    return { fn, thisArg }
  }

  function proxyWithRetry(pathFromRoot: PropertyKey[]): any {
    // Target must be a function so the `apply` trap can fire
    return new Proxy(function () {}, {
      has(_, prop) {
        if (!clientInstance) return false
        return prop in clientInstance
      },
      get(_, prop) {
        if (
          prop === 'then' ||
          prop === Symbol.toPrimitive ||
          prop === Symbol.toStringTag
        ) {
          return undefined
        }
        return proxyWithRetry([...pathFromRoot, prop])
      },
      apply(_, __, args) {
        const { fn, thisArg } = resolvePath(pathFromRoot)
        const result = fn.apply(thisArg, args)
        if (result && typeof result.then === 'function') {
          return result.catch(async (err: unknown) => {
            if (err instanceof AuthenticationError) {
              resetTinfoilClient()
              await getRawClient()
              const { fn: freshFn, thisArg: freshThis } =
                resolvePath(pathFromRoot)
              return freshFn.apply(freshThis, args)
            }
            throw err
          })
        }
        return result
      },
    })
  }

  return proxyWithRetry([]) as OpenAI
}
