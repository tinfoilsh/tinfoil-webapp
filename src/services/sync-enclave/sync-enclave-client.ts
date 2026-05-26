import { SYNC_ENCLAVE_REPO, SYNC_ENCLAVE_URL } from '@/config'
import { authTokenManager } from '@/services/auth'
import { logError, logInfo } from '@/utils/error-handling'
import { SecureClient } from 'tinfoil'

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
    await secure.ready()
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
   * present. Throws SyncEnclaveError on non-2xx responses with the
   * parsed `{error, code, ...details}` envelope.
   */
  async request<T = unknown>(
    path: string,
    init: RequestInit & { skipAuth?: boolean } = {},
  ): Promise<T> {
    assertRelativeSyncEnclavePath(path)
    const headers = new Headers(init.headers)
    headers.set('Accept', 'application/json')

    if (!init.skipAuth) {
      const token = await authTokenManager.getValidToken()
      headers.set('Authorization', `Bearer ${token}`)
    }

    if (init.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json')
    }

    const { skipAuth: _skipAuth, ...fetchInit } = init
    const resp = await this.secure.fetch(
      new URL(path, SYNC_ENCLAVE_URL).toString(),
      {
        ...fetchInit,
        headers,
      },
    )

    if (!resp.ok) {
      let body: Record<string, unknown> = {}
      try {
        body = await resp.json()
      } catch {
        // body is empty or non-JSON; treat as opaque error
      }
      const message =
        typeof body.error === 'string'
          ? body.error
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
      return (await resp.json()) as T
    }
    return undefined as T
  }

  /**
   * Convenience helpers for the four HTTP verbs that always speak JSON
   * and parse the response. Use raw `request` when you need to set
   * non-JSON bodies or custom headers.
   */
  get<T>(path: string, headers?: Record<string, string>) {
    return this.request<T>(path, { method: 'GET', headers })
  }

  post<T>(path: string, body?: unknown, headers?: Record<string, string>) {
    return this.request<T>(path, {
      method: 'POST',
      body: body !== undefined ? JSON.stringify(body) : undefined,
      headers,
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
  if (
    !path.startsWith('/') ||
    path.startsWith('//') ||
    ABSOLUTE_URL_PROTOCOL_PATTERN.test(path)
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
 * callers share a single in-flight verification promise.
 */
export function getSyncEnclaveClient(): Promise<SyncEnclaveClient> {
  if (!clientPromise) {
    clientPromise = SyncEnclaveClient.create().catch((err) => {
      // Surface attestation failures to the UI and allow a retry on the
      // next call rather than caching a permanent rejection.
      clientPromise = null
      throw err
    })
  }
  return clientPromise
}

/**
 * Test/utility hook that drops the cached client so the next call
 * re-verifies. Used by sign-out cleanup.
 */
export function resetSyncEnclaveClient(): void {
  clientPromise = null
}
