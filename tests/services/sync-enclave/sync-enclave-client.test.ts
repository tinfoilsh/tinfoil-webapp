import {
  resetSyncEnclaveClient,
  SyncEnclaveError,
} from '@/services/sync-enclave/sync-enclave-client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the tinfoil SDK so tests don't try to verify a real enclave.
const mockReady = vi.fn()
const mockFetch =
  vi.fn<(input: string, init?: RequestInit) => Promise<Response>>()
const mockGetVerificationDocument = vi.fn().mockReturnValue({
  configRepo: 'tinfoilsh/confidential-sync-enclave',
  enclaveHost: 'sync.tinfoil.sh',
  securityVerified: true,
})

vi.mock('tinfoil', () => ({
  SecureClient: class {
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
    mockReady.mockReset().mockResolvedValue(undefined)
    mockFetch.mockReset()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('verifies attestation before issuing the first request', async () => {
    const { getSyncEnclaveClient } = await import(
      '@/services/sync-enclave/sync-enclave-client'
    )
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }))
    const client = await getSyncEnclaveClient()
    await client.get('/api/keys/current')
    expect(mockReady).toHaveBeenCalledTimes(1)
    expect(mockFetch).toHaveBeenCalledOnce()
  })

  it('injects the Clerk JWT into outgoing requests', async () => {
    const { getSyncEnclaveClient } = await import(
      '@/services/sync-enclave/sync-enclave-client'
    )
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }))
    const client = await getSyncEnclaveClient()
    await client.get('/api/keys/current')
    const headers = mockFetch.mock.calls[0][1]?.headers as Headers
    expect(headers.get('Authorization')).toBe('Bearer test-jwt')
    expect(headers.get('Accept')).toBe('application/json')
  })

  it('parses non-2xx responses into SyncEnclaveError with code + details', async () => {
    const { getSyncEnclaveClient } = await import(
      '@/services/sync-enclave/sync-enclave-client'
    )
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
    const { getSyncEnclaveClient } = await import(
      '@/services/sync-enclave/sync-enclave-client'
    )
    mockFetch.mockResolvedValue(jsonResponse({ ok: true }))
    const c1 = await getSyncEnclaveClient()
    const c2 = await getSyncEnclaveClient()
    expect(c1).toBe(c2)
    expect(mockReady).toHaveBeenCalledTimes(1)
  })

  it('drops the cache when verification fails so the next call can retry', async () => {
    const { getSyncEnclaveClient } = await import(
      '@/services/sync-enclave/sync-enclave-client'
    )
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
