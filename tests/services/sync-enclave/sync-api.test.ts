import { resetSyncEnclaveClient } from '@/services/sync-enclave/sync-enclave-client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

function lastRequest(): [string, RequestInit | undefined] {
  const call = mockFetch.mock.calls.at(-1)!
  const urlArg = call[0]
  const url = typeof urlArg === 'string' ? urlArg : (urlArg as URL).toString()
  return [new URL(url).pathname, call[1]]
}

function lastBody<T = unknown>(): T {
  const [, init] = lastRequest()
  return JSON.parse(init!.body as string) as T
}

describe('sync-api (enclave JSON-RPC)', () => {
  beforeEach(() => {
    resetSyncEnclaveClient()
    mockFetch.mockReset()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('push posts to /v1/sync/push with base64 plaintext + CEK', async () => {
    const api = await import('@/services/sync-enclave/sync-api')
    mockFetch.mockResolvedValueOnce(
      ok({ ok: true, etag: '1', key_id: 'aa'.repeat(16) }),
    )
    const plaintext = new TextEncoder().encode('hello')
    const resp = await api.push({
      scope: 'chat',
      id: 'chat-1',
      keyB64: api.hexToB64('aa'.repeat(32)),
      plaintext,
      ifMatch: null,
      idempotencyKey: 'idem-1',
    })
    expect(resp.ok).toBe(true)
    const [path, init] = lastRequest()
    expect(path).toBe('/v1/sync/push')
    expect(init?.method).toBe('POST')
    const body = lastBody<{ plaintext: string; scope: string }>()
    expect(body.scope).toBe('chat')
    expect(body.plaintext).toBe(api.bytesToBase64(plaintext))
  })

  it('pull posts /v1/sync/pull with ids + keys array', async () => {
    const api = await import('@/services/sync-enclave/sync-api')
    mockFetch.mockResolvedValueOnce(ok({ items: [], next_cursor: '' }))
    await api.pull({
      scope: 'chat',
      ids: ['c1', 'c2'],
      keys: [{ key: api.hexToB64('aa'.repeat(32)) }],
    })
    expect(lastRequest()[0]).toBe('/v1/sync/pull')
    const body = lastBody<{ ids: string[]; keys: Array<{ key: string }> }>()
    expect(body.ids).toEqual(['c1', 'c2'])
    expect(body.keys).toHaveLength(1)
  })

  it('listStatus posts /v1/sync/list-status with scope and project filter', async () => {
    const api = await import('@/services/sync-enclave/sync-api')
    mockFetch.mockResolvedValueOnce(ok({ updates: [], deletes: [] }))
    await api.listStatus({ scope: 'chat', projectId: 'proj_1' })
    expect(lastRequest()[0]).toBe('/v1/sync/list-status')
    const body = lastBody<{ scope: string; project_id: string }>()
    expect(body.scope).toBe('chat')
    expect(body.project_id).toBe('proj_1')
  })

  it('deleteRow posts /v1/sync/delete with key + idempotency', async () => {
    const api = await import('@/services/sync-enclave/sync-api')
    mockFetch.mockResolvedValueOnce(ok({ ok: true }))
    await api.deleteRow({
      scope: 'chat',
      id: 'c1',
      ifMatch: '7',
      idempotencyKey: 'del-1',
      keyB64: api.hexToB64('aa'.repeat(32)),
    })
    expect(lastRequest()[0]).toBe('/v1/sync/delete')
    const body = lastBody<{ if_match: string; idempotency_key: string }>()
    expect(body.if_match).toBe('7')
    expect(body.idempotency_key).toBe('del-1')
  })

  it('attachmentPut posts idempotency key', async () => {
    const api = await import('@/services/sync-enclave/sync-api')
    mockFetch.mockResolvedValueOnce(
      ok({ ok: true, id: 'att-1', att_key: 'att-key' }),
    )
    await api.attachmentPut({
      chatId: 'chat-1',
      plaintext: new Uint8Array([1, 2, 3]),
      idempotencyKey: 'att-idem-1',
    })
    expect(lastRequest()[0]).toBe('/v1/attachment/put')
    const body = lastBody<{
      chat_id: string
      plaintext: string
      idempotency_key: string
    }>()
    expect(body.chat_id).toBe('chat-1')
    expect(body.plaintext).toBe(api.bytesToBase64(new Uint8Array([1, 2, 3])))
    expect(body.idempotency_key).toBe('att-idem-1')
  })

  it('registerKey posts /v1/key/register with initial bundle', async () => {
    const api = await import('@/services/sync-enclave/sync-api')
    mockFetch.mockResolvedValueOnce(ok({ ok: true, key_id: 'aa'.repeat(16) }))
    await api.registerKey({
      keyB64: api.hexToB64('aa'.repeat(32)),
      ifMatch: '*',
      createdVia: 'passkey',
      idempotencyKey: 'reg-1',
      initialBundle: {
        credentialId: 'cred-1',
        kekIvHex: 'bb'.repeat(12),
        encryptedKeysHex: 'cc'.repeat(32),
      },
    })
    expect(lastRequest()[0]).toBe('/v1/key/register')
    const body = lastBody<{
      initial_bundle: { credential_id: string; encrypted_keys: string }
    }>()
    expect(body.initial_bundle.credential_id).toBe('cred-1')
    expect(body.initial_bundle.encrypted_keys).toBe('cc'.repeat(32))
  })

  it('addBundle posts /v1/key/add-bundle', async () => {
    const api = await import('@/services/sync-enclave/sync-api')
    mockFetch.mockResolvedValueOnce(ok({ ok: true }))
    await api.addBundle({
      keyId: 'aa'.repeat(16),
      keyB64: api.hexToB64('aa'.repeat(32)),
      credentialId: 'cred-2',
      kekIvHex: 'bb'.repeat(12),
      encryptedKeysHex: 'cc'.repeat(32),
      idempotencyKey: 'idem-add-1',
    })
    expect(lastRequest()[0]).toBe('/v1/key/add-bundle')
    const body = lastBody<{
      key_id: string
      key: string
      credential_id: string
    }>()
    expect(body.key_id).toBe('aa'.repeat(16))
    expect(body.key).toBe(api.hexToB64('aa'.repeat(32)))
    expect(body.credential_id).toBe('cred-2')
  })

  it('migrate posts /v1/blobs/migrate with target key', async () => {
    const api = await import('@/services/sync-enclave/sync-api')
    mockFetch.mockResolvedValueOnce(
      ok({
        migrated: 1,
        retryable_remaining: 0,
        blocked_unmigrated: 0,
        blocked: [],
      }),
    )
    await api.migrate({
      scope: 'chat',
      keys: [{ key: api.hexToB64('aa'.repeat(32)) }],
      target: { key: api.hexToB64('bb'.repeat(32)) },
    })
    expect(lastRequest()[0]).toBe('/v1/blobs/migrate')
  })

  it('health hits GET /v1/health', async () => {
    const api = await import('@/services/sync-enclave/sync-api')
    mockFetch.mockResolvedValueOnce(ok({ status: 'ok' }))
    const resp = await api.health()
    expect(resp.status).toBe('ok')
    const [path, init] = lastRequest()
    expect(path).toBe('/v1/health')
    expect(init?.method).toBe('GET')
  })

  it('hexToB64 and pullItemPlaintext round-trip', async () => {
    const api = await import('@/services/sync-enclave/sync-api')
    const bytes = new Uint8Array([1, 2, 3, 4, 5])
    const b64 = api.bytesToBase64(bytes)
    expect(api.base64ToBytes(b64)).toEqual(bytes)
    expect(() => api.hexToB64('')).toThrow(/empty hex/)

    const item = api.pullItemPlaintext({
      id: 'x',
      ok: true,
      plaintext: b64,
    })
    expect(item).toEqual(bytes)
    expect(
      api.pullItemPlaintext({ id: 'x', ok: false, code: 'NOT_FOUND' }),
    ).toBeNull()
  })
})
