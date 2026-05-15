/**
 * Typed JSON-RPC client for the sync enclave's `/v1/*` endpoints. See
 * the enclave's `internal/server/types.go` for the canonical wire
 * shapes; everything here is a TypeScript mirror.
 *
 * All endpoints are POST with a JSON body and JSON response. The client
 * is responsible for:
 *
 *   - supplying the user's CEK on every push/pull/delete (base64 raw
 *     32-byte key);
 *   - choosing an idempotency key per logical operation;
 *   - passing the ETag the client believes the row is at (or null for
 *     a create) via `ifMatch`;
 *   - feeding the enclave any conflict resolution preferences via
 *     `conflictPolicy`.
 *
 * The enclave owns:
 *   - encryption-at-rest (seal/unseal under the user's CEK);
 *   - the per-row ETag and `key_id` columns;
 *   - 412 STALE_BLOB / 409 STALE_KEY conflict semantics; and
 *   - the auto-merge resolver path (see `internal/resolver`).
 */

import { SyncEnclaveError, getSyncEnclaveClient } from './sync-enclave-client'

export type Scope = 'profile' | 'chat' | 'project' | 'project_document'

export type ConflictPolicy = 'auto_merge' | 'reject' | 'replace_remote'

/* -------------------------------------------------------------------------- */
/*  Push / Pull / List / Delete                                               */
/* -------------------------------------------------------------------------- */

export interface PushRequest {
  scope: Scope
  /** Required for non-profile scopes; ignored for profile (server fills it in). */
  id?: string
  /** User's CEK, base64-encoded raw 32 bytes. */
  keyB64: string
  /** Plaintext bytes the enclave will seal. */
  plaintext: Uint8Array
  /** CAS guard. null = create; otherwise the ETag the caller believes the row is at. */
  ifMatch: string | null
  idempotencyKey: string
  conflictPolicy?: ConflictPolicy
  /** Arbitrary scope-specific metadata persisted alongside the row. */
  metadata?: Record<string, unknown>
}

export interface PushResponse {
  ok: true
  etag: string
  key_id: string
}

export interface PullKey {
  /** base64 32-byte raw key. */
  key: string
  /** Optional hint; enclave verifies/derives. */
  key_id?: string
}

export interface PullRequest {
  scope: Scope
  ids?: string[]
  all?: boolean
  cursor?: string
  limit?: number
  /** One or more candidate decryption keys. The enclave tries each in order. */
  keys: PullKey[]
}

export interface PullItem {
  id: string
  ok: boolean
  /** Base64-encoded plaintext bytes when `ok=true`. */
  plaintext?: string
  key_id?: string
  etag?: string
  needs_rewrap?: boolean
  /** Error code when `ok=false` (e.g. "NEEDS_REWRAP", "NOT_FOUND"). */
  code?: string
  reason?: string
}

export interface PullResponse {
  items: PullItem[]
  next_cursor?: string
}

export interface ListStatusRequest {
  scope: Scope
  cursor?: string
  limit?: number
}

export interface ListStatusUpdate {
  id: string
  etag: string
  key_id: string
  /** Server-supplied project membership for chat rows; absent for other scopes. */
  project_id?: string | null
  updated_at: string
  cursor?: string
}

export interface ListStatusDelete {
  id: string
  scope: Scope
  deleted_at: string
  cursor?: string
}

export interface ListStatusResponse {
  updates: ListStatusUpdate[]
  deletes: ListStatusDelete[]
  next_cursor?: string
}

export interface DeleteRequest {
  scope: Scope
  id: string
  ifMatch: string | null
  idempotencyKey: string
  /** Base64 CEK; required to derive the op-hash key per spec §7.0. */
  keyB64: string
}

export interface OKResponse {
  ok: true
}

/* -------------------------------------------------------------------------- */
/*  Key registry                                                              */
/* -------------------------------------------------------------------------- */

export interface KeyRegisterBundleInput {
  credentialId: string
  /** AES-GCM IV, hex. */
  kekIvHex: string
  /** Wrapped CEK, hex. */
  encryptedKeysHex: string
}

export interface KeyRegisterRequest {
  /** Base64 raw 32-byte CEK. */
  keyB64: string
  /** Equivalent of If-Match for the user_keys row; "" for first register. */
  ifMatch: string
  /**
   * Origin label persisted on `user_keys.created_via`. The enclave
   * accepts only the four values listed here (see
   * `internal/server/ops.go::RegisterKey`).
   */
  createdVia: 'passkey' | 'manual' | 'recovery' | 'start_fresh'
  idempotencyKey: string
  /** Optional initial passkey bundle to register alongside the key. */
  initialBundle?: KeyRegisterBundleInput
}

export interface KeyRegisterResponse {
  ok: true
  key_id: string
}

export interface AddBundleRequest {
  keyId: string
  keyB64: string
  credentialId: string
  kekIvHex: string
  encryptedKeysHex: string
  /** Client-generated idempotency key, e.g. `newIdempotencyKey()`. */
  idempotencyKey: string
}

export interface RemoveBundleRequest {
  keyId: string
  keyB64: string
  credentialId: string
  /** Client-generated idempotency key, e.g. `newIdempotencyKey()`. */
  idempotencyKey: string
}

/**
 * Bundle entry shape returned by /v1/key/current. Mirrors the
 * controlplane `user_key_bundles` row layout (kek_iv + encrypted_keys
 * are base64 strings on the wire).
 */
export interface KeyCurrentBundle {
  credential_id: string
  kek_iv: string
  encrypted_keys: string
  bundle_version?: number
  created_at?: string
  updated_at?: string
}

export interface KeyCurrentResponse {
  /** Hex-encoded current KeyID, or null if the user has no key yet. */
  key_id: string | null
  /** Map of credential_id → bundle body. Empty when key_id is null. */
  bundles: Record<string, KeyCurrentBundle>
  created_via?: 'passkey' | 'manual' | 'recovery' | 'start_fresh'
  created_at?: string
}

/* -------------------------------------------------------------------------- */
/*  Migration                                                                 */
/* -------------------------------------------------------------------------- */

export interface MigrateRequest {
  scope: Scope
  ids?: string[]
  limit?: number
  /** Candidate keys the enclave will try when unsealing legacy rows. */
  keys: PullKey[]
  target: { key: string /* base64 raw 32-byte target CEK */ }
}

export interface MigrateResponse {
  migrated: number
  retryable_remaining: number
  blocked_unmigrated: number
  blocked: string[]
}

/**
 * MigrateAllRequest tells the enclave to drain every scope under the
 * supplied target CEK in one call. The enclave handles per-scope
 * pagination internally; clients do not iterate.
 */
export interface MigrateAllRequest {
  keys: PullKey[]
  target: { key: string /* base64 raw 32-byte target CEK */ }
}

export interface MigrateAllScopeReport {
  scope: Scope
  migrated: number
  retryable_remaining: number
  blocked_unmigrated: number
  blocked?: string[]
}

export interface MigrateAllResponse {
  migrated: number
  retryable_remaining: number
  blocked_unmigrated: number
  /**
   * True when the enclave hit its wall-clock budget before every
   * scope was drained. The client should re-invoke migrate-all to
   * pick up where it left off.
   */
  partial: boolean
  scopes: MigrateAllScopeReport[]
}

/* -------------------------------------------------------------------------- */
/*  Health                                                                    */
/* -------------------------------------------------------------------------- */

export interface HealthResponse {
  status: string
  git_sha?: string
}

/* -------------------------------------------------------------------------- */
/*  RPC calls                                                                 */
/* -------------------------------------------------------------------------- */

function bytesToB64(b: Uint8Array): string {
  let s = ''
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i])
  return btoa(s)
}

function b64ToBytes(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export async function push(req: PushRequest): Promise<PushResponse> {
  const client = await getSyncEnclaveClient()
  return client.post<PushResponse>('/v1/sync/push', {
    scope: req.scope,
    id: req.id ?? '',
    key: req.keyB64,
    plaintext: bytesToB64(req.plaintext),
    if_match: req.ifMatch,
    idempotency_key: req.idempotencyKey,
    conflict_policy: req.conflictPolicy ?? 'auto_merge',
    metadata: req.metadata,
  })
}

export async function pull(req: PullRequest): Promise<PullResponse> {
  const client = await getSyncEnclaveClient()
  return client.post<PullResponse>('/v1/sync/pull', {
    scope: req.scope,
    ids: req.ids,
    all: req.all,
    cursor: req.cursor,
    limit: req.limit,
    keys: req.keys,
  })
}

export async function pullOne(
  scope: Scope,
  id: string,
  keys: PullKey[],
): Promise<PullItem | null> {
  const resp = await pull({ scope, ids: [id], keys })
  if (resp.items.length === 0) return null
  return resp.items[0]
}

export function pullItemPlaintext(item: PullItem): Uint8Array | null {
  if (!item.ok || !item.plaintext) return null
  return b64ToBytes(item.plaintext)
}

export async function listStatus(
  req: ListStatusRequest,
): Promise<ListStatusResponse> {
  const client = await getSyncEnclaveClient()
  return client.post<ListStatusResponse>('/v1/sync/list-status', {
    scope: req.scope,
    cursor: req.cursor,
    limit: req.limit,
  })
}

export async function deleteRow(req: DeleteRequest): Promise<OKResponse> {
  const client = await getSyncEnclaveClient()
  return client.post<OKResponse>('/v1/sync/delete', {
    scope: req.scope,
    id: req.id,
    if_match: req.ifMatch,
    idempotency_key: req.idempotencyKey,
    key: req.keyB64,
  })
}

export async function registerKey(
  req: KeyRegisterRequest,
): Promise<KeyRegisterResponse> {
  const client = await getSyncEnclaveClient()
  const body: Record<string, unknown> = {
    key: req.keyB64,
    if_match: req.ifMatch,
    created_via: req.createdVia,
    idempotency_key: req.idempotencyKey,
  }
  if (req.initialBundle) {
    body.initial_bundle = {
      credential_id: req.initialBundle.credentialId,
      kek_iv: req.initialBundle.kekIvHex,
      encrypted_keys: req.initialBundle.encryptedKeysHex,
    }
  }
  return client.post<KeyRegisterResponse>('/v1/key/register', body)
}

export async function addBundle(req: AddBundleRequest): Promise<OKResponse> {
  const client = await getSyncEnclaveClient()
  return client.post<OKResponse>('/v1/key/add-bundle', {
    key_id: req.keyId,
    key: req.keyB64,
    credential_id: req.credentialId,
    kek_iv: req.kekIvHex,
    encrypted_keys: req.encryptedKeysHex,
    idempotency_key: req.idempotencyKey,
  })
}

/**
 * Revoke a passkey bundle from the current key. Maps to
 * DELETE /api/keys/:keyId/bundles/:credentialId on the controlplane.
 */
export async function removeBundle(
  req: RemoveBundleRequest,
): Promise<OKResponse> {
  const client = await getSyncEnclaveClient()
  return client.post<OKResponse>('/v1/key/remove-bundle', {
    key_id: req.keyId,
    key: req.keyB64,
    credential_id: req.credentialId,
    idempotency_key: req.idempotencyKey,
  })
}

/**
 * Fetch the current key id and the full set of passkey bundles
 * registered for the authenticated user. Returns `{ key_id: null,
 * bundles: {} }` when the user has no key yet (HTTP 404 from the
 * enclave is mapped to this empty shape so callers can treat it as a
 * normal "first-time user" state without special-casing exceptions).
 */
export async function keyCurrent(): Promise<KeyCurrentResponse> {
  const client = await getSyncEnclaveClient()
  try {
    return await client.post<KeyCurrentResponse>('/v1/key/current', {})
  } catch (err) {
    if (err instanceof SyncEnclaveError && err.status === 404) {
      return { key_id: null, bundles: {} }
    }
    throw err
  }
}

export async function migrate(req: MigrateRequest): Promise<MigrateResponse> {
  const client = await getSyncEnclaveClient()
  return client.post<MigrateResponse>('/v1/blobs/migrate', {
    scope: req.scope,
    ids: req.ids,
    limit: req.limit,
    keys: req.keys,
    target: req.target,
  })
}

export async function migrateAll(
  req: MigrateAllRequest,
): Promise<MigrateAllResponse> {
  const client = await getSyncEnclaveClient()
  return client.post<MigrateAllResponse>('/v1/blobs/migrate-all', {
    keys: req.keys,
    target: req.target,
  })
}

export async function health(): Promise<HealthResponse> {
  const client = await getSyncEnclaveClient()
  return client.get<HealthResponse>('/v1/health')
}

/**
 * Re-export the typed error class so call sites can do
 * `if (err instanceof SyncEnclaveError)` without reaching into the
 * client module.
 */
export { SyncEnclaveError }

/**
 * Helpers callers commonly need: convert hex CEK → base64 (the wire
 * format), and base64 plaintext → bytes.
 */
export function hexToB64(hex: string): string {
  if (hex.length % 2 !== 0) throw new Error('sync-api: odd-length hex')
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16)
  }
  return bytesToB64(bytes)
}

export function bytesToBase64(b: Uint8Array): string {
  return bytesToB64(b)
}

export function base64ToBytes(s: string): Uint8Array {
  return b64ToBytes(s)
}

/**
 * Convert a base64 string to lowercase hex. Used to map the wire's
 * `kek_iv` / `encrypted_keys` (base64) into the hex shape `BundleBody`
 * expects.
 */
export function b64ToHex(s: string): string {
  const bytes = b64ToBytes(s)
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0')
  }
  return out
}

/**
 * Mint a fresh idempotency key for one logical enclave write. The key
 * MUST be reused across every HTTP retry of the same logical write
 * (§9.6 R1) and refreshed when the caller has a new logical write to
 * perform. Format is 32 lowercase hex characters — a UUID-equivalent
 * 128 bits drawn from `crypto.getRandomValues`.
 */
export function newIdempotencyKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0')
  }
  return out
}
