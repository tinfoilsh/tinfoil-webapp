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
} = vi.hoisted(() => ({
  mockSecureClientConstructor: vi.fn(),
  mockReady: vi.fn(),
  mockFetch: vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(),
  mockGetVerificationDocument: vi.fn().mockReturnValue({
    configRepo: 'tinfoilsh/confidential-sync',
    enclaveHost: 'sync.tinfoil.sh',
    securityVerified: true,
  }),
}))

vi.mock('tinfoil', () => ({
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
    getValidToken: vi.fn().mockResolvedValue('test-jwt'),
  },
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
  })

  afterEach(() => {
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

  it('injects the Clerk JWT into outgoing requests', async () => {
    const { getSyncEnclaveClient } =
      await import('@/services/sync-enclave/sync-enclave-client')
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }))
    const client = await getSyncEnclaveClient()
    await client.get('/api/keys/current')
    const headers = mockFetch.mock.calls[0][1]?.headers as Headers
    expect(headers.get('Authorization')).toBe('Bearer test-jwt')
    expect(headers.get('Accept')).toBe('application/json')
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

  it('reuses the verified client across calls', async () => {
    const { getSyncEnclaveClient } =
      await import('@/services/sync-enclave/sync-enclave-client')
    mockFetch.mockResolvedValue(jsonResponse({ ok: true }))
    const c1 = await getSyncEnclaveClient()
    const c2 = await getSyncEnclaveClient()
    expect(c1).toBe(c2)
    expect(mockReady).toHaveBeenCalledTimes(1)
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

  it('exposes SyncEnclaveError as a real Error subclass', () => {
    const err = new SyncEnclaveError('boom', 409, 'CONFLICT', { foo: 'bar' })
    expect(err).toBeInstanceOf(Error)
    expect(err.status).toBe(409)
    expect(err.code).toBe('CONFLICT')
    expect(err.details).toEqual({ foo: 'bar' })
  })
})
