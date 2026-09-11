import { resetSyncEnclaveClient } from '@/services/sync-enclave/sync-enclave-client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// vi.mock factories are hoisted above module-scope consts; vi.hoisted
// guarantees the shared mock state exists when the factory runs.
const { mockReady, mockFetch } = vi.hoisted(() => ({
  mockReady: vi.fn().mockResolvedValue(undefined),
  mockFetch: vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(),
}))

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

function ok(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
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

function lastHeaders(): Headers {
  const [, init] = lastRequest()
  return init?.headers as Headers
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
    expect(lastBody()).toEqual({
      scope: 'chat',
      id: 'chat-1',
      key: api.hexToB64('aa'.repeat(32)),
      plaintext: api.bytesToBase64(plaintext),
      if_match: null,
      idempotency_key: 'idem-1',
    })
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

  it('normalizes nil pull pages and pullOne handles empty results', async () => {
    const api = await import('@/services/sync-enclave/sync-api')
    mockFetch.mockResolvedValueOnce(ok({ items: null, next_cursor: 'next' }))

    const page = await api.pull({
      scope: 'chat',
      all: true,
      cursor: 'cursor',
      limit: 25,
      keys: [{ key: 'key-1', key_id: 'hint-1' }],
    })

    expect(page).toEqual({ items: [], next_cursor: 'next' })
    expect(lastBody()).toEqual({
      scope: 'chat',
      all: true,
      cursor: 'cursor',
      limit: 25,
      keys: [{ key: 'key-1', key_id: 'hint-1' }],
    })

    mockFetch.mockResolvedValueOnce(ok({ items: null }))
    await expect(
      api.pullOne('chat', 'missing', [{ key: 'key-1' }]),
    ).resolves.toBeNull()
    expect(lastBody()).toEqual({
      scope: 'chat',
      ids: ['missing'],
      keys: [{ key: 'key-1' }],
    })
  })

  it('preserves lazy-rewrap metadata without applying backup rules to general pulls', async () => {
    const api = await import('@/services/sync-enclave/sync-api')
    mockFetch.mockResolvedValueOnce(
      ok({
        items: [
          {
            id: 'chat-1',
            ok: true,
            etag: 'rewrapped-etag',
            previous_etag: 'previous-etag',
            plaintext: '',
          },
        ],
      }),
    )

    const response = await api.pull({
      scope: 'chat',
      ids: ['chat-1'],
      keys: [{ key: 'key-1' }],
    })

    expect(response.items[0]).toMatchObject({
      etag: 'rewrapped-etag',
      previous_etag: 'previous-etag',
    })
  })

  it('validates and returns a strict one-shot backup inventory', async () => {
    const api = await import('@/services/sync-enclave/sync-api')
    const response = {
      captured_at: '2026-08-20T12:00:03.000Z',
      total_items: 3,
      items: [
        {
          scope: 'chat',
          id: 'chat-1',
          etag: 'opaque/chat-etag',
          project_id: 'project-1',
          created_at: '2026-08-20T12:00:00.000Z',
          updated_at: '2026-08-20T12:00:01.000Z',
        },
        {
          scope: 'project',
          id: 'project-1',
          etag: 'opaque-project-etag',
          created_at: '2026-08-20T12:00:00.000Z',
          updated_at: '2026-08-20T12:00:01.000Z',
        },
        {
          scope: 'project_document',
          id: 'document-1',
          etag: 'opaque-document-etag',
          project_id: 'project-1',
          created_at: '2026-08-20T12:00:00.000Z',
          updated_at: '2026-08-20T12:00:02.000Z',
        },
      ],
    }
    mockFetch.mockResolvedValueOnce(ok(response))

    await expect(api.backupInventory()).resolves.toEqual(response)
    expect(lastRequest()[0]).toBe('/v1/sync/backup-inventory')
    expect(lastBody()).toEqual({})
  })

  it.each([
    ['invalid_total', { total_items: 2 }],
    ['invalid_timestamp', { captured_at: 'not-a-timestamp' }],
    ['malformed_response', { unexpected: true }],
  ] as const)(
    'rejects backup inventory root contract violations as %s',
    async (code, replacement) => {
      const api = await import('@/services/sync-enclave/sync-api')
      mockFetch.mockResolvedValueOnce(
        ok({
          captured_at: '2026-08-20T12:00:00.000Z',
          total_items: 0,
          items: [],
          ...replacement,
        }),
      )

      await expect(api.backupInventory()).rejects.toMatchObject({ code })
    },
  )

  it.each([
    ['unsupported_scope', { scope: 'profile' }],
    ['missing_id', { id: '' }],
    ['missing_etag', { etag: '' }],
    ['invalid_timestamp', { updated_at: 'yesterday' }],
    ['invalid_relationship', { scope: 'project_document' }],
    ['invalid_relationship', { scope: 'project', project_id: 'project-1' }],
    ['invalid_relationship', { project_id: 'missing-project' }],
  ] as const)(
    'rejects backup inventory item contract violations as %s',
    async (code, replacement) => {
      const api = await import('@/services/sync-enclave/sync-api')
      const candidate: Record<string, unknown> = {
        scope: 'chat',
        id: 'chat-1',
        etag: 'opaque-etag',
        created_at: '2026-08-20T12:00:00.000Z',
        updated_at: '2026-08-20T12:00:00.000Z',
        ...replacement,
      }
      if ('scope' in replacement && replacement.scope === 'project_document') {
        delete candidate.project_id
      }
      mockFetch.mockResolvedValueOnce(
        ok({
          captured_at: '2026-08-20T12:00:00.000Z',
          total_items: 1,
          items: [candidate],
        }),
      )

      await expect(api.backupInventory()).rejects.toMatchObject({
        code,
        itemIndex: 0,
      })
    },
  )

  it.each([
    [
      'duplicate_item',
      [
        { scope: 'chat', id: 'chat-1' },
        { scope: 'chat', id: 'chat-1' },
      ],
    ],
    [
      'invalid_order',
      [
        { scope: 'project', id: 'project-1' },
        { scope: 'chat', id: 'chat-1' },
      ],
    ],
  ] as const)(
    'rejects inventory sequence violations as %s',
    async (code, identities) => {
      const api = await import('@/services/sync-enclave/sync-api')
      const items = identities.map(({ scope, id }) => ({
        scope,
        id,
        etag: 'opaque-etag',
        created_at: '2026-08-20T12:00:00.000Z',
        updated_at: '2026-08-20T12:00:00.000Z',
      }))
      mockFetch.mockResolvedValueOnce(
        ok({
          captured_at: '2026-08-20T12:00:00.000Z',
          total_items: items.length,
          items,
        }),
      )

      await expect(api.backupInventory()).rejects.toMatchObject({ code })
    },
  )

  it('listStatus posts /v1/sync/list-status with scope and project filter', async () => {
    const api = await import('@/services/sync-enclave/sync-api')
    mockFetch.mockResolvedValueOnce(ok({ updates: [], deletes: [] }))
    await api.listStatus({ scope: 'chat', projectId: 'proj_1' })
    expect(lastRequest()[0]).toBe('/v1/sync/list-status')
    const body = lastBody<{ scope: string; project_id: string }>()
    expect(body.scope).toBe('chat')
    expect(body.project_id).toBe('proj_1')
  })

  it('normalizes nil status arrays without dropping pagination fields', async () => {
    const api = await import('@/services/sync-enclave/sync-api')
    mockFetch.mockResolvedValueOnce(
      ok({ updates: null, deletes: null, next_cursor: 'next-page' }),
    )

    const page = await api.listStatus({
      scope: 'chat',
      cursor: 'current-page',
      limit: 50,
      direction: 'desc',
    })

    expect(page).toEqual({
      updates: [],
      deletes: [],
      next_cursor: 'next-page',
    })
    expect(lastBody()).toEqual({
      scope: 'chat',
      cursor: 'current-page',
      limit: 50,
      direction: 'desc',
    })
  })

  it('posts revision protocol requests with captured revision bounds', async () => {
    const api = await import('@/services/sync-enclave/sync-api')
    mockFetch.mockResolvedValueOnce(ok({ events: [], next_cursor: 'page-2' }))

    await api.revisionEvents({
      afterRevision: '10',
      throughRevision: '20',
      cursor: 'page-1',
      limit: 250,
    })

    expect(lastRequest()[0]).toBe('/v1/sync/revision-events')
    expect(lastBody()).toEqual({
      after_revision: '10',
      through_revision: '20',
      cursor: 'page-1',
      limit: 250,
    })
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

  it('deleteAllProjects posts the CEK and idempotency key', async () => {
    const api = await import('@/services/sync-enclave/sync-api')
    mockFetch.mockResolvedValueOnce(ok({ ok: true, deleted: 3 }))

    const response = await api.deleteAllProjects({
      keyB64: api.hexToB64('aa'.repeat(32)),
      idempotencyKey: 'delete-projects-1',
    })

    expect(response).toEqual({ ok: true, deleted: 3 })
    expect(lastRequest()[0]).toBe('/v1/sync/delete-all-projects')
    expect(lastBody()).toEqual({
      key: api.hexToB64('aa'.repeat(32)),
      idempotency_key: 'delete-projects-1',
    })
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

  it('removeBundle includes the key proof and idempotency key', async () => {
    const api = await import('@/services/sync-enclave/sync-api')
    mockFetch.mockResolvedValueOnce(ok({ ok: true }))

    await api.removeBundle({
      keyId: 'key-id',
      keyB64: 'key-b64',
      credentialId: 'credential-id',
      idempotencyKey: 'remove-idempotency',
    })

    expect(lastRequest()[0]).toBe('/v1/key/remove-bundle')
    expect(lastBody()).toEqual({
      key_id: 'key-id',
      key: 'key-b64',
      credential_id: 'credential-id',
      idempotency_key: 'remove-idempotency',
    })
  })

  it('normalizes keyCurrent nils and maps only 404 to an empty account', async () => {
    const api = await import('@/services/sync-enclave/sync-api')
    mockFetch.mockResolvedValueOnce(
      ok({ key_id: null, bundles: null, has_data: true }),
    )

    await expect(api.keyCurrent()).resolves.toEqual({
      key_id: null,
      bundles: {},
      has_data: true,
    })

    mockFetch.mockResolvedValueOnce(
      ok({ error: 'not found', code: 'NOT_FOUND' }, { status: 404 }),
    )
    await expect(api.keyCurrent()).resolves.toEqual({
      key_id: null,
      bundles: {},
      has_data: false,
    })

    mockFetch.mockResolvedValueOnce(
      ok({ error: 'forbidden', code: 'FORBIDDEN' }, { status: 403 }),
    )
    await expect(api.keyCurrent()).rejects.toMatchObject({
      status: 403,
      code: 'FORBIDDEN',
    })
  })

  it('forwards keyCurrent cancellation to the secure fetch', async () => {
    const api = await import('@/services/sync-enclave/sync-api')
    let requestSignal: AbortSignal | undefined
    mockFetch.mockImplementationOnce((_, init) => {
      requestSignal = init?.signal ?? undefined
      return new Promise((_, reject) => {
        requestSignal?.addEventListener(
          'abort',
          () => reject(requestSignal?.reason),
          { once: true },
        )
      })
    })
    const controller = new AbortController()

    const request = api.keyCurrent(controller.signal)
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledOnce())
    controller.abort()

    await expect(request).rejects.toMatchObject({ name: 'AbortError' })
    expect(requestSignal?.aborted).toBe(true)
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

  it('normalizes migration reports from kickoff and status polling', async () => {
    const api = await import('@/services/sync-enclave/sync-api')
    mockFetch.mockResolvedValueOnce(
      ok({
        migrated: 2,
        retryable_remaining: 1,
        blocked_unmigrated: 1,
        partial: true,
        status: 'running',
        scopes: [
          {
            scope: 'chat',
            migrated: 2,
            retryable_remaining: 1,
            blocked_unmigrated: 1,
            blocked: null,
          },
        ],
      }),
    )

    const kickoff = await api.migrateAll({
      keys: [{ key: 'legacy-key', key_id: 'legacy-id' }],
      target: { key: 'target-key' },
    })
    expect(kickoff.scopes[0].blocked).toEqual([])
    expect(lastRequest()[0]).toBe('/v1/blobs/migrate-all')
    expect(lastBody()).toEqual({
      keys: [{ key: 'legacy-key', key_id: 'legacy-id' }],
      target: { key: 'target-key' },
    })

    mockFetch.mockResolvedValueOnce(
      ok({
        migrated: 2,
        retryable_remaining: 0,
        blocked_unmigrated: 0,
        partial: false,
        status: 'completed',
        scopes: null,
      }),
    )
    const status = await api.migrateStatus()
    expect(status.scopes).toEqual([])
    expect(lastRequest()[0]).toBe('/v1/blobs/migrate-status')
    expect(lastBody()).toEqual({})
  })

  it('serializes every off-device import phase and normalizes nil errors', async () => {
    const api = await import('@/services/sync-enclave/sync-api')
    mockFetch.mockResolvedValueOnce(ok({ job_id: 'job-1', upload_id: 'up-1' }))
    await api.importCreate({
      source: 'chatgpt',
      totalBytes: 3,
      totalChunks: 1,
      archiveSha256: 'ab'.repeat(32),
    })
    expect(lastRequest()[0]).toBe('/v1/import/create')
    expect(lastBody()).toEqual({
      source: 'chatgpt',
      total_bytes: 3,
      total_chunks: 1,
      archive_sha256: 'ab'.repeat(32),
    })

    const chunk = new Uint8Array([0, 127, 255])
    mockFetch.mockResolvedValueOnce(ok({ ok: true }))
    await api.importUploadChunk({
      uploadId: 'up-1',
      chunkIndex: 0,
      chunkSha256: 'cd'.repeat(32),
      data: chunk,
    })
    expect(lastRequest()[0]).toBe('/v1/import/upload')
    expect(lastBody()).toEqual({
      upload_id: 'up-1',
      chunk_index: 0,
      chunk_sha256: 'cd'.repeat(32),
      data: api.bytesToBase64(chunk),
    })

    mockFetch.mockResolvedValueOnce(
      ok({ status: 'running', imported: 0, failed: 0, total: 2 }),
    )
    await api.importStart({ jobId: 'job-1', keyB64: 'key-b64' })
    expect(lastRequest()[0]).toBe('/v1/import/start')
    expect(lastBody()).toEqual({ job_id: 'job-1', key: 'key-b64' })

    mockFetch.mockResolvedValueOnce(
      ok({
        status: 'completed',
        imported: 2,
        failed: 0,
        total: 2,
        errors: null,
      }),
    )
    const status = await api.importStatus('job-1')
    expect(status.errors).toEqual([])
    expect(status.failure_reason).toBeUndefined()
    expect(lastRequest()[0]).toBe('/v1/import/status')
    expect(lastBody()).toEqual({ job_id: 'job-1' })

    mockFetch.mockResolvedValueOnce(
      ok({
        status: 'failed',
        imported: 1,
        failed: 0,
        total: 2,
        errors: ['import timed out'],
        failure_reason: 'timeout',
      }),
    )
    const failed = await api.importStatus('job-1')
    expect(failed.failure_reason).toBe('timeout')
    expect(failed.errors).toEqual(['import timed out'])
  })

  it('searchQuery posts /v1/search/query and normalizes null results', async () => {
    const api = await import('@/services/sync-enclave/sync-api')
    mockFetch.mockResolvedValueOnce(
      ok({ results: null, total_indexed: 3, needs_reindex: true }),
    )
    const resp = await api.searchQuery({
      keyB64: 'key-b64',
      query: 'duck pond',
      limit: 5,
    })
    expect(resp.results).toEqual([])
    expect(resp.total_indexed).toBe(3)
    expect(resp.needs_reindex).toBe(true)
    expect(lastRequest()[0]).toBe('/v1/search/query')
    const body = lastBody<{ key: string; query: string; limit: number }>()
    expect(body.key).toBe('key-b64')
    expect(body.query).toBe('duck pond')
    expect(body.limit).toBe(5)
  })

  it('searchReindex kicks the job and searchReindexStatus polls it', async () => {
    const api = await import('@/services/sync-enclave/sync-api')
    mockFetch.mockResolvedValueOnce(
      ok({
        job_id: 'job-1',
        status: 'running',
        indexed: 0,
        failed: 0,
        total_indexed: 0,
        partial: false,
      }),
    )
    const kicked = await api.searchReindex({ keys: [{ key: 'key-b64' }] })
    expect(kicked.status).toBe('running')
    expect(lastRequest()[0]).toBe('/v1/search/reindex')
    expect(lastBody<{ keys: Array<{ key: string }> }>().keys).toEqual([
      { key: 'key-b64' },
    ])

    mockFetch.mockResolvedValueOnce(
      ok({
        job_id: 'job-1',
        status: 'completed',
        indexed: 7,
        failed: 0,
        total_indexed: 7,
        partial: false,
      }),
    )
    const status = await api.searchReindexStatus()
    expect(status.status).toBe('completed')
    expect(status.indexed).toBe(7)
    expect(lastRequest()[0]).toBe('/v1/search/reindex-status')
  })

  it('round-trips private and public attachment bytes through distinct auth paths', async () => {
    const api = await import('@/services/sync-enclave/sync-api')
    const plaintext = new Uint8Array([0, 1, 2, 127, 128, 255])
    mockFetch.mockResolvedValueOnce(
      ok({ ok: true, plaintext: api.bytesToBase64(plaintext) }),
    )

    await expect(
      api.attachmentGet({ id: 'att-1', attKeyB64: 'attachment-key' }),
    ).resolves.toEqual(plaintext)
    expect(lastRequest()[0]).toBe('/v1/attachment/get')
    expect(lastBody()).toEqual({ id: 'att-1', att_key: 'attachment-key' })
    expect(lastHeaders().get('Authorization')).toBe('Bearer test-jwt')

    mockFetch.mockResolvedValueOnce(
      ok({ ok: true, plaintext: api.bytesToBase64(plaintext) }),
    )
    await expect(
      api.attachmentGetPublic({ id: 'att-1', attKeyB64: 'attachment-key' }),
    ).resolves.toEqual(plaintext)
    expect(lastRequest()[0]).toBe('/v1/attachment/get-public')
    expect(lastHeaders().has('Authorization')).toBe(false)

    mockFetch.mockResolvedValueOnce(ok({ ok: true }))
    await api.attachmentDelete({ id: 'att-1' })
    expect(lastRequest()[0]).toBe('/v1/attachment/delete')
    expect(lastBody()).toEqual({ id: 'att-1' })
  })

  it('seals authenticated shares and opens them without leaking a JWT', async () => {
    const api = await import('@/services/sync-enclave/sync-api')
    const plaintext = new Uint8Array([1, 3, 3, 7])
    mockFetch.mockResolvedValueOnce(
      ok({ ok: true, share_key: 'ab'.repeat(32), ciphertext: 'sealed' }),
    )

    await api.shareSeal({ plaintext })
    expect(lastRequest()[0]).toBe('/v1/share/seal')
    expect(lastBody()).toEqual({ plaintext: api.bytesToBase64(plaintext) })
    expect(lastHeaders().get('Authorization')).toBe('Bearer test-jwt')

    const opened = new Uint8Array([9, 8, 7])
    const ciphertext = new Uint8Array([4, 5, 6])
    mockFetch.mockResolvedValueOnce(
      ok({ ok: true, plaintext: api.bytesToBase64(opened) }),
    )
    await expect(
      api.shareOpen({ shareKeyHex: 'cd'.repeat(32), ciphertext }),
    ).resolves.toEqual(opened)
    expect(lastRequest()[0]).toBe('/v1/share/open')
    expect(lastBody()).toEqual({
      share_key: 'cd'.repeat(32),
      ciphertext: api.bytesToBase64(ciphertext),
    })
    expect(lastHeaders().has('Authorization')).toBe(false)
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
    expect(() => api.hexToB64('abc')).toThrow(/odd-length hex/)
    expect(() => api.hexToB64('zz')).toThrow(/invalid hex/)
    expect(() => api.hexToB64('0g')).toThrow(/invalid hex/)
    expect(() => api.base64ToBytes('%%%')).toThrow()

    const item = api.pullItemPlaintext({
      id: 'x',
      ok: true,
      plaintext: b64,
    })
    expect(item).toEqual(bytes)
    expect(
      api.pullItemPlaintext({ id: 'x', ok: false, code: 'NOT_FOUND' }),
    ).toBeNull()
    expect(api.pullItemPlaintext({ id: 'x', ok: true })).toBeNull()
    expect(api.pullItemPlaintext({ id: 'x', ok: true, plaintext: '' })).toEqual(
      new Uint8Array(),
    )
    expect(() =>
      api.pullItemPlaintext({ id: 'x', ok: true, plaintext: 'not base64!' }),
    ).toThrow()
  })

  it('generates well-formed, non-repeating idempotency keys', async () => {
    const api = await import('@/services/sync-enclave/sync-api')
    const keys = Array.from({ length: 2048 }, () => api.newIdempotencyKey())

    expect(new Set(keys).size).toBe(keys.length)
    for (const key of keys) {
      expect(key).toMatch(/^[0-9a-f]{32}$/)
    }
  })
})
