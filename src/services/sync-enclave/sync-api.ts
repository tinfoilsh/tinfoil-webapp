import { getSyncEnclaveClient, SyncEnclaveError } from './sync-enclave-client'

/**
 * Typed API surface for the sync enclave. The enclave proxies most
 * endpoints to the controlplane after applying per-user encryption /
 * decryption; from the web client's point of view this is the only
 * service that touches plaintext.
 *
 * Every write through the enclave path carries:
 *   - X-Key-Id            : the user's current key (hex, 16 bytes)
 *   - If-Match            : the etag the client believes the row is at
 *   - X-Idempotency-Key   : caller-chosen idempotency token
 *   - X-Operation-Hash    : SHA-256 of the request body (hex)
 *   - X-Rewrap            : "true" when the caller is intentionally
 *                            re-keying the row under a new key_id
 *
 * The controlplane (via the enclave) returns:
 *   - 200 with { ok, etag, key_id } on success
 *   - 412 PRECONDITION_FAILED with { current_etag } on stale If-Match
 *   - 409 CONFLICT (STALE_KEY) with { current_key_id } on key mismatch
 *   - 409 CONFLICT (EXISTING_DATA_UNDER_OTHER_KEY) on register-key with
 *         pre-existing data tagged under a different key
 */

export type Scope = 'profile' | 'chat' | 'project' | 'project_document'

export interface BundleBody {
  credentialId: string
  /** 12-byte AES-GCM IV, hex-encoded. */
  kekIvHex: string
  /** Wrapped CEK ciphertext, hex-encoded. */
  wrappedKeyHex: string
  /** Salt used by HKDF over the PRF output. */
  saltHex: string
  /** Free-form descriptor (e.g. PRF info string). */
  info?: string
}

export interface RegisterKeyRequest {
  /** 16-byte key id, hex-encoded. */
  keyIdHex: string
  bundle: BundleBody
  /**
   * If true, instructs the controlplane to register this key even when
   * the user already has data tagged under another key. The enclave
   * will adopt the new key going forward; legacy rows are left for
   * Phase 4 opportunistic migration.
   */
  startFresh?: boolean
  /** Origin label persisted on user_keys.created_via. */
  createdVia?:
    | 'enclave_register'
    | 'passkey_recovery'
    | 'manual_entry'
    | 'legacy_import'
}

export interface RegisterKeyResponse {
  ok: true
  key_id: string
}

export interface CurrentKeyResponse {
  key_id: string | null
  bundles: Array<{
    credential_id: string
    kek_iv: string
    wrapped_key: string
    salt: string
    info: string
    created_at: string
  }>
}

export interface WriteOptions {
  /**
   * The etag the caller believes the row is currently at. Use 0 for a
   * create (or the first enclave write over a legacy row).
   */
  ifMatch: number
  /** Caller-chosen idempotency token (must be unique per logical op). */
  idempotencyKey: string
  /**
   * SHA-256 of the request body, hex-encoded. The enclave verifies this
   * server-side so any retry MUST present the same hash to replay the
   * stored response.
   */
  operationHashHex: string
  /**
   * Set to true when the caller is intentionally re-keying a row under
   * a different key (the only path that bypasses the STALE_KEY check).
   */
  rewrap?: boolean
}

export interface WriteResponse {
  ok: true
  etag: string
  key_id: string
}

export interface ListStatusResponse {
  scope: Scope
  needs_migration: number
  migration_blocked: number
  current_etag?: string
  current_key_id?: string
}

export interface NeedsMigrationResponse {
  scope: Scope
  ids?: string[]
  items?: Array<{ id: string; project_id: string }>
}

export interface TombstonesResponse {
  scope: Scope
  items: Array<{
    id: string
    parent_id?: string
    deleted_at: string
  }>
}

function writeHeaders(
  keyIdHex: string,
  opts: WriteOptions,
): Record<string, string> {
  const headers: Record<string, string> = {
    'X-Key-Id': keyIdHex,
    'If-Match': String(opts.ifMatch),
    'X-Idempotency-Key': opts.idempotencyKey,
    'X-Operation-Hash': opts.operationHashHex,
  }
  if (opts.rewrap) {
    headers['X-Rewrap'] = 'true'
  }
  return headers
}

/* -------------------------------------------------------------------------- */
/*  Key registry                                                              */
/* -------------------------------------------------------------------------- */

export async function registerKey(
  req: RegisterKeyRequest,
): Promise<RegisterKeyResponse> {
  const client = await getSyncEnclaveClient()
  return client.post<RegisterKeyResponse>('/api/keys', {
    key_id: req.keyIdHex,
    bundle: {
      credential_id: req.bundle.credentialId,
      kek_iv: req.bundle.kekIvHex,
      wrapped_key: req.bundle.wrappedKeyHex,
      salt: req.bundle.saltHex,
      info: req.bundle.info ?? '',
    },
    start_fresh: req.startFresh ?? false,
    created_via: req.createdVia ?? 'enclave_register',
  })
}

export async function addBundle(
  keyIdHex: string,
  bundle: BundleBody,
): Promise<{ ok: true }> {
  const client = await getSyncEnclaveClient()
  return client.post<{ ok: true }>(
    `/api/keys/${encodeURIComponent(keyIdHex)}/bundles`,
    {
      credential_id: bundle.credentialId,
      kek_iv: bundle.kekIvHex,
      wrapped_key: bundle.wrappedKeyHex,
      salt: bundle.saltHex,
      info: bundle.info ?? '',
    },
  )
}

export async function getCurrentKey(): Promise<CurrentKeyResponse> {
  const client = await getSyncEnclaveClient()
  return client.get<CurrentKeyResponse>('/api/keys/current')
}

/* -------------------------------------------------------------------------- */
/*  Blob writes (enclave does the encryption)                                 */
/* -------------------------------------------------------------------------- */

export async function putProfile(
  data: string,
  keyIdHex: string,
  opts: WriteOptions,
): Promise<WriteResponse> {
  const client = await getSyncEnclaveClient()
  return client.put<WriteResponse>(
    '/api/profile/',
    { data },
    writeHeaders(keyIdHex, opts),
  )
}

export async function putChat(
  conversationId: string,
  body: Uint8Array,
  keyIdHex: string,
  opts: WriteOptions,
  extra?: { projectId?: string; messageCount?: number },
): Promise<WriteResponse> {
  const client = await getSyncEnclaveClient()
  const headers = writeHeaders(keyIdHex, opts)
  headers['Content-Type'] = 'application/octet-stream'
  if (extra?.projectId) headers['X-Project-Id'] = extra.projectId
  if (typeof extra?.messageCount === 'number') {
    headers['X-Message-Count'] = String(extra.messageCount)
  }
  return client.request<WriteResponse>(
    `/api/storage/conversation/${encodeURIComponent(conversationId)}/data`,
    { method: 'PUT', body: body as unknown as BodyInit, headers },
  )
}

export async function putProject(
  projectId: string,
  data: string,
  keyIdHex: string,
  opts: WriteOptions,
): Promise<WriteResponse> {
  const client = await getSyncEnclaveClient()
  return client.put<WriteResponse>(
    `/api/projects/${encodeURIComponent(projectId)}`,
    { projectId, data },
    writeHeaders(keyIdHex, opts),
  )
}

export async function putProjectDocument(
  projectId: string,
  documentId: string,
  data: string,
  keyIdHex: string,
  opts: WriteOptions,
): Promise<WriteResponse> {
  const client = await getSyncEnclaveClient()
  return client.put<WriteResponse>(
    `/api/projects/${encodeURIComponent(projectId)}/documents/${encodeURIComponent(documentId)}`,
    { documentId, data },
    writeHeaders(keyIdHex, opts),
  )
}

/* -------------------------------------------------------------------------- */
/*  Blob reads                                                                */
/* -------------------------------------------------------------------------- */

export async function getProfile(): Promise<{
  data: string
  etag: string
  key_id: string | null
} | null> {
  const client = await getSyncEnclaveClient()
  try {
    return await client.get('/api/profile/')
  } catch (err) {
    if (err instanceof SyncEnclaveError && err.status === 404) return null
    throw err
  }
}

export async function getChat(
  conversationId: string,
): Promise<ArrayBuffer | null> {
  const client = await getSyncEnclaveClient()
  try {
    return await client.request<ArrayBuffer>(
      `/api/storage/conversation/${encodeURIComponent(conversationId)}`,
      { method: 'GET' },
    )
  } catch (err) {
    if (err instanceof SyncEnclaveError && err.status === 404) return null
    throw err
  }
}

export async function deleteChat(conversationId: string): Promise<void> {
  const client = await getSyncEnclaveClient()
  await client.delete(
    `/api/storage/conversation/${encodeURIComponent(conversationId)}`,
  )
}

export async function deleteProject(projectId: string): Promise<void> {
  const client = await getSyncEnclaveClient()
  await client.delete(`/api/projects/${encodeURIComponent(projectId)}`)
}

export async function deleteProjectDocument(
  projectId: string,
  documentId: string,
): Promise<void> {
  const client = await getSyncEnclaveClient()
  await client.delete(
    `/api/projects/${encodeURIComponent(projectId)}/documents/${encodeURIComponent(documentId)}`,
  )
}

/* -------------------------------------------------------------------------- */
/*  Sync reads                                                                */
/* -------------------------------------------------------------------------- */

export async function listStatus(scope: Scope): Promise<ListStatusResponse> {
  const client = await getSyncEnclaveClient()
  return client.get<ListStatusResponse>(
    `/api/sync/list-status?scope=${encodeURIComponent(scope)}`,
  )
}

export async function needsMigration(
  scope: Scope,
  limit = 50,
): Promise<NeedsMigrationResponse> {
  const client = await getSyncEnclaveClient()
  return client.get<NeedsMigrationResponse>(
    `/api/sync/needs-migration?scope=${encodeURIComponent(scope)}&limit=${limit}`,
  )
}

export async function recordMigrationFailure(
  scope: Scope,
  id: string,
  projectId?: string,
): Promise<void> {
  const client = await getSyncEnclaveClient()
  await client.post('/api/sync/migration-failure', {
    scope,
    id,
    ...(projectId ? { project_id: projectId } : {}),
  })
}

export async function listTombstones(
  scope: Scope,
  since?: string,
  cursorId?: string,
  limit = 100,
): Promise<TombstonesResponse> {
  const client = await getSyncEnclaveClient()
  const params = new URLSearchParams({
    scope,
    limit: String(limit),
  })
  if (since) params.set('since', since)
  if (cursorId) params.set('cursor_id', cursorId)
  return client.get<TombstonesResponse>(`/api/sync/tombstones?${params}`)
}
