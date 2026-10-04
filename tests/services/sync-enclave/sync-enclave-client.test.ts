import {
  resetSyncEnclaveClient,
  SyncEnclaveError,
} from '@/services/sync-enclave/sync-enclave-client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the tinfoil SDK so tests don't try to verify a real enclave.
// vi.hoisted runs before vi.mock factory evaluation, which is the only
// safe place to declare variables that the factory closes over.
const {
  mockSecureClientConstructor,
  mockReady,
  mockFetch,
  mockGetVerificationDocument,
  mockGetValidToken,
  mockRefreshToken,
  mockReportSyncPaused,
} = vi.hoisted(() => ({
  mockSecureClientConstructor: vi.fn(),
  mockReady: vi.fn(),
  mockFetch: vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(),
  mockGetVerificationDocument: vi.fn().mockReturnValue({
    configRepo: 'tinfoilsh/confidential-sync',
    enclaveHost: 'sync.tinfoil.sh',
    securityVerified: true,
  }),
  mockGetValidToken: vi.fn().mockResolvedValue('test-jwt'),
  mockRefreshToken: vi.fn().mockResolvedValue('fresh-jwt'),
  mockReportSyncPaused: vi.fn(),
}))

vi.mock('tinfoil', () => ({
  AttestationError: class extends Error {},
  SecureClient: class {
    constructor(args?: unknown) {
      mockSecureClientConstructor(args)
    }

    ready = mockReady
    fetch = mockFetch
    getVerificationDocument = mockGetVerificationDocument
  },
}))

vi.mock('@/services/auth', () => ({
  authTokenManager: {
    getValidToken: mockGetValidToken,
    refreshToken: mockRefreshToken,
  },
}))

vi.mock('@/services/cloud/sync-health', () => ({
  reportSyncPaused: mockReportSyncPaused,
}))

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
}

describe('SyncEnclaveClient', () => {
  beforeEach(() => {
    resetSyncEnclaveClient()
    mockSecureClientConstructor.mockReset()
    mockReady.mockReset().mockResolvedValue(undefined)
    mockFetch.mockReset()
    mockGetValidToken.mockReset().mockResolvedValue('test-jwt')
    mockRefreshToken.mockReset().mockResolvedValue('fresh-jwt')
    mockReportSyncPaused.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
    vi.doUnmock('@/config')
    vi.resetModules()
  })

  it('verifies attestation before issuing the first request', async () => {
    const { getSyncEnclaveClient } =
      await import('@/services/sync-enclave/sync-enclave-client')
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }))
    const client = await getSyncEnclaveClient()
    await client.get('/api/keys/current')
    expect(mockReady).toHaveBeenCalledTimes(1)
    expect(mockFetch).toHaveBeenCalledOnce()
  })

  it('constructs SecureClient with the HTTPS sync enclave config', async () => {
    const { getSyncEnclaveClient } =
      await import('@/services/sync-enclave/sync-enclave-client')
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }))
    const client = await getSyncEnclaveClient()
    await client.get('/api/keys/current')
    expect(mockSecureClientConstructor).toHaveBeenCalledWith({
      enclaveURL: 'https://sync.tinfoil.sh',
      configRepo: 'tinfoilsh/confidential-sync',
    })
  })

  it('rejects non-HTTPS sync enclave URLs before attestation', async () => {
    vi.resetModules()
    vi.doMock('@/config', () => ({
      SYNC_ENCLAVE_URL: 'http://sync.tinfoil.sh',
      SYNC_ENCLAVE_REPO: 'tinfoilsh/confidential-sync',
      SYNC_ENCLAVE_TIMEOUTS: { READY_MS: 30000, REQUEST_MS: 30000 },
    }))
    const { getSyncEnclaveClient } =
      await import('@/services/sync-enclave/sync-enclave-client')
    await expect(getSyncEnclaveClient()).rejects.toMatchObject({
      name: 'SyncEnclaveError',
      code: 'INVALID_SYNC_ENCLAVE_URL',
    })
    expect(mockReady).not.toHaveBeenCalled()
  })

  it('rejects absolute request URLs so calls stay on the verified enclave', async () => {
    const { getSyncEnclaveClient } =
      await import('@/services/sync-enclave/sync-enclave-client')
    const client = await getSyncEnclaveClient()
    await expect(
      client.get('https://example.com/v1/health'),
    ).rejects.toMatchObject({
      name: 'SyncEnclaveError',
      code: 'INVALID_SYNC_ENCLAVE_PATH',
    })
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it.each([
    'https://example.com/v1/health',
    'HTTPS://example.com/v1/health',
    '//example.com/v1/health',
    'javascript:alert(1)',
    'data:application/json,{}',
    'v1/health',
    '',
  ])('rejects enclave path escape attempt %j', async (path) => {
    const { getSyncEnclaveClient } =
      await import('@/services/sync-enclave/sync-enclave-client')
    const client = await getSyncEnclaveClient()

    await expect(client.get(path)).rejects.toMatchObject({
      name: 'SyncEnclaveError',
      code: 'INVALID_SYNC_ENCLAVE_PATH',
    })
    expect(mockGetValidToken).not.toHaveBeenCalled()
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('injects the Clerk JWT into outgoing requests', async () => {
    const { getSyncEnclaveClient } =
      await import('@/services/sync-enclave/sync-enclave-client')
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }))
    const client = await getSyncEnclaveClient()
    await client.get('/api/keys/current')
    const headers = mockFetch.mock.calls[0][1]?.headers as Headers
    expect(headers.get('Authorization')).toBe('Bearer test-jwt')
    expect(headers.get('Accept')).toBe('application/json')
    expect(headers.get('X-Sync-Protocol')).toBe('3')
  })

  it('overwrites a caller-supplied authorization header with the current JWT', async () => {
    const { getSyncEnclaveClient } =
      await import('@/services/sync-enclave/sync-enclave-client')
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }))
    const client = await getSyncEnclaveClient()

    await client.request('/v1/key/current', {
      method: 'POST',
      headers: { Authorization: 'Bearer attacker-controlled-token' },
      body: '{}',
    })

    const headers = mockFetch.mock.calls[0][1]?.headers as Headers
    expect(headers.get('Authorization')).toBe('Bearer test-jwt')
    expect(headers.get('Content-Type')).toBe('application/json')
  })

  it('can issue public enclave requests without a JWT', async () => {
    const { getSyncEnclaveClient } =
      await import('@/services/sync-enclave/sync-enclave-client')
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }))
    const client = await getSyncEnclaveClient()
    await client.postPublic('/v1/share/open', { ciphertext: 'abc' })
    const headers = mockFetch.mock.calls[0][1]?.headers as Headers
    expect(headers.has('Authorization')).toBe(false)
    expect(headers.get('Accept')).toBe('application/json')
    expect(mockRefreshToken).not.toHaveBeenCalled()
  })

  it('does not refresh authentication for public 401 responses', async () => {
    const { getSyncEnclaveClient } =
      await import('@/services/sync-enclave/sync-enclave-client')
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ code: 'AUTH' }, { status: 401 }),
    )
    const client = await getSyncEnclaveClient()

    await expect(
      client.postPublic('/v1/share/open', { ciphertext: 'abc' }),
    ).rejects.toMatchObject({ status: 401 })
    expect(mockRefreshToken).not.toHaveBeenCalled()
    expect(mockFetch).toHaveBeenCalledOnce()
  })

  it('honors a pre-aborted caller signal before token lookup or transport', async () => {
    const { getSyncEnclaveClient } =
      await import('@/services/sync-enclave/sync-enclave-client')
    const client = await getSyncEnclaveClient()
    const controller = new AbortController()
    const reason = new Error('account changed')
    controller.abort(reason)

    await expect(
      client.request('/v1/sync/pull', { signal: controller.signal }),
    ).rejects.toBe(reason)
    expect(mockGetValidToken).not.toHaveBeenCalled()
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('cancels while authentication is pending without sending a request', async () => {
    const { getSyncEnclaveClient, SyncRequestAbortedError } =
      await import('@/services/sync-enclave/sync-enclave-client')
    mockGetValidToken.mockReturnValueOnce(new Promise(() => {}))
    const client = await getSyncEnclaveClient()
    const controller = new AbortController()
    const request = client.request('/v1/sync/pull', {
      signal: controller.signal,
    })
    await vi.waitFor(() => expect(mockGetValidToken).toHaveBeenCalledOnce())

    controller.abort(new SyncRequestAbortedError())

    await expect(request).rejects.toMatchObject({
      name: 'SyncRequestAbortedError',
    })
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('force-refreshes after one 401 and replays the identical request once', async () => {
    const { getSyncEnclaveClient } =
      await import('@/services/sync-enclave/sync-enclave-client')
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ code: 'AUTH' }, { status: 401 }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
    const client = await getSyncEnclaveClient()
    const body = JSON.stringify({ ciphertext: 'same-body' })
    await client.request('/v1/blobs/push', {
      method: 'POST',
      body,
      headers: { 'Idempotency-Key': 'same-key' },
    })

    expect(mockRefreshToken).toHaveBeenCalledWith('test-jwt')
    expect(mockFetch).toHaveBeenCalledTimes(2)
    const firstInit = mockFetch.mock.calls[0][1]
    const secondInit = mockFetch.mock.calls[1][1]
    expect(secondInit?.body).toBe(firstInit?.body)
    expect((secondInit?.headers as Headers).get('Idempotency-Key')).toBe(
      'same-key',
    )
    expect((secondInit?.headers as Headers).get('Authorization')).toBe(
      'Bearer fresh-jwt',
    )
  })

  it('pauses sync instead of signing out after a replayed 401', async () => {
    const { getSyncEnclaveClient } =
      await import('@/services/sync-enclave/sync-enclave-client')
    mockFetch.mockResolvedValue(jsonResponse({ code: 'AUTH' }, { status: 401 }))
    const client = await getSyncEnclaveClient()

    await expect(client.get('/api/keys/current')).rejects.toMatchObject({
      name: 'SyncPersistentAuthError',
      code: 'AUTH_PERSISTENT',
      status: 401,
    })
    expect(mockFetch).toHaveBeenCalledTimes(2)
    expect(mockReportSyncPaused).toHaveBeenCalledWith('auth')
  })

  it('does not pause sync when forced refresh fails before replay', async () => {
    const { getSyncEnclaveClient } =
      await import('@/services/sync-enclave/sync-enclave-client')
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ code: 'AUTH' }, { status: 401 }),
    )
    mockRefreshToken.mockRejectedValueOnce(new Error('refresh failed'))
    const client = await getSyncEnclaveClient()

    await expect(client.get('/api/keys/current')).rejects.toThrow(
      'refresh failed',
    )
    expect(mockFetch).toHaveBeenCalledOnce()
    expect(mockReportSyncPaused).not.toHaveBeenCalled()
  })

  it('parses non-2xx responses into SyncEnclaveError with code + details', async () => {
    const { getSyncEnclaveClient } =
      await import('@/services/sync-enclave/sync-enclave-client')
    mockFetch.mockResolvedValueOnce(
      jsonResponse(
        {
          error: 'STALE_BLOB',
          code: 'PRECONDITION_FAILED',
          current_etag: '7',
        },
        { status: 412 },
      ),
    )
    const client = await getSyncEnclaveClient()
    await expect(
      client.put('/api/profile/', { data: 'x' }),
    ).rejects.toMatchObject({
      name: 'SyncEnclaveError',
      status: 412,
      code: 'PRECONDITION_FAILED',
      details: { current_etag: '7' },
    })
  })

  it('uses an opaque HTTP error when the enclave returns a malformed body', async () => {
    const { getSyncEnclaveClient } =
      await import('@/services/sync-enclave/sync-enclave-client')
    mockFetch.mockResolvedValueOnce(
      new Response('not-json', {
        status: 502,
        statusText: 'Bad Gateway',
        headers: { 'Content-Type': 'text/plain' },
      }),
    )
    const client = await getSyncEnclaveClient()

    await expect(client.get('/v1/key/current')).rejects.toMatchObject({
      name: 'SyncEnclaveError',
      status: 502,
      code: 'HTTP_502',
      message: 'sync enclave request failed: 502 Bad Gateway',
      details: {},
    })
  })

  it('rejects malformed JSON on a successful JSON response', async () => {
    const { getSyncEnclaveClient } =
      await import('@/services/sync-enclave/sync-enclave-client')
    mockFetch.mockResolvedValueOnce(
      new Response('{"truncated":', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    const client = await getSyncEnclaveClient()

    await expect(client.get('/v1/key/current')).rejects.toBeInstanceOf(
      SyntaxError,
    )
  })

  it('does not parse empty or non-JSON success responses', async () => {
    const { getSyncEnclaveClient } =
      await import('@/services/sync-enclave/sync-enclave-client')
    mockFetch
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        new Response('{"ignored":true}', {
          status: 200,
          headers: { 'Content-Type': 'text/plain' },
        }),
      )
    const client = await getSyncEnclaveClient()

    await expect(client.get('/v1/empty')).resolves.toBeUndefined()
    await expect(client.get('/v1/non-json')).resolves.toBeUndefined()
  })

  it('classifies transport TypeErrors without hiding non-network failures', async () => {
    const { getSyncEnclaveClient } =
      await import('@/services/sync-enclave/sync-enclave-client')
    mockFetch
      .mockRejectedValueOnce(new TypeError('connection reset'))
      .mockRejectedValueOnce(new RangeError('sdk invariant failed'))
    const client = await getSyncEnclaveClient()

    await expect(client.get('/v1/health')).rejects.toMatchObject({
      name: 'SyncNetworkError',
      code: 'NETWORK',
      cause: expect.any(TypeError),
    })
    await expect(client.get('/v1/health')).rejects.toMatchObject({
      name: 'RangeError',
      message: 'sdk invariant failed',
    })
  })

  it('reuses the verified client across calls', async () => {
    const { getSyncEnclaveClient } =
      await import('@/services/sync-enclave/sync-enclave-client')
    mockFetch.mockResolvedValue(jsonResponse({ ok: true }))
    const c1 = await getSyncEnclaveClient()
    const c2 = await getSyncEnclaveClient()
    expect(c1).toBe(c2)
    expect(mockReady).toHaveBeenCalledTimes(1)
  })

  it('shares one non-cancelable cold start across canceled callers', async () => {
    let resolveReady: () => void = () => {}
    mockReady.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveReady = resolve
      }),
    )
    const { getSyncEnclaveClient } =
      await import('@/services/sync-enclave/sync-enclave-client')

    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController()
      const client = getSyncEnclaveClient(controller.signal)
      controller.abort()
      await expect(client).rejects.toMatchObject({ name: 'AbortError' })
    }
    expect(mockReady).toHaveBeenCalledOnce()
    expect(mockSecureClientConstructor).toHaveBeenCalledOnce()

    resolveReady()
    await expect(getSyncEnclaveClient()).resolves.toBeDefined()
    expect(mockReady).toHaveBeenCalledOnce()
    expect(mockSecureClientConstructor).toHaveBeenCalledOnce()
  })

  it('drops the cache when verification fails so the next call can retry', async () => {
    const { getSyncEnclaveClient } =
      await import('@/services/sync-enclave/sync-enclave-client')
    mockReady.mockRejectedValueOnce(new Error('attestation failed'))
    await expect(getSyncEnclaveClient()).rejects.toThrow('attestation failed')
    mockReady.mockResolvedValueOnce(undefined)
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }))
    const client = await getSyncEnclaveClient()
    expect(client).toBeDefined()
  })

  it('bounds hung attestation and allows a fresh client retry', async () => {
    vi.useFakeTimers()
    vi.resetModules()
    vi.doMock('@/config', () => ({
      SYNC_ENCLAVE_URL: 'https://sync.tinfoil.sh',
      SYNC_ENCLAVE_REPO: 'tinfoilsh/confidential-sync',
      SYNC_ENCLAVE_TIMEOUTS: { READY_MS: 25, REQUEST_MS: 25 },
    }))
    mockReady.mockReturnValueOnce(new Promise(() => {}))
    const { getSyncEnclaveClient } =
      await import('@/services/sync-enclave/sync-enclave-client')

    const timedOut = getSyncEnclaveClient()
    const assertion = expect(timedOut).rejects.toMatchObject({
      name: 'SyncAttestationTimeoutError',
      code: 'NETWORK',
    })
    await vi.advanceTimersByTimeAsync(25)
    await assertion

    mockReady.mockResolvedValueOnce(undefined)
    await expect(getSyncEnclaveClient()).resolves.toBeDefined()
    expect(mockSecureClientConstructor).toHaveBeenCalledTimes(2)
  })

  it('aborts a hung fetch when the overall request budget expires', async () => {
    vi.useFakeTimers()
    vi.resetModules()
    vi.doMock('@/config', () => ({
      SYNC_ENCLAVE_URL: 'https://sync.tinfoil.sh',
      SYNC_ENCLAVE_REPO: 'tinfoilsh/confidential-sync',
      SYNC_ENCLAVE_TIMEOUTS: { READY_MS: 25, REQUEST_MS: 25 },
    }))
    let requestSignal: AbortSignal | null | undefined
    mockFetch.mockImplementationOnce((_input, init) => {
      requestSignal = init?.signal
      return new Promise(() => {})
    })
    const { getSyncEnclaveClient } =
      await import('@/services/sync-enclave/sync-enclave-client')
    const client = await getSyncEnclaveClient()

    const request = client.get('/api/keys/current')
    const assertion = expect(request).rejects.toMatchObject({
      name: 'SyncRequestTimeoutError',
      code: 'NETWORK',
    })
    await vi.advanceTimersByTimeAsync(25)
    await assertion
    expect(requestSignal?.aborted).toBe(true)
    expect(requestSignal?.reason).toMatchObject({
      name: 'SyncRequestTimeoutError',
    })
  })

  it('uses one overall budget for authentication refresh and replay', async () => {
    vi.useFakeTimers()
    vi.resetModules()
    vi.doMock('@/config', () => ({
      SYNC_ENCLAVE_URL: 'https://sync.tinfoil.sh',
      SYNC_ENCLAVE_REPO: 'tinfoilsh/confidential-sync',
      SYNC_ENCLAVE_TIMEOUTS: { READY_MS: 25, REQUEST_MS: 25 },
    }))
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ code: 'AUTH' }, { status: 401 }),
    )
    mockRefreshToken.mockReturnValueOnce(new Promise(() => {}))
    const { getSyncEnclaveClient } =
      await import('@/services/sync-enclave/sync-enclave-client')
    const client = await getSyncEnclaveClient()

    const request = client.get('/api/keys/current')
    const assertion = expect(request).rejects.toMatchObject({
      name: 'SyncRequestTimeoutError',
    })
    await vi.advanceTimersByTimeAsync(25)
    await assertion
    expect(mockFetch).toHaveBeenCalledOnce()
  })

  it('cleans up request timers after a successful response', async () => {
    vi.useFakeTimers()
    const { getSyncEnclaveClient } =
      await import('@/services/sync-enclave/sync-enclave-client')
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }))
    const client = await getSyncEnclaveClient()

    await client.get('/api/keys/current')

    expect(vi.getTimerCount()).toBe(0)
  })

  it('aborts active requests during synchronization cleanup', async () => {
    let requestSignal: AbortSignal | null | undefined
    mockFetch.mockImplementationOnce((_input, init) => {
      requestSignal = init?.signal
      return new Promise(() => {})
    })
    const { abortSyncEnclaveRequests, getSyncEnclaveClient } =
      await import('@/services/sync-enclave/sync-enclave-client')
    const client = await getSyncEnclaveClient()
    const request = client.get('/api/keys/current')
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledOnce())

    abortSyncEnclaveRequests()

    await expect(request).rejects.toMatchObject({
      name: 'SyncRequestAbortedError',
    })
    expect(requestSignal?.aborted).toBe(true)
  })

  it('keeps public requests alive when cloud sync requests are canceled', async () => {
    let cloudSignal: AbortSignal | null | undefined
    let publicSignal: AbortSignal | null | undefined
    let resolvePublic!: (response: Response) => void
    mockFetch.mockImplementation((input, init) => {
      if (input.includes('/v1/share/open')) {
        publicSignal = init?.signal
        return new Promise<Response>((resolve) => {
          resolvePublic = resolve
        })
      }
      cloudSignal = init?.signal
      return new Promise(() => {})
    })
    const { abortSyncEnclaveRequests, getSyncEnclaveClient } =
      await import('@/services/sync-enclave/sync-enclave-client')
    const client = await getSyncEnclaveClient()
    const cloudRequest = client.post('/v1/sync/pull', {}, undefined, {
      requestScope: 'cloud-sync',
    })
    const cloudAssertion = expect(cloudRequest).rejects.toMatchObject({
      name: 'SyncRequestAbortedError',
    })
    const publicRequest = client.postPublic('/v1/share/open', {})
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2))

    abortSyncEnclaveRequests('cloud-sync')

    await cloudAssertion
    expect(cloudSignal?.aborted).toBe(true)
    expect(publicSignal?.aborted).toBe(false)
    resolvePublic(jsonResponse({ ok: true }))
    await expect(publicRequest).resolves.toEqual({ ok: true })
  })

  it('keeps an aborted request scope closed until it is explicitly reset', async () => {
    const {
      abortSyncEnclaveRequests,
      getSyncEnclaveClient,
      resetSyncEnclaveRequestScope,
    } = await import('@/services/sync-enclave/sync-enclave-client')
    const client = await getSyncEnclaveClient()
    abortSyncEnclaveRequests('cloud-sync')

    await expect(
      client.post('/v1/sync/pull', {}, undefined, {
        requestScope: 'cloud-sync',
      }),
    ).rejects.toMatchObject({ name: 'SyncRequestAbortedError' })
    expect(mockFetch).not.toHaveBeenCalled()

    resetSyncEnclaveRequestScope('cloud-sync')
    mockFetch.mockResolvedValueOnce(jsonResponse({ items: [] }))
    await expect(
      client.post('/v1/sync/pull', {}, undefined, {
        requestScope: 'cloud-sync',
      }),
    ).resolves.toEqual({ items: [] })
    expect(mockFetch).toHaveBeenCalledOnce()
  })

  it('does not let canceled initialization evict a fresh client', async () => {
    mockReady
      .mockReturnValueOnce(new Promise(() => {}))
      .mockResolvedValueOnce(undefined)
    const { abortSyncEnclaveRequests, getSyncEnclaveClient } =
      await import('@/services/sync-enclave/sync-enclave-client')
    const canceledClient = getSyncEnclaveClient()

    abortSyncEnclaveRequests()
    const freshClient = getSyncEnclaveClient()

    await expect(canceledClient).rejects.toMatchObject({
      name: 'SyncRequestAbortedError',
    })
    await expect(freshClient).resolves.toBeDefined()
    expect(getSyncEnclaveClient()).toBe(freshClient)
    expect(mockSecureClientConstructor).toHaveBeenCalledTimes(2)
  })

  it('exposes SyncEnclaveError as a real Error subclass', () => {
    const err = new SyncEnclaveError('boom', 409, 'CONFLICT', { foo: 'bar' })
    expect(err).toBeInstanceOf(Error)
    expect(err.status).toBe(409)
    expect(err.code).toBe('CONFLICT')
    expect(err.details).toEqual({ foo: 'bar' })
  })
})
