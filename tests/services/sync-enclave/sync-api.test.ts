import { deriveOpHashKey } from '@/services/sync-enclave/operation-hash'
import { resetSyncEnclaveClient } from '@/services/sync-enclave/sync-enclave-client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Shared mocks for the underlying SDK + auth — same shape as the client test.
const mockReady = vi.fn().mockResolvedValue(undefined)
const mockFetch =
  vi.fn<(input: string, init?: RequestInit) => Promise<Response>>()

vi.mock('tinfoil', () => ({
  SecureClient: class {
    ready = mockReady
    fetch = mockFetch
    getVerificationDocument = () => ({})
  },
}))

vi.mock('@/services/auth', () => ({
  authTokenManager: {
    getValidToken: vi.fn().mockResolvedValue('test-jwt'),
  },
}))

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function lastRequest() {
  return mockFetch.mock.calls.at(-1)!
}

function lastHeaders(): Headers {
  return lastRequest()[1]?.headers as Headers
}

describe('sync-api', () => {
  beforeEach(() => {
    resetSyncEnclaveClient()
    mockFetch.mockReset()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('registerKey posts the hex key + bundle envelope', async () => {
    const api = await import('@/services/sync-enclave/sync-api')
    mockFetch.mockResolvedValueOnce(ok({ ok: true, key_id: 'aa'.repeat(16) }))
    const resp = await api.registerKey({
      keyIdHex: 'aa'.repeat(16),
      bundle: {
        credentialId: 'cred-1',
        kekIvHex: 'bb'.repeat(12),
        wrappedKeyHex: 'cc'.repeat(32),
        saltHex: 'dd'.repeat(16),
        info: 'tinfoil-chat-kek-v1',
      },
      startFresh: false,
    })
    expect(resp.ok).toBe(true)
    const [path, init] = lastRequest()
    expect(path).toBe('/api/keys')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(init!.body as string)).toEqual({
      key_id: 'aa'.repeat(16),
      bundle: {
        credential_id: 'cred-1',
        kek_iv: 'bb'.repeat(12),
        wrapped_key: 'cc'.repeat(32),
        salt: 'dd'.repeat(16),
        info: 'tinfoil-chat-kek-v1',
      },
      start_fresh: false,
      created_via: 'enclave_register',
    })
  })

  it('putProfile attaches all five enclave write headers', async () => {
    const api = await import('@/services/sync-enclave/sync-api')
    const opKey = await deriveOpHashKey(new Uint8Array(32).fill(0x42))
    mockFetch.mockResolvedValueOnce(
      ok({ ok: true, etag: '1', key_id: 'aa'.repeat(16) }),
    )
    await api.putProfile('payload', 'aa'.repeat(16), {
      ifMatch: 0,
      idempotencyKey: 'idem-1',
      opKey,
    })
    const headers = lastHeaders()
    expect(headers.get('X-Key-Id')).toBe('aa'.repeat(16))
    expect(headers.get('If-Match')).toBe('0')
    expect(headers.get('X-Idempotency-Key')).toBe('idem-1')
    expect(headers.get('X-Operation-Hash')).toMatch(/^[0-9a-f]{64}$/)
    expect(headers.get('X-Rewrap')).toBeNull()
  })

  it('putProfile sets X-Rewrap when rewrap=true', async () => {
    const api = await import('@/services/sync-enclave/sync-api')
    const opKey = await deriveOpHashKey(new Uint8Array(32).fill(0x42))
    mockFetch.mockResolvedValueOnce(
      ok({ ok: true, etag: '2', key_id: 'bb'.repeat(16) }),
    )
    await api.putProfile('payload', 'bb'.repeat(16), {
      ifMatch: 1,
      idempotencyKey: 'idem-2',
      opKey,
      rewrap: true,
    })
    expect(lastHeaders().get('X-Rewrap')).toBe('true')
  })

  it('putProfile op-hash is deterministic across retries with same inputs', async () => {
    const api = await import('@/services/sync-enclave/sync-api')
    const opKey = await deriveOpHashKey(new Uint8Array(32).fill(0x42))
    mockFetch.mockImplementation(async () =>
      ok({ ok: true, etag: '1', key_id: 'aa'.repeat(16) }),
    )
    await api.putProfile('payload', 'aa'.repeat(16), {
      ifMatch: 0,
      idempotencyKey: 'idem-1',
      opKey,
    })
    const first = lastHeaders().get('X-Operation-Hash')
    await api.putProfile('payload', 'aa'.repeat(16), {
      ifMatch: 0,
      idempotencyKey: 'idem-1',
      opKey,
    })
    const second = lastHeaders().get('X-Operation-Hash')
    expect(second).toBe(first)
  })

  it('putProfile op-hash changes when body changes', async () => {
    const api = await import('@/services/sync-enclave/sync-api')
    const opKey = await deriveOpHashKey(new Uint8Array(32).fill(0x42))
    mockFetch.mockImplementation(async () =>
      ok({ ok: true, etag: '1', key_id: 'aa'.repeat(16) }),
    )
    await api.putProfile('payload-a', 'aa'.repeat(16), {
      ifMatch: 0,
      idempotencyKey: 'idem-1',
      opKey,
    })
    const a = lastHeaders().get('X-Operation-Hash')
    await api.putProfile('payload-b', 'aa'.repeat(16), {
      ifMatch: 0,
      idempotencyKey: 'idem-1',
      opKey,
    })
    const b = lastHeaders().get('X-Operation-Hash')
    expect(a).not.toBe(b)
  })

  it('listStatus encodes scope into the query string', async () => {
    const api = await import('@/services/sync-enclave/sync-api')
    mockFetch.mockResolvedValueOnce(
      ok({ scope: 'chat', needs_migration: 0, migration_blocked: 0 }),
    )
    await api.listStatus('chat')
    expect(lastRequest()[0]).toBe('/api/sync/list-status?scope=chat')
  })

  it('listTombstones builds the URL with since + cursor', async () => {
    const api = await import('@/services/sync-enclave/sync-api')
    mockFetch.mockResolvedValueOnce(ok({ scope: 'project', items: [] }))
    await api.listTombstones('project', '2026-05-01T00:00:00Z', 'cur-1', 25)
    const [path] = lastRequest()
    expect(path).toContain('scope=project')
    expect(path).toContain('since=2026-05-01T00%3A00%3A00Z')
    expect(path).toContain('cursor_id=cur-1')
    expect(path).toContain('limit=25')
  })

  it('addBundle hits the kid-specific path', async () => {
    const api = await import('@/services/sync-enclave/sync-api')
    mockFetch.mockResolvedValueOnce(ok({ ok: true }))
    await api.addBundle('aa'.repeat(16), {
      credentialId: 'cred-2',
      kekIvHex: 'bb'.repeat(12),
      wrappedKeyHex: 'cc'.repeat(32),
      saltHex: 'dd'.repeat(16),
    })
    expect(lastRequest()[0]).toBe(`/api/keys/${'aa'.repeat(16)}/bundles`)
  })

  it('putProjectDocument addresses doc by URL not body', async () => {
    const api = await import('@/services/sync-enclave/sync-api')
    const opKey = await deriveOpHashKey(new Uint8Array(32).fill(0x42))
    mockFetch.mockResolvedValueOnce(
      ok({ ok: true, etag: '1', key_id: 'aa'.repeat(16) }),
    )
    await api.putProjectDocument(
      'proj-1',
      'doc-2',
      'payload',
      'aa'.repeat(16),
      {
        ifMatch: 0,
        idempotencyKey: 'idem-1',
        opKey,
      },
    )
    expect(lastRequest()[0]).toBe('/api/projects/proj-1/documents/doc-2')
  })
})
