import { computeOperationHash } from './operation-hash'
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
 *   - X-Operation-Hash    : keyed HMAC over the canonical tuple
 *                            (METHOD, PATH, KEY_ID, IF_MATCH, IDEM, BODY)
 *                            under a CEK-derived subkey. See §7.0 of
 *                            syncplan.md and `operation-hash.ts`. The
 *                            controlplane sees this header so a plain
 *                            SHA-256(plaintext) would be brute-forceable
 *                            against low-entropy bodies; the keyed MAC
 *                            closes that hole.
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
   * Operation-hash subkey, derived once per session from the user's
   * CEK via `deriveOpHashKey()`. The same subkey can be reused across
   * many writes. Forcing this through the type system means callers
   * cannot accidentally substitute a SHA-256(body) — the
   * controlplane-visible header would then be brute-forceable.
   */
  opKey: CryptoKey
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

async function writeHeaders(
  method: 'PUT' | 'POST' | 'DELETE',
  path: string,
  keyIdHex: string,
  opts: WriteOptions,
  body: Uint8Array,
): Promise<Record<string, string>> {
  const ifMatchStr = String(opts.ifMatch)
  const opHash = await computeOperationHash(opts.opKey, {
    method,
    path,
    keyIdHex,
    ifMatch: ifMatchStr,
    idempotencyKey: opts.idempotencyKey,
    body,
  })
  const headers: Record<string, string> = {
    'X-Key-Id': keyIdHex,
    'If-Match': ifMatchStr,
    'X-Idempotency-Key': opts.idempotencyKey,
    'X-Operation-Hash': opHash,
  }
  if (opts.rewrap) {
    headers['X-Rewrap'] = 'true'
  }
  return headers
}

function jsonBody(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value))
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
  const path = '/api/profile/'
  const body = jsonBody({ data })
  const headers = await writeHeaders('PUT', path, keyIdHex, opts, body)
  headers['Content-Type'] = 'application/json'
  return client.request<WriteResponse>(path, {
    method: 'PUT',
    body: body as unknown as BodyInit,
    headers,
  })
}

export async function putChat(
  conversationId: string,
  body: Uint8Array,
  keyIdHex: string,
  opts: WriteOptions,
  extra?: { projectId?: string; messageCount?: number },
): Promise<WriteResponse> {
  const client = await getSyncEnclaveClient()
  const path = `/api/storage/conversation/${encodeURIComponent(conversationId)}/data`
  const headers = await writeHeaders('PUT', path, keyIdHex, opts, body)
  headers['Content-Type'] = 'application/octet-stream'
  if (extra?.projectId) headers['X-Project-Id'] = extra.projectId
  if (typeof extra?.messageCount === 'number') {
    headers['X-Message-Count'] = String(extra.messageCount)
  }
  return client.request<WriteResponse>(path, {
    method: 'PUT',
    body: body as unknown as BodyInit,
    headers,
  })
}

export async function putProject(
  projectId: string,
  data: string,
  keyIdHex: string,
  opts: WriteOptions,
): Promise<WriteResponse> {
  const client = await getSyncEnclaveClient()
  const path = `/api/projects/${encodeURIComponent(projectId)}`
  const body = jsonBody({ projectId, data })
  const headers = await writeHeaders('PUT', path, keyIdHex, opts, body)
  headers['Content-Type'] = 'application/json'
  return client.request<WriteResponse>(path, {
    method: 'PUT',
    body: body as unknown as BodyInit,
    headers,
  })
}

export async function putProjectDocument(
  projectId: string,
  documentId: string,
  data: string,
  keyIdHex: string,
  opts: WriteOptions,
): Promise<WriteResponse> {
  const client = await getSyncEnclaveClient()
  const path = `/api/projects/${encodeURIComponent(projectId)}/documents/${encodeURIComponent(documentId)}`
  const body = jsonBody({ documentId, data })
  const headers = await writeHeaders('PUT', path, keyIdHex, opts, body)
  headers['Content-Type'] = 'application/json'
  return client.request<WriteResponse>(path, {
    method: 'PUT',
    body: body as unknown as BodyInit,
    headers,
  })
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
