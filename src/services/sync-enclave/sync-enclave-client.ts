import {
  SYNC_ENCLAVE_REPO,
  SYNC_ENCLAVE_TIMEOUTS,
  SYNC_ENCLAVE_URL,
} from '@/config'
import { authTokenManager } from '@/services/auth'
import { reportSyncPaused } from '@/services/cloud/sync-health'
import { logError, logInfo } from '@/utils/error-handling'
import { SecureClient } from 'tinfoil'
import { SYNC_HEADERS, SYNC_PROTOCOL_VERSION } from './wire-contract'

/**
 * Singleton wrapper around the TinfoilAI SDK's SecureClient pointed at
 * the sync enclave. The enclave is the only encryptor; the controlplane
 * only ever sees ciphertext from the enclave's perspective.
 *
 * Callers should:
 *   1. await `getSyncEnclaveClient()` to obtain the verified client.
 *   2. call `client.request(path, init)` to make attested HTTP requests
 *      with the user's Clerk JWT injected.
 */

let clientPromise: Promise<SyncEnclaveClient> | null = null
const activeOperationControllers = new Set<AbortController>()
export type SyncEnclaveRequestScope = 'cloud-sync'
const requestScopeControllers = new Map<
  SyncEnclaveRequestScope,
  AbortController
>()
const SYNC_ENCLAVE_REQUIRED_PROTOCOL = 'https:'
const ABSOLUTE_URL_PROTOCOL_PATTERN = /^[a-z][a-z\d+\-.]*:/i

export class SyncEnclaveError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly code?: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'SyncEnclaveError'
  }
}

export class SyncPersistentAuthError extends SyncEnclaveError {
  constructor(options?: ErrorOptions) {
    super(
      'Authentication is required to continue syncing',
      401,
      'AUTH_PERSISTENT',
    )
    this.name = 'SyncPersistentAuthError'
    if (options?.cause !== undefined) this.cause = options.cause
  }
}

export class SyncNetworkError extends SyncEnclaveError {
  constructor(options?: ErrorOptions) {
    super(
      'Sync enclave request failed due to a network error',
      undefined,
      'NETWORK',
    )
    this.name = 'SyncNetworkError'
    if (options?.cause !== undefined) this.cause = options.cause
  }
}

export class SyncRequestTimeoutError extends SyncNetworkError {
  constructor(options?: ErrorOptions) {
    super(options)
    this.name = 'SyncRequestTimeoutError'
  }
}

export class SyncAttestationTimeoutError extends SyncNetworkError {
  constructor(options?: ErrorOptions) {
    super(options)
    this.name = 'SyncAttestationTimeoutError'
  }
}

export class SyncRequestAbortedError extends Error {
  constructor(options?: ErrorOptions) {
    super('Sync enclave request was canceled', options)
    this.name = 'SyncRequestAbortedError'
  }
}

type SyncRequestInit = Omit<RequestInit, 'body'> & {
  body?: string
  skipAuth?: boolean
  requestScope?: SyncEnclaveRequestScope
}

type SyncRequestOptions = Pick<SyncRequestInit, 'requestScope' | 'signal'>

export class SyncEnclaveClient {
  private constructor(private readonly secure: SecureClient) {}

  /**
   * Lazily constructs and verifies the SecureClient pointed at the sync
   * enclave. Attestation runs once per page load; subsequent calls
   * return the cached verified client. Transient attestation/network
   * errors are retried by SecureClient internally.
   */
  static async create(): Promise<SyncEnclaveClient> {
    assertSecureSyncEnclaveUrl(SYNC_ENCLAVE_URL)
    const secure = new SecureClient({
      enclaveURL: SYNC_ENCLAVE_URL,
      configRepo: SYNC_ENCLAVE_REPO,
    })
    await runBoundedOperation(
      () => secure.ready(),
      SYNC_ENCLAVE_TIMEOUTS.READY_MS,
      () => new SyncAttestationTimeoutError(),
    )
    logInfo('sync enclave verified', {
      component: 'sync-enclave-client',
      action: 'create',
      metadata: {
        enclaveURL: SYNC_ENCLAVE_URL,
        configRepo: SYNC_ENCLAVE_REPO,
      },
    })
    return new SyncEnclaveClient(secure)
  }

  /**
   * Returns the underlying verification document so the UI can render a
   * trust badge consistent with the chat enclave.
   */
  get verification() {
    return this.secure.getVerificationDocument()
  }

  /**
   * Makes an attested HTTP request to the sync enclave. Automatically
   * injects the user's Clerk JWT and JSON Content-Type when a body is
   * present. Request bodies are reusable strings so a 401 can replay
   * the same options once after refreshing authentication. Throws
   * SyncEnclaveError on non-2xx responses with the parsed
   * `{error, code, ...details}` envelope.
   */
  async request<T = unknown>(
    path: string,
    init: SyncRequestInit = {},
  ): Promise<T> {
    assertRelativeSyncEnclavePath(path)
    const {
      skipAuth: _skipAuth,
      signal: callerSignal,
      requestScope,
      ...fetchInit
    } = init
    const requestUrl = new URL(path, SYNC_ENCLAVE_URL).toString()
    const baseHeaders = new Headers(init.headers)
    if (init.skipAuth) baseHeaders.delete('Authorization')
    baseHeaders.set('Accept', 'application/json')
    baseHeaders.set(SYNC_HEADERS.SyncProtocol, SYNC_PROTOCOL_VERSION)
    if (init.body && !baseHeaders.has('Content-Type')) {
      baseHeaders.set('Content-Type', 'application/json')
    }

    return runBoundedOperation(
      async (signal) => {
        let token: string | null = null
        if (!init.skipAuth) {
          token = await settleWithSignal(
            authTokenManager.getValidToken(),
            signal,
          )
        }

        const send = async (authToken: string | null) => {
          const headers = new Headers(baseHeaders)
          if (authToken) headers.set('Authorization', `Bearer ${authToken}`)
          try {
            return await settleWithSignal(
              this.secure.fetch(requestUrl, {
                ...fetchInit,
                headers,
                signal,
              }),
              signal,
            )
          } catch (error) {
            if (signal.aborted) throw signal.reason
            if (error instanceof TypeError) {
              throw new SyncNetworkError({ cause: error })
            }
            throw error
          }
        }

        let resp = await send(token)
        if (!init.skipAuth && resp.status === 401) {
          token = await settleWithSignal(
            authTokenManager.refreshToken(token as string),
            signal,
          )
          resp = await send(token)
          if (resp.status === 401) {
            // A 401 that survives a token refresh is usually a server-side
            // condition (enclave JWKS staleness after a signing-key
            // rotation, clock skew) rather than a revoked session, so it
            // must never force a sign-out. Pause sync and surface it; the
            // periodic sync retries and clears the gate on success. A
            // genuinely ended Clerk session is detected by Clerk itself
            // and handled by the sign-out cleanup path.
            reportSyncPaused('auth')
            throw new SyncPersistentAuthError()
          }
        }

        if (!resp.ok) {
          let body: Record<string, unknown> = {}
          try {
            body = await settleWithSignal(resp.json(), signal)
          } catch (error) {
            if (signal.aborted) throw signal.reason
            // body is empty or non-JSON; treat as opaque error
          }
          const message =
            typeof body.error === 'string'
              ? body.error
              : typeof body.message === 'string'
                ? body.message
                : `sync enclave request failed: ${resp.status} ${resp.statusText}`
          const code =
            typeof body.code === 'string' ? body.code : `HTTP_${resp.status}`
          logError(`sync enclave request failed`, undefined, {
            component: 'sync-enclave-client',
            action: 'request',
            metadata: { path, status: resp.status, code },
          })
          throw new SyncEnclaveError(message, resp.status, code, body)
        }

        if (resp.status === 204) {
          return undefined as T
        }
        const contentType = resp.headers.get('content-type') || ''
        if (contentType.includes('application/json')) {
          return (await settleWithSignal(resp.json(), signal)) as T
        }
        return undefined as T
      },
      SYNC_ENCLAVE_TIMEOUTS.REQUEST_MS,
      () => new SyncRequestTimeoutError(),
      [callerSignal, requestScope ? getRequestScopeSignal(requestScope) : null],
    )
  }

  /**
   * Convenience helpers for the four HTTP verbs that always speak JSON
   * and parse the response. Use raw `request` when you need to set
   * non-JSON bodies or custom headers.
   */
  get<T>(path: string, headers?: Record<string, string>) {
    return this.request<T>(path, { method: 'GET', headers })
  }

  post<T>(
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
    options: SyncRequestOptions = {},
  ) {
    return this.request<T>(path, {
      method: 'POST',
      body: body !== undefined ? JSON.stringify(body) : undefined,
      headers,
      ...options,
    })
  }

  postPublic<T>(
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ) {
    return this.request<T>(path, {
      method: 'POST',
      body: body !== undefined ? JSON.stringify(body) : undefined,
      headers,
      skipAuth: true,
    })
  }

  put<T>(path: string, body?: unknown, headers?: Record<string, string>) {
    return this.request<T>(path, {
      method: 'PUT',
      body: body !== undefined ? JSON.stringify(body) : undefined,
      headers,
    })
  }

  delete<T>(path: string, headers?: Record<string, string>) {
    return this.request<T>(path, { method: 'DELETE', headers })
  }
}

function settleWithSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

async function runBoundedOperation<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  timeoutError: () => Error,
  callerSignals: Array<AbortSignal | null | undefined> = [],
): Promise<T> {
  const controller = new AbortController()
  const signalListeners = callerSignals
    .filter((signal): signal is AbortSignal => signal !== null && !!signal)
    .map((signal) => {
      const abortFromSignal = () =>
        controller.abort(signal.reason ?? new SyncRequestAbortedError())
      if (signal.aborted) abortFromSignal()
      else signal.addEventListener('abort', abortFromSignal, { once: true })
      return { signal, abortFromSignal }
    })

  activeOperationControllers.add(controller)
  const timer = setTimeout(() => controller.abort(timeoutError()), timeoutMs)
  try {
    if (controller.signal.aborted) throw controller.signal.reason
    return await settleWithSignal(
      operation(controller.signal),
      controller.signal,
    )
  } finally {
    clearTimeout(timer)
    for (const { signal, abortFromSignal } of signalListeners) {
      signal.removeEventListener('abort', abortFromSignal)
    }
    activeOperationControllers.delete(controller)
  }
}

function getRequestScopeSignal(scope: SyncEnclaveRequestScope): AbortSignal {
  let controller = requestScopeControllers.get(scope)
  if (!controller) {
    controller = new AbortController()
    requestScopeControllers.set(scope, controller)
  }
  return controller.signal
}

export function resetSyncEnclaveRequestScope(
  scope: SyncEnclaveRequestScope,
): void {
  requestScopeControllers.set(scope, new AbortController())
}

export function abortSyncEnclaveRequests(
  scope?: SyncEnclaveRequestScope,
): void {
  if (scope) {
    const controller = requestScopeControllers.get(scope)
    if (controller) {
      controller.abort(new SyncRequestAbortedError())
    } else {
      const abortedController = new AbortController()
      abortedController.abort(new SyncRequestAbortedError())
      requestScopeControllers.set(scope, abortedController)
    }
    return
  }
  for (const controller of activeOperationControllers) {
    controller.abort(new SyncRequestAbortedError())
  }
  requestScopeControllers.clear()
  clientPromise = null
}

function assertSecureSyncEnclaveUrl(enclaveURL: string): void {
  let parsed: URL
  try {
    parsed = new URL(enclaveURL)
  } catch {
    throw new SyncEnclaveError(
      'sync enclave URL must be an absolute HTTPS URL',
      undefined,
      'INVALID_SYNC_ENCLAVE_URL',
    )
  }

  if (parsed.protocol !== SYNC_ENCLAVE_REQUIRED_PROTOCOL || !parsed.hostname) {
    throw new SyncEnclaveError(
      'sync enclave URL must use HTTPS',
      undefined,
      'INVALID_SYNC_ENCLAVE_URL',
    )
  }
}

function assertRelativeSyncEnclavePath(path: string): void {
  let sameOrigin: boolean
  try {
    sameOrigin =
      new URL(path, SYNC_ENCLAVE_URL).origin ===
      new URL(SYNC_ENCLAVE_URL).origin
  } catch {
    sameOrigin = false
  }
  if (
    !path.startsWith('/') ||
    path.startsWith('//') ||
    ABSOLUTE_URL_PROTOCOL_PATTERN.test(path) ||
    !sameOrigin
  ) {
    throw new SyncEnclaveError(
      'sync enclave request path must be relative',
      undefined,
      'INVALID_SYNC_ENCLAVE_PATH',
    )
  }
}

/**
 * Returns the lazily-initialized sync enclave client. Concurrent
 * callers share a single in-flight verification promise. SecureClient.ready()
 * does not accept an AbortSignal or injectable fetch, so caller cancellation
 * only stops waiting; it never evicts or duplicates the cold-start attestation.
 */
export function getSyncEnclaveClient(
  signal?: AbortSignal,
): Promise<SyncEnclaveClient> {
  if (!clientPromise) {
    const pendingClient = SyncEnclaveClient.create()
    const trackedClient = pendingClient.catch((err) => {
      // Surface attestation failures to the UI and allow a retry on the
      // next call rather than caching a permanent rejection.
      if (clientPromise === trackedClient) {
        clientPromise = null
      }
      throw err
    })
    clientPromise = trackedClient
  }
  return signal ? settleWithSignal(clientPromise, signal) : clientPromise
}

/**
 * Test/utility hook that drops the cached client so the next call
 * re-verifies. Used by sign-out cleanup.
 */
export function resetSyncEnclaveClient(): void {
  abortSyncEnclaveRequests()
}
