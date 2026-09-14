import { ChatError } from '@/components/chat/chat-utils'
import { API_BASE_URL, DEV_API_KEY, IS_DEV } from '@/config'
import { RATE_LIMIT_UPDATED_EVENT } from '@/constants/chat-events'
import { AUTH_ACTIVE_USER_ID } from '@/constants/storage-keys'
import { logError } from '@/utils/error-handling'
import {
  PERFORMANCE_METRICS,
  recordPerformanceDuration,
  startPerformanceTimer,
} from '@/utils/performance-metrics'
import {
  TINFOIL_EVENTS_HEADER,
  TINFOIL_EVENTS_VALUE_CODE_EXECUTION,
  TINFOIL_EVENTS_VALUE_WEB_SEARCH,
} from '@/utils/tinfoil-events'
import OpenAI from 'openai'
import {
  AuthenticationError,
  SecureClient,
  type SessionRecoveryToken,
  type VerificationDocument,
} from 'tinfoil'
import { authTokenManager } from '../auth'
import { INFERENCE_CLIENT_INITIALIZATION_TIMEOUT_MS } from './constants'

/** One dimension (input or output) of a token budget. */
export interface TokenBudget {
  max: number
  used: number
  remaining: number
}

export interface RateLimitInfo {
  maxRequests: number
  remaining: number
  inputTokens?: TokenBudget
  outputTokens?: TokenBudget
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
let initializationInFlight: InitializationTask | null = null
let cachedVerificationDocument: VerificationDocument | null = null
const MAX_IDLE_RECOVERABLE_TRANSPORTS = 1
let idleRecoverableTransports: RecoverableTinfoilTransport[] = []
let recoverableTransportPoolGeneration = 0

class SessionCacheInvalidatedError extends Error {}

export class TinfoilClientInitializationTimeoutError extends Error {
  constructor() {
    super('Tinfoil client initialization timed out')
    this.name = 'TinfoilClientInitializationTimeoutError'
  }
}

interface InitializedClient {
  client: OpenAI
  secureClient: SecureClient | null
}

interface InitializationTask {
  generation: number
  controller: AbortController
  timeoutId: ReturnType<typeof setTimeout>
  promise: Promise<void>
}

function abortInitialization(reason: unknown): void {
  const task = initializationInFlight
  if (!task) return
  initializationInFlight = null
  clearTimeout(task.timeoutId)
  task.controller.abort(reason)
}

function waitForSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)

  return new Promise<T>((resolve, reject) => {
    const handleAbort = () => reject(signal.reason)
    signal.addEventListener('abort', handleAbort, { once: true })
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', handleAbort)
    })
  })
}

function assertSessionCacheGeneration(cacheGeneration: number): void {
  if (cacheGeneration !== sessionCacheGeneration) {
    throw new SessionCacheInvalidatedError()
  }
}

function dispatchRateLimitUpdate(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(RATE_LIMIT_UPDATED_EVENT))
  }
}

/**
 * Subscribes to rate limit changes. Pairs with getRateLimitSnapshot for
 * useSyncExternalStore; the returned snapshot is only reallocated when the
 * cache actually changes so React can bail out of redundant renders.
 */
export function subscribeRateLimit(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  window.addEventListener(RATE_LIMIT_UPDATED_EVENT, listener)
  return () => {
    window.removeEventListener(RATE_LIMIT_UPDATED_EVENT, listener)
  }
}

type ServerErrorBody = {
  error?: string
  code?: string
  resets_at?: string
  rate_limit?: ServerRateLimitBody
}

type ServerRateLimitBody = {
  max_requests?: number
  remaining?: number
  max_input_tokens?: number
  input_tokens_used?: number
  input_tokens_remaining?: number
  max_output_tokens?: number
  output_tokens_used?: number
  output_tokens_remaining?: number
  resets_at?: string
}

function parseTokenBudget(
  max: unknown,
  used: unknown,
  remaining: unknown,
): TokenBudget | undefined {
  if (
    typeof max !== 'number' ||
    typeof used !== 'number' ||
    typeof remaining !== 'number' ||
    max <= 0
  ) {
    return undefined
  }
  return { max, used, remaining }
}

// Both token-minting endpoints report budgets in the same wire shape. The
// free-tier key carries a daily request quota; the subscriber JWT only has
// hourly token budgets, so its request fields are absent and default to a
// non-gating "unlimited" quota.
function parseRateLimit(
  body: ServerRateLimitBody,
  kind: NonNullable<RateLimitInfo['kind']>,
): RateLimitInfo {
  return {
    maxRequests: body.max_requests ?? Number.POSITIVE_INFINITY,
    remaining: body.remaining ?? Number.POSITIVE_INFINITY,
    inputTokens: parseTokenBudget(
      body.max_input_tokens,
      body.input_tokens_used,
      body.input_tokens_remaining,
    ),
    outputTokens: parseTokenBudget(
      body.max_output_tokens,
      body.output_tokens_used,
      body.output_tokens_remaining,
    ),
    resetsAt: body.resets_at ?? '',
    kind,
  }
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
// channel (so the banner renders) and throws a typed error the chat
// classifies as a rate limit rather than a generic failure. Never returns.
function surfaceHourlyLimit(parsedError: ServerErrorBody | null): never {
  const budget = parsedError?.rate_limit
    ? parseRateLimit(parsedError.rate_limit, 'hourly')
    : null
  cachedRateLimit = {
    maxRequests: 0,
    remaining: 0,
    inputTokens: budget?.inputTokens,
    outputTokens: budget?.outputTokens,
    resetsAt: parsedError?.resets_at ?? budget?.resetsAt ?? '',
    kind: 'hourly',
  }
  dispatchRateLimitUpdate()
  throw new ChatError(
    parsedError?.error ?? 'You have reached your hourly usage limit.',
    'HOURLY_LIMIT',
    { status: 429 },
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
  signal?: AbortSignal,
): Promise<{
  key: string
  expiresAt: number | null
  rateLimit: RateLimitInfo | null
} | null> {
  let response: Response
  try {
    response = await fetch(`${API_BASE_URL}/api/chat/token`, {
      headers: { Authorization: `Bearer ${authBearer}` },
      signal,
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
          rateLimit: data.rate_limit
            ? parseRateLimit(data.rate_limit, 'hourly')
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
    assertSessionCacheGeneration(cacheGeneration)
    surfaceHourlyLimit(parsedError)
  }
  return null
}

async function resolveAuthBearer(signal?: AbortSignal): Promise<string | null> {
  if (!authTokenManager.isInitialized()) return null
  try {
    const validToken = authTokenManager.getValidToken()
    return await (signal ? waitForSignal(validToken, signal) : validToken)
  } catch (error) {
    logError('Failed to get auth token, falling back to anonymous key', error, {
      component: 'tinfoil-client',
      action: 'fetchSessionToken',
    })
    return null
  }
}

async function fetchSessionTokenForGeneration(
  cacheGeneration: number,
  signal?: AbortSignal,
): Promise<string> {
  if (IS_DEV) {
    return DEV_API_KEY
  }

  assertSessionCacheGeneration(cacheGeneration)

  // If the user was previously signed in, wait for Clerk to initialize
  // the auth token manager before fetching — otherwise we'd get an
  // anonymous free-tier key that gets cached until expiry.
  if (
    !authTokenManager.isInitialized() &&
    typeof window !== 'undefined' &&
    localStorage.getItem(AUTH_ACTIVE_USER_ID) !== null
  ) {
    const authInitialization = authTokenManager.waitForInit(AUTH_INIT_WAIT_MS)
    await (signal
      ? waitForSignal(authInitialization, signal)
      : authInitialization)
  }

  // Resolve the auth bearer (if any) up front so the cache-validity
  // check and the actual request use the same authenticated/anonymous
  // decision.  This avoids a stale-cache loop when getValidToken()
  // intermittently fails for a signed-in user.
  const authBearer = await resolveAuthBearer(signal)
  assertSessionCacheGeneration(cacheGeneration)
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
    const jwt = await fetchChatJWT(authBearer, cacheGeneration, signal)
    assertSessionCacheGeneration(cacheGeneration)
    if (jwt !== null) {
      cachedSessionToken = jwt.key
      cachedSessionTokenWasAuthenticated = true
      cachedSessionTokenExpiresAt = jwt.expiresAt
      cachedRateLimit = jwt.rateLimit
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
    signal,
  })
  assertSessionCacheGeneration(cacheGeneration)

  if (!response.ok) {
    const errorText = await response.text()
    assertSessionCacheGeneration(cacheGeneration)
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
  assertSessionCacheGeneration(cacheGeneration)
  cachedSessionToken = data.key
  cachedSessionTokenWasAuthenticated = usedAuthHeader
  if (data.expires_at) {
    cachedSessionTokenExpiresAt = new Date(data.expires_at).getTime()
  }

  if (data.is_free_tier && data.rate_limit) {
    cachedRateLimit = parseRateLimit(data.rate_limit, 'free_daily')
  } else {
    cachedRateLimit = null
  }

  dispatchRateLimitUpdate()

  return data.key
}

async function fetchSessionToken(signal?: AbortSignal): Promise<string> {
  const startedAt = startPerformanceTimer()
  try {
    while (true) {
      try {
        return await fetchSessionTokenForGeneration(
          sessionCacheGeneration,
          signal,
        )
      } catch (error) {
        if (!(error instanceof SessionCacheInvalidatedError)) throw error
      }
    }
  } finally {
    recordPerformanceDuration(
      PERFORMANCE_METRICS.INFERENCE_SESSION_TOKEN,
      startedAt,
    )
  }
}

export function getRateLimitInfo(): RateLimitInfo | null {
  return cachedRateLimit ? { ...cachedRateLimit } : null
}

/**
 * Referentially stable view of the cached rate limit for
 * useSyncExternalStore. Every write replaces the cached object, so the
 * reference only changes when the data does.
 */
export function getRateLimitSnapshot(): Readonly<RateLimitInfo> | null {
  return cachedRateLimit
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
 * Drops the pending optimistic-decrement snapshot so the next
 * refreshRateLimit treats the server's count as authoritative. Called when
 * a request was rejected outright (e.g. a 429): the server never consumed
 * it, so reconciling against the snapshot would undercount by one.
 */
export function discardRateLimitSnapshot(): void {
  remainingBeforeRequest = null
}

// Re-reads a subscriber's hourly usage without touching the cached session
// JWT. Every mint returns a distinct JWT, and a changed session token makes
// ensureInitialized rebuild the OpenAI client and re-run attestation, so the
// usage refresh must not rotate the token the way the free-tier path does.
// If the read fails the usage simply stays stale until the next refresh; the
// JWT remains valid until its own expiry, at which point the regular mint
// path re-resolves the account's tier.
async function refreshHourlyUsage(cacheGeneration: number): Promise<void> {
  const authBearer = await resolveAuthBearer()
  assertSessionCacheGeneration(cacheGeneration)
  if (!authBearer) return
  const jwt = await fetchChatJWT(authBearer, cacheGeneration)
  assertSessionCacheGeneration(cacheGeneration)
  if (jwt === null) return
  cachedRateLimit = jwt.rateLimit
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
    try {
      if (cachedRateLimit?.kind === 'hourly') {
        await refreshHourlyUsage(refreshGeneration)
        return
      }
      cachedSessionToken = null
      cachedSessionTokenExpiresAt = null
      await fetchSessionTokenForGeneration(refreshGeneration)
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
      if (error instanceof SessionCacheInvalidatedError) return
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
  // Abort with the same retryable error as invalidateSessionCache so
  // concurrent waiters in ensureInitialized re-initialize against the new
  // generation instead of surfacing what downstream would classify as a
  // user abort.
  abortInitialization(new SessionCacheInvalidatedError())
  clientInstance = null
  secureClient = null
  lastSessionToken = null
  cachedSessionToken = null
  cachedSessionTokenExpiresAt = null
  cachedSessionTokenWasAuthenticated = false
  const hadRateLimit = cachedRateLimit !== null
  cachedRateLimit = null
  remainingBeforeRequest = null
  refreshInFlight = null
  cachedVerificationDocument = null
  idleRecoverableTransports = []
  recoverableTransportPoolGeneration++
  if (hadRateLimit) {
    dispatchRateLimitUpdate()
  }
}

export function invalidateSessionCache(): void {
  sessionCacheGeneration++
  abortInitialization(new SessionCacheInvalidatedError())
  refreshInFlight = null
  cachedSessionToken = null
  cachedSessionTokenExpiresAt = null
  cachedSessionTokenWasAuthenticated = false
  remainingBeforeRequest = null
  cachedVerificationDocument = null
  if (cachedRateLimit !== null) {
    cachedRateLimit = null
    dispatchRateLimitUpdate()
  }
}

async function initClient(
  sessionToken: string,
  signal: AbortSignal,
): Promise<InitializedClient> {
  try {
    if (IS_DEV) {
      return {
        secureClient: null,
        client: new OpenAI({
          apiKey: sessionToken,
          baseURL: `${window.location.origin}/api/local-router/v1`,
          dangerouslyAllowBrowser: true,
          defaultHeaders: {
            [TINFOIL_EVENTS_HEADER]: `${TINFOIL_EVENTS_VALUE_WEB_SEARCH},${TINFOIL_EVENTS_VALUE_CODE_EXECUTION}`,
          },
        }),
      }
    }

    const candidateSecureClient = new SecureClient({})
    const attestationStartedAt = startPerformanceTimer()
    await waitForSignal(candidateSecureClient.ready(), signal)
    recordPerformanceDuration(
      PERFORMANCE_METRICS.INFERENCE_ATTESTATION,
      attestationStartedAt,
    )
    return {
      secureClient: candidateSecureClient,
      client: new OpenAI({
        apiKey: sessionToken,
        baseURL: candidateSecureClient.getBaseURL(),
        dangerouslyAllowBrowser: true,
        // Opt into the router's inline progress-marker stream.
        defaultHeaders: {
          [TINFOIL_EVENTS_HEADER]: `${TINFOIL_EVENTS_VALUE_WEB_SEARCH},${TINFOIL_EVENTS_VALUE_CODE_EXECUTION}`,
        },
        fetch: candidateSecureClient.fetch,
      }),
    }
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

export interface RecoverableTinfoilClient {
  client: OpenAI
  baseURL: string
  waitForTokenCapture: () => Promise<void>
}

export interface RecoverableTinfoilTransport {
  secureClient: SecureClient
  baseURL: string
}

export interface RecoverableTinfoilTransportLease {
  transport: RecoverableTinfoilTransport
  release: () => void
}

export function isChatRecoveryAvailable(): boolean {
  return !IS_DEV
}

function controlplaneBaseURL(): string {
  const configured =
    API_BASE_URL ||
    (typeof window !== 'undefined' ? window.location.origin : null)
  if (!configured) {
    throw new Error('Controlplane base URL is unavailable')
  }
  const parsed = new URL(configured)
  if (parsed.protocol !== 'https:' || !parsed.hostname) {
    throw new Error('Controlplane base URL must use HTTPS')
  }
  return configured
}

export async function createRecoverableTinfoilTransport(): Promise<RecoverableTinfoilTransport> {
  if (IS_DEV) {
    throw new Error('Chat recovery is unavailable in local development')
  }
  const baseURL = new URL('/v1/', controlplaneBaseURL()).toString()
  const dedicatedSecureClient = new SecureClient({ baseURL })
  const attestationStartedAt = startPerformanceTimer()
  await dedicatedSecureClient.ready()
  recordPerformanceDuration(
    PERFORMANCE_METRICS.INFERENCE_ATTESTATION,
    attestationStartedAt,
  )
  return { secureClient: dedicatedSecureClient, baseURL }
}

export async function acquireRecoverableTinfoilTransport(): Promise<RecoverableTinfoilTransportLease> {
  const generation = recoverableTransportPoolGeneration
  const transport =
    idleRecoverableTransports.pop() ??
    (await createRecoverableTinfoilTransport())
  let released = false

  return {
    transport,
    release: () => {
      if (released) return
      released = true
      if (
        generation === recoverableTransportPoolGeneration &&
        idleRecoverableTransports.length < MAX_IDLE_RECOVERABLE_TRANSPORTS
      ) {
        idleRecoverableTransports.push(transport)
      }
    },
  }
}

export async function createRecoverableTinfoilClient(
  transport: RecoverableTinfoilTransport,
  sessionId: string,
  onTokenCaptured: (token: SessionRecoveryToken) => Promise<void>,
): Promise<RecoverableTinfoilClient> {
  if (IS_DEV) {
    throw new Error('Chat recovery is unavailable in local development')
  }

  const sessionToken = await fetchSessionToken()
  let tokenCapturePromise: Promise<void> | null = null
  const recoverableFetch: typeof fetch = async (input, init) => {
    const response = await transport.secureClient.fetch(input, init)
    const token = await transport.secureClient.getSessionRecoveryToken()
    tokenCapturePromise = onTokenCaptured(token)
    void tokenCapturePromise.catch(() => undefined)
    return response
  }

  return {
    baseURL: transport.baseURL,
    waitForTokenCapture: () => {
      if (!tokenCapturePromise) {
        return Promise.reject(
          new Error('Recovery token capture did not start with the request'),
        )
      }
      return tokenCapturePromise
    },
    client: new OpenAI({
      apiKey: sessionToken,
      baseURL: transport.baseURL,
      dangerouslyAllowBrowser: true,
      // Suppressed at the factory level (unlike initClient's shared client,
      // where callers scope it per-request): this client is single-use for
      // one recovery attempt. recoverableFetch captures a recovery token
      // bound to this client's X-Session-Id, so an SDK-internal silent
      // retry would reuse the session id and fire onTokenCaptured twice
      // for the same attempt. Retries happen in sendChatStream's loop,
      // which builds a fresh client (and session id) per attempt.
      maxRetries: 0,
      defaultHeaders: {
        [TINFOIL_EVENTS_HEADER]: `${TINFOIL_EVENTS_VALUE_WEB_SEARCH},${TINFOIL_EVENTS_VALUE_CODE_EXECUTION}`,
        'X-Session-Id': sessionId,
      },
      fetch: recoverableFetch,
    }),
  }
}

export function getRecoveryBaseURL(): string {
  return controlplaneBaseURL()
}

/**
 * Lazily build the OpenAI client (and SecureClient on prod) the first
 * time anything needs them, and rebuild on session-token rotation.
 */
async function ensureInitialized(): Promise<void> {
  while (true) {
    const generation = sessionCacheGeneration
    let task = initializationInFlight

    if (!task || task.generation !== generation) {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => {
        controller.abort(new TinfoilClientInitializationTimeoutError())
      }, INFERENCE_CLIENT_INITIALIZATION_TIMEOUT_MS)
      const promise = (async () => {
        const sessionToken = await fetchSessionTokenForGeneration(
          generation,
          controller.signal,
        )
        assertSessionCacheGeneration(generation)
        if (clientInstance && lastSessionToken === sessionToken) return

        const initialized = await initClient(sessionToken, controller.signal)
        assertSessionCacheGeneration(generation)
        clientInstance = initialized.client
        secureClient = initialized.secureClient
        lastSessionToken = sessionToken
      })()
      task = { generation, controller, timeoutId, promise }
      initializationInFlight = task
    }

    try {
      await task.promise
      return
    } catch (error) {
      if (error instanceof SessionCacheInvalidatedError) continue
      throw error
    } finally {
      if (initializationInFlight === task) {
        clearTimeout(task.timeoutId)
        initializationInFlight = null
      }
    }
  }
}

/**
 * Returns the enclave verification document, or `null` in dev mode
 */
export async function getVerificationDocument(): Promise<VerificationDocument | null> {
  await ensureInitialized()
  const document = secureClient ? secureClient.getVerificationDocument() : null
  if (document) {
    cachedVerificationDocument = document
  }
  return document
}

export function getCachedVerificationDocument(): VerificationDocument | null {
  return cachedVerificationDocument
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
