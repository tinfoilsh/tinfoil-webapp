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
 *     a create) via `ifMatch`.
 *
 * The enclave owns:
 *   - encryption-at-rest (seal/unseal under the user's CEK);
 *   - the per-row ETag and `key_id` columns; and
 *   - 412 STALE_BLOB (surfaced as 409 SYNC_CONFLICT) / 409 STALE_KEY
 *     conflict semantics. The enclave never merges concurrent edits;
 *     every conflict is bubbled up to the UI to resolve.
 */

import { base64ToUint8Array, uint8ArrayToBase64 } from '@/utils/binary-codec'
import { z } from 'zod'
import { SyncEnclaveError, getSyncEnclaveClient } from './sync-enclave-client'
import { MAX_PULL_IDS, PULL_ITEM_CODES } from './wire-contract'

export { MAX_PULL_IDS, PULL_ITEM_CODES }

export type Scope = 'profile' | 'chat' | 'project' | 'project_document'

/* -------------------------------------------------------------------------- */
/*  Push / Pull / List / Delete                                               */
/* -------------------------------------------------------------------------- */

export interface PushRequest {
  scope: Scope
  /**
   * Required for every scope. For `profile`, pass the canonical
   * singleton id (`'profile'`) — the enclave no longer substitutes it
   * silently, so an empty value is a 400. See `cloud/profile-sync.ts`
   * for the constant and call site.
   */
  id: string
  /** User's CEK, base64-encoded raw 32 bytes. */
  keyB64: string
  /** Plaintext bytes the enclave will seal. */
  plaintext: Uint8Array
  /** CAS guard. null = create; otherwise the ETag the caller believes the row is at. */
  ifMatch: string | null
  idempotencyKey: string
  /** Arbitrary scope-specific metadata persisted alongside the row. */
  metadata?: Record<string, unknown>
}

export interface PushResponse {
  ok: true
  etag: string
  key_id: string
  /**
   * Whether the enclave's inline search-index update succeeded for a
   * chat push. `false` means the blob stored fine but the chat won't
   * surface in search until a reindex runs. Absent when search does
   * not apply (non-chat scope or search backend unconfigured).
   */
  search_indexed?: boolean
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
  /** Candidate decryption keys, in priority order. The enclave tries
   *  each one when unsealing v0/v1 rows and uses `keys[0]` as the
   *  rewrap target so legacy rows are promoted to v2 inline before
   *  the response is returned — callers don't have to opt in.
   */
  keys: PullKey[]
}

export interface PullItem {
  id: string
  ok: boolean
  /** Base64-encoded plaintext bytes when `ok=true`. */
  plaintext?: string
  key_id?: string
  etag?: string
  /** ETag replaced by a successful lazy rewrap during this pull. */
  previous_etag?: string
  project_id_set?: boolean
  project_id?: string | null
  needs_rewrap?: boolean
  /** One of PULL_ITEM_CODES when `ok=false`. */
  code?: string
  reason?: string
}

export interface PullResponse {
  items: PullItem[]
  next_cursor?: string
}

export type BackupInventoryScope = 'chat' | 'project' | 'project_document'

export interface BackupInventoryItem {
  scope: BackupInventoryScope
  id: string
  etag: string
  project_id?: string
  created_at: string
  updated_at: string
}

export interface BackupInventoryResponse {
  captured_at: string
  total_items: number
  items: BackupInventoryItem[]
}

export type BackupInventoryProtocolErrorCode =
  | 'malformed_response'
  | 'invalid_total'
  | 'invalid_timestamp'
  | 'unsupported_scope'
  | 'duplicate_item'
  | 'invalid_order'
  | 'invalid_relationship'
  | 'missing_id'
  | 'missing_etag'

export class BackupInventoryProtocolError extends Error {
  constructor(
    public readonly code: BackupInventoryProtocolErrorCode,
    public readonly itemIndex?: number,
  ) {
    super('Sync enclave returned an invalid backup inventory')
    this.name = 'BackupInventoryProtocolError'
  }
}

export interface ListStatusRequest {
  scope: Scope
  cursor?: string
  limit?: number
  /** Optional server-side project filter for chat scope. */
  projectId?: string
  /** Sort order. Defaults to ascending (`updated_at` oldest -> newest). */
  direction?: 'asc' | 'desc'
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

export interface RevisionSummaryResponse {
  current_revision: string
  oldest_replayable_revision: string
}

export interface RevisionEvent {
  revision: string
  kind: 'upsert' | 'delete'
  id: string
  etag?: string
  key_id?: string
  project_id: string | null
  updated_at: string
}

export interface RevisionEventsResponse {
  events: RevisionEvent[]
  next_cursor?: string
}

export interface RevisionSnapshotItem {
  id: string
  etag: string
  key_id: string
  project_id: string | null
  updated_at: string
}

export interface RevisionSnapshotResponse {
  items: RevisionSnapshotItem[]
  snapshot_revision: string
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

export interface DeleteAllProjectsRequest {
  /** Base64 CEK; required to derive the op-hash key per spec §7.0. */
  keyB64: string
  idempotencyKey: string
}

export interface DeleteAllProjectsResponse {
  ok: true
  deleted: number
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
 * are hex strings on the wire).
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
  /**
   * Opaque etag the controlplane uses to gate concurrent register-key
   * mutations. Pass this back as `if_match` when rotating or running
   * the start-fresh wipe. Empty string when the user has no key yet.
   */
  etag?: string
  /** Map of credential_id → bundle body. Empty when key_id is null. */
  bundles: Record<string, KeyCurrentBundle>
  created_via?: 'passkey' | 'manual' | 'recovery' | 'start_fresh'
  created_at?: string
  /**
   * Whether the user owns encrypted blobs not sealed under the reported
   * key. When `key_id` is null this means legacy (key_id IS NULL) data
   * exists, so the client should route to recovery rather than offering
   * first-time setup. Absent on older enclaves (treated as false).
   */
  has_data?: boolean
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

export type MigrateAllStatus = 'idle' | 'running' | 'completed' | 'failed'

export interface MigrateAllResponse {
  migrated: number
  retryable_remaining: number
  blocked_unmigrated: number
  /**
   * True while the enclave-side job is still draining; clients
   * keep polling until it flips to false. Set to false on terminal
   * states (completed, failed).
   */
  partial: boolean
  scopes: MigrateAllScopeReport[]
  /**
   * Async migration lifecycle fields. The enclave runs migrate-all
   * in a detached goroutine so a tab close no longer kills the
   * loop; the kickoff returns immediately with status='running'
   * and the client polls until 'completed' or 'failed'.
   */
  status?: MigrateAllStatus
  job_id?: string
  started_at?: string
  updated_at?: string
  error?: string
}

/* -------------------------------------------------------------------------- */
/*  Encrypted chat search                                                     */
/* -------------------------------------------------------------------------- */

export interface SearchQueryRequest {
  /** User's CEK, base64 raw 32 bytes. The enclave derives the
   *  search-index subkey from it; the index never leaves the enclave
   *  unencrypted. */
  keyB64: string
  query: string
  limit?: number
}

export interface SearchQueryResult {
  /** Chat id; contents come from the normal pull path. */
  id: string
  score: number
}

export interface SearchQueryResponse {
  results: SearchQueryResult[]
  total_indexed: number
  /**
   * True when no readable index exists for the supplied key (never
   * built, different key, or the enclave's embedding model changed).
   * The client should kick /v1/search/reindex and poll status.
   */
  needs_reindex?: boolean
}

export interface SearchReindexRequest {
  /** Primary key first, then any legacy keys still sealing old rows. */
  keys: PullKey[]
}

export type SearchReindexStatus = 'idle' | 'running' | 'completed' | 'failed'

/**
 * Wire shape returned by both the reindex kickoff and the status
 * poll. The kickoff joins an already-running job for the same key
 * set instead of starting a second one.
 */
export interface SearchReindexStatusResponse {
  job_id?: string
  status: SearchReindexStatus
  indexed: number
  failed: number
  total_indexed: number
  /** True when the run stopped at its wall-clock budget before
   *  draining every chat; a fresh kickoff restarts the build. */
  partial: boolean
  started_at?: string
  updated_at?: string
  error?: string
}

/* -------------------------------------------------------------------------- */
/*  Off-device chat import                                                    */
/* -------------------------------------------------------------------------- */

export type ImportSource = 'chatgpt' | 'claude' | 'tinfoil' | 'tinfoil_backup'

export type ImportJobStatus =
  'idle' | 'staging' | 'running' | 'completed' | 'failed'

/**
 * Why a job ended with status 'failed'. The enclave classifies the
 * underlying error into one of these so the UI can explain what to do
 * next without seeing raw error text.
 */
export type ImportFailureReason =
  'timeout' | 'invalid_archive' | 'limit_exceeded' | 'key_mismatch' | 'internal'

export interface ImportCreateRequest {
  source: ImportSource
  /** Total size of the raw archive in bytes. */
  totalBytes: number
  /** Number of chunks the client will upload. */
  totalChunks: number
  /** Hex SHA-256 of the full archive, verified before parsing. */
  archiveSha256: string
}

export interface ImportCreateResponse {
  job_id: string
  upload_id: string
}

export interface ImportUploadChunkRequest {
  uploadId: string
  chunkIndex: number
  /** Hex SHA-256 of this chunk's raw bytes. */
  chunkSha256: string
  /** Raw chunk bytes; the client base64-encodes them on the wire. */
  data: Uint8Array
}

export interface ImportStartRequest {
  jobId: string
  /** User's CEK, base64 raw 32 bytes. Held in enclave memory for the job. */
  keyB64: string
}

export interface ImportStatusResponse {
  status: ImportJobStatus
  phase?: string
  imported: number
  failed: number
  total: number
  counts?: Record<
    string,
    { imported: number; skipped: number; failed: number; blocked: number }
  >
  warnings?: string[]
  errors?: string[]
  project_mappings?: Record<string, string>
  job_id?: string
  /** Set only when status is 'failed'. */
  failure_reason?: ImportFailureReason
}

/**
 * Create an off-device import job. The enclave allocates a job id and
 * an upload id and prepares an encrypted staging area for the archive
 * chunks. The browser must stay open through the chunk upload and
 * import/start; once import/start returns the tab can close.
 */
export async function importCreate(
  req: ImportCreateRequest,
  signal?: AbortSignal,
): Promise<ImportCreateResponse> {
  signal?.throwIfAborted()
  const client = await getSyncEnclaveClient()
  return client.post<ImportCreateResponse>(
    '/v1/import/create',
    {
      source: req.source,
      total_bytes: req.totalBytes,
      total_chunks: req.totalChunks,
      archive_sha256: req.archiveSha256,
    },
    undefined,
    { signal },
  )
}

/** Stage one archive chunk. Replaying the same index+hash is idempotent. */
export async function importUploadChunk(
  req: ImportUploadChunkRequest,
  signal?: AbortSignal,
): Promise<OKResponse> {
  signal?.throwIfAborted()
  const client = await getSyncEnclaveClient()
  return client.post<OKResponse>(
    '/v1/import/upload',
    {
      upload_id: req.uploadId,
      chunk_index: req.chunkIndex,
      chunk_sha256: req.chunkSha256,
      data: bytesToB64(req.data),
    },
    undefined,
    { signal },
  )
}

/**
 * Kick off the detached import job. The enclave validates the staged
 * archive, parses it, seals every chat + attachment under the supplied
 * CEK, and emails the user when the job completes or fails.
 */
export async function importStart(
  req: ImportStartRequest,
  signal?: AbortSignal,
): Promise<ImportStatusResponse> {
  signal?.throwIfAborted()
  const client = await getSyncEnclaveClient()
  return client.post<ImportStatusResponse>(
    '/v1/import/start',
    { job_id: req.jobId, key: req.keyB64 },
    undefined,
    { signal },
  )
}

/** Poll an import job's progress while the tab stays open. */
export async function importStatus(
  jobId: string,
  signal?: AbortSignal,
): Promise<ImportStatusResponse> {
  signal?.throwIfAborted()
  const client = await getSyncEnclaveClient()
  const resp = await client.post<ImportStatusResponse>(
    '/v1/import/status',
    { job_id: jobId },
    undefined,
    { signal },
  )
  return { ...resp, errors: resp.errors ?? [] }
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
  return uint8ArrayToBase64(b)
}

function b64ToBytes(s: string): Uint8Array {
  return base64ToUint8Array(s)
}

export async function push(req: PushRequest): Promise<PushResponse> {
  const client = await getSyncEnclaveClient()
  return client.post<PushResponse>(
    '/v1/sync/push',
    {
      scope: req.scope,
      id: req.id ?? '',
      key: req.keyB64,
      plaintext: bytesToB64(req.plaintext),
      if_match: req.ifMatch,
      idempotency_key: req.idempotencyKey,
      metadata: req.metadata,
    },
    undefined,
    { requestScope: 'cloud-sync' },
  )
}

export async function pull(req: PullRequest): Promise<PullResponse> {
  const client = await getSyncEnclaveClient()
  const resp = await client.post<PullResponse>(
    '/v1/sync/pull',
    {
      scope: req.scope,
      ids: req.ids,
      all: req.all,
      cursor: req.cursor,
      limit: req.limit,
      keys: req.keys,
    },
    undefined,
    { requestScope: 'cloud-sync' },
  )
  // Go marshals an empty slice as JSON null, which would crash every
  // downstream `for (const item of resp.items)` consumer. Force a
  // stable [] at the boundary so callers can iterate without guards.
  return { ...resp, items: resp.items ?? [] }
}

const BACKUP_INVENTORY_SCOPES: readonly BackupInventoryScope[] = [
  'chat',
  'project',
  'project_document',
]
const BACKUP_INVENTORY_RESPONSE_FIELDS = [
  'captured_at',
  'total_items',
  'items',
] as const
const BACKUP_INVENTORY_ITEM_FIELDS = [
  'scope',
  'id',
  'etag',
  'project_id',
  'created_at',
  'updated_at',
] as const
const BACKUP_INVENTORY_TIMESTAMP_SCHEMA = z.string().datetime({ offset: true })

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
): boolean {
  const keys = Object.keys(value)
  return (
    keys.every((key) => allowed.includes(key)) &&
    required.every((key) => Object.hasOwn(value, key))
  )
}

function parseInventoryTimestamp(
  value: unknown,
  itemIndex?: number,
): { value: string; milliseconds: number } {
  if (
    typeof value !== 'string' ||
    !BACKUP_INVENTORY_TIMESTAMP_SCHEMA.safeParse(value).success
  )
    throw new BackupInventoryProtocolError('invalid_timestamp', itemIndex)
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds))
    throw new BackupInventoryProtocolError('invalid_timestamp', itemIndex)
  return { value, milliseconds }
}

function validateBackupInventory(value: unknown): BackupInventoryResponse {
  if (
    !isObject(value) ||
    !hasExactFields(
      value,
      BACKUP_INVENTORY_RESPONSE_FIELDS,
      BACKUP_INVENTORY_RESPONSE_FIELDS,
    ) ||
    !Array.isArray(value.items)
  )
    throw new BackupInventoryProtocolError('malformed_response')
  if (
    typeof value.total_items !== 'number' ||
    !Number.isSafeInteger(value.total_items) ||
    value.total_items < 0 ||
    value.total_items !== value.items.length
  )
    throw new BackupInventoryProtocolError('invalid_total')

  const captured = parseInventoryTimestamp(value.captured_at)
  const seen = new Set<string>()
  let previousOrderKey: string | undefined
  const items = value.items.map((candidate, itemIndex): BackupInventoryItem => {
    if (
      !isObject(candidate) ||
      !hasExactFields(candidate, BACKUP_INVENTORY_ITEM_FIELDS, [
        'scope',
        'id',
        'etag',
        'created_at',
        'updated_at',
      ])
    )
      throw new BackupInventoryProtocolError('malformed_response', itemIndex)
    if (
      typeof candidate.scope !== 'string' ||
      !BACKUP_INVENTORY_SCOPES.includes(candidate.scope as BackupInventoryScope)
    )
      throw new BackupInventoryProtocolError('unsupported_scope', itemIndex)
    const scope = candidate.scope as BackupInventoryScope
    if (typeof candidate.id !== 'string' || candidate.id.trim().length === 0)
      throw new BackupInventoryProtocolError('missing_id', itemIndex)
    if (
      typeof candidate.etag !== 'string' ||
      candidate.etag.trim().length === 0
    )
      throw new BackupInventoryProtocolError('missing_etag', itemIndex)
    const hasProjectId = Object.hasOwn(candidate, 'project_id')
    if (
      (hasProjectId &&
        (typeof candidate.project_id !== 'string' ||
          candidate.project_id.trim().length === 0)) ||
      (scope === 'project_document' && !hasProjectId) ||
      (scope === 'project' && hasProjectId)
    )
      throw new BackupInventoryProtocolError('invalid_relationship', itemIndex)

    const created = parseInventoryTimestamp(candidate.created_at, itemIndex)
    const updated = parseInventoryTimestamp(candidate.updated_at, itemIndex)
    if (
      created.milliseconds > updated.milliseconds ||
      updated.milliseconds > captured.milliseconds
    )
      throw new BackupInventoryProtocolError('invalid_order', itemIndex)

    const identity = `${scope}\u0000${candidate.project_id ?? ''}\u0000${candidate.id}`
    if (seen.has(identity))
      throw new BackupInventoryProtocolError('duplicate_item', itemIndex)
    seen.add(identity)
    const orderKey = `${String(BACKUP_INVENTORY_SCOPES.indexOf(scope)).padStart(2, '0')}\u0000${candidate.id}\u0000${candidate.project_id ?? ''}`
    if (previousOrderKey !== undefined && orderKey <= previousOrderKey)
      throw new BackupInventoryProtocolError('invalid_order', itemIndex)
    previousOrderKey = orderKey

    return {
      scope,
      id: candidate.id,
      etag: candidate.etag,
      ...(hasProjectId ? { project_id: candidate.project_id as string } : {}),
      created_at: created.value,
      updated_at: updated.value,
    }
  })
  const projectIds = new Set(
    items.filter(({ scope }) => scope === 'project').map(({ id }) => id),
  )
  items.forEach((item, itemIndex) => {
    if (item.project_id && !projectIds.has(item.project_id))
      throw new BackupInventoryProtocolError('invalid_relationship', itemIndex)
  })
  return {
    captured_at: captured.value,
    total_items: value.total_items,
    items,
  }
}

export async function backupInventory(
  signal?: AbortSignal,
): Promise<BackupInventoryResponse> {
  signal?.throwIfAborted()
  const client = await getSyncEnclaveClient(signal)
  const response = await client.post<unknown>(
    '/v1/sync/backup-inventory',
    {},
    undefined,
    { signal, requestScope: 'cloud-sync' },
  )
  signal?.throwIfAborted()
  return validateBackupInventory(response)
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
  if (!item.ok) return null
  if (item.plaintext === null || item.plaintext === undefined) return null
  return b64ToBytes(item.plaintext)
}

export async function listStatus(
  req: ListStatusRequest,
): Promise<ListStatusResponse> {
  const client = await getSyncEnclaveClient()
  const resp = await client.post<ListStatusResponse>(
    '/v1/sync/list-status',
    {
      scope: req.scope,
      cursor: req.cursor,
      limit: req.limit,
      project_id: req.projectId,
      direction: req.direction,
    },
    undefined,
    { requestScope: 'cloud-sync' },
  )
  // Both arrays land as JSON null when the server has nothing to
  // report for the page; normalize so iteration in cloud-storage /
  // project-storage / profile-sync stays branchless.
  return {
    ...resp,
    updates: resp.updates ?? [],
    deletes: resp.deletes ?? [],
  }
}

export async function revisionSummary(): Promise<RevisionSummaryResponse> {
  const client = await getSyncEnclaveClient()
  return client.post<RevisionSummaryResponse>('/v1/sync/revision-summary', {})
}

export async function revisionEvents(req: {
  afterRevision: string
  throughRevision: string
  cursor?: string
  limit?: number
}): Promise<RevisionEventsResponse> {
  const client = await getSyncEnclaveClient()
  const response = await client.post<RevisionEventsResponse>(
    '/v1/sync/revision-events',
    {
      after_revision: req.afterRevision,
      through_revision: req.throughRevision,
      cursor: req.cursor,
      limit: req.limit,
    },
  )
  return { ...response, events: response.events ?? [] }
}

export async function revisionSnapshot(
  req: {
    cursor?: string
    limit?: number
  } = {},
): Promise<RevisionSnapshotResponse> {
  const client = await getSyncEnclaveClient()
  const response = await client.post<RevisionSnapshotResponse>(
    '/v1/sync/revision-snapshot',
    { cursor: req.cursor, limit: req.limit },
  )
  return { ...response, items: response.items ?? [] }
}

export async function deleteRow(req: DeleteRequest): Promise<OKResponse> {
  const client = await getSyncEnclaveClient()
  return client.post<OKResponse>(
    '/v1/sync/delete',
    {
      scope: req.scope,
      id: req.id,
      if_match: req.ifMatch,
      idempotency_key: req.idempotencyKey,
      key: req.keyB64,
    },
    undefined,
    { requestScope: 'cloud-sync' },
  )
}

export async function deleteAllProjects(
  req: DeleteAllProjectsRequest,
): Promise<DeleteAllProjectsResponse> {
  const client = await getSyncEnclaveClient()
  return client.post<DeleteAllProjectsResponse>(
    '/v1/sync/delete-all-projects',
    {
      key: req.keyB64,
      idempotency_key: req.idempotencyKey,
    },
    undefined,
    { requestScope: 'cloud-sync' },
  )
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
export async function keyCurrent(
  signal?: AbortSignal,
): Promise<KeyCurrentResponse> {
  signal?.throwIfAborted()
  const client = await getSyncEnclaveClient(signal)
  try {
    const resp = signal
      ? await client.post<KeyCurrentResponse>(
          '/v1/key/current',
          {},
          undefined,
          { signal },
        )
      : await client.post<KeyCurrentResponse>('/v1/key/current', {})
    // The server is a Go service; a nil bundle map marshals to JSON
    // null. Normalize so callers can Object.values/index the map
    // without crashing on edge shapes (e.g. a key registered via
    // migrate-all bootstrap before any bundle exists).
    return { ...resp, key_id: resp.key_id ?? null, bundles: resp.bundles ?? {} }
  } catch (err) {
    if (err instanceof SyncEnclaveError && err.status === 404) {
      return { key_id: null, bundles: {}, has_data: false }
    }
    throw err
  }
}

export async function migrate(req: MigrateRequest): Promise<MigrateResponse> {
  const client = await getSyncEnclaveClient()
  const resp = await client.post<MigrateResponse>('/v1/blobs/migrate', {
    scope: req.scope,
    ids: req.ids,
    limit: req.limit,
    keys: req.keys,
    target: req.target,
  })
  return { ...resp, blocked: resp.blocked ?? [] }
}

export async function migrateAll(
  req: MigrateAllRequest,
): Promise<MigrateAllResponse> {
  const client = await getSyncEnclaveClient()
  const resp = await client.post<MigrateAllResponse>('/v1/blobs/migrate-all', {
    keys: req.keys,
    target: req.target,
  })
  return normalizeMigrateAllResponse(resp)
}

/**
 * Poll the enclave's current migration job for this user. Used by
 * the polling loop between migrate-all kickoff and completion so we
 * don't have to re-send keys + target on every tick.
 */
export async function migrateStatus(): Promise<MigrateAllResponse> {
  const client = await getSyncEnclaveClient()
  const resp = await client.post<MigrateAllResponse>(
    '/v1/blobs/migrate-status',
    {},
  )
  return normalizeMigrateAllResponse(resp)
}

function normalizeMigrateAllResponse(
  resp: MigrateAllResponse,
): MigrateAllResponse {
  return {
    ...resp,
    scopes: (resp.scopes ?? []).map((s) => ({
      ...s,
      blocked: s.blocked ?? [],
    })),
  }
}

/**
 * Rank the caller's synced chats against a natural-language query.
 * Returns chat ids + scores only; resolve titles/contents through the
 * normal pull path. `needs_reindex: true` means the enclave has no
 * readable index for this key and the caller should drive a reindex.
 */
export async function searchQuery(
  req: SearchQueryRequest,
): Promise<SearchQueryResponse> {
  const client = await getSyncEnclaveClient()
  const resp = await client.post<SearchQueryResponse>('/v1/search/query', {
    key: req.keyB64,
    query: req.query,
    limit: req.limit,
  })
  return { ...resp, results: resp.results ?? [] }
}

/**
 * Kick off (or join) the enclave-side background job that rebuilds
 * the search index from the stored chat blobs. Returns the job's
 * current status snapshot; poll `searchReindexStatus()` until the
 * status is terminal.
 */
export async function searchReindex(
  req: SearchReindexRequest,
): Promise<SearchReindexStatusResponse> {
  const client = await getSyncEnclaveClient()
  return client.post<SearchReindexStatusResponse>('/v1/search/reindex', {
    keys: req.keys,
  })
}

/** Poll the caller's current reindex job; `status: 'idle'` when none. */
export async function searchReindexStatus(): Promise<SearchReindexStatusResponse> {
  const client = await getSyncEnclaveClient()
  return client.post<SearchReindexStatusResponse>(
    '/v1/search/reindex-status',
    {},
  )
}

/* -------------------------------------------------------------------------- */
/*  Attachment storage (buckets.tinfoil.sh via enclave)                       */
/* -------------------------------------------------------------------------- */

export interface AttachmentPutRequest {
  chatId: string
  /** Raw attachment bytes; the enclave forwards to buckets. */
  plaintext: Uint8Array
  idempotencyKey: string
}

/**
 * The enclave mints both the durable attachment id and the
 * per-attachment AES-256 key, then returns them here. The caller
 * must adopt the id wherever it used its local temp id and embed
 * the key in the chat JSON (as `attachments[i].encryptionKey`) so
 * future reads can use it as the buckets slot key. No CEK material
 * is ever shipped over this hop — the per-attachment key is the
 * only credential needed to address the bucket entry, and it is
 * already implicitly protected by the chat envelope's CEK seal.
 */
export interface AttachmentPutResponse {
  ok: true
  id: string
  /** Base64-encoded 32-byte AES-256 key the enclave minted. */
  att_key: string
}

export interface AttachmentGetRequest {
  id: string
  /** Per-attachment key the caller pulled from chat JSON. */
  attKeyB64: string
}

export interface AttachmentGetResponse {
  ok: true
  plaintext: string
}

/** Upload an attachment through the sync enclave. */
export async function attachmentPut(
  req: AttachmentPutRequest,
): Promise<AttachmentPutResponse> {
  const client = await getSyncEnclaveClient()
  return client.post<AttachmentPutResponse>(
    '/v1/attachment/put',
    {
      chat_id: req.chatId,
      plaintext: bytesToB64(req.plaintext),
      idempotency_key: req.idempotencyKey,
    },
    undefined,
    { requestScope: 'cloud-sync' },
  )
}

/** Fetch an attachment through the sync enclave; returns raw bytes. */
export async function attachmentGet(
  req: AttachmentGetRequest,
): Promise<Uint8Array> {
  const client = await getSyncEnclaveClient()
  const resp = await client.post<AttachmentGetResponse>(
    '/v1/attachment/get',
    {
      id: req.id,
      att_key: req.attKeyB64,
    },
    undefined,
    { requestScope: 'cloud-sync' },
  )
  return b64ToBytes(resp.plaintext)
}

/**
 * Fetch an attachment through the enclave's unauthenticated route.
 * Used by share recipients who have the per-attachment key but no
 * JWT — same trust model as legacy /api/storage/attachment, just
 * routed through the enclave so the buckets API key never has to
 * be exposed to the recipient's browser.
 */
export async function attachmentGetPublic(
  req: AttachmentGetRequest,
): Promise<Uint8Array> {
  const client = await getSyncEnclaveClient()
  const resp = await client.postPublic<AttachmentGetResponse>(
    '/v1/attachment/get-public',
    {
      id: req.id,
      att_key: req.attKeyB64,
    },
  )
  return b64ToBytes(resp.plaintext)
}

/**
 * Delete an attachment from buckets through the sync enclave. No CEK
 * is required: the buckets path is the attachment id and the
 * controlplane's `chat_attachments` row is the source of truth for
 * ownership; deletion is pure addressing.
 */
export async function attachmentDelete(req: {
  id: string
}): Promise<OKResponse> {
  const client = await getSyncEnclaveClient()
  return client.post<OKResponse>(
    '/v1/attachment/delete',
    {
      id: req.id,
    },
    undefined,
    { requestScope: 'cloud-sync' },
  )
}

/* -------------------------------------------------------------------------- */
/*  Public chat share (seal + open through the enclave)                       */
/* -------------------------------------------------------------------------- */

export interface ShareSealRequest {
  /** Plaintext JSON the owner wants to publish. */
  plaintext: Uint8Array
}

export interface ShareSealResponse {
  ok: true
  /** Hex-encoded 32-byte random share key. Embed in URL fragment. */
  share_key: string
  /** Base64-encoded sealed ciphertext to upload to /api/shares/:chatId. */
  ciphertext: string
}

export interface ShareOpenRequest {
  /** Hex share key the recipient pulled out of the URL fragment. */
  shareKeyHex: string
  /** Ciphertext bytes fetched anonymously from /api/shares/:chatId. */
  ciphertext: Uint8Array
}

/**
 * Seal a chat for public sharing. The enclave generates a fresh
 * random share key, gzips and AES-GCM-seals the plaintext, and
 * returns the key + ciphertext. The owner uploads the ciphertext
 * to controlplane and embeds the key in the share URL fragment.
 * Auth: the owner's JWT (the enclave only seals for authenticated
 * users so the share count can later be billed/limited).
 */
export async function shareSeal(
  req: ShareSealRequest,
): Promise<ShareSealResponse> {
  const client = await getSyncEnclaveClient()
  return client.post<ShareSealResponse>('/v1/share/seal', {
    plaintext: bytesToB64(req.plaintext),
  })
}

/**
 * Open a previously sealed share. Recipients pass the ciphertext
 * they fetched from controlplane plus the URL-fragment share key;
 * the enclave decrypts and returns plaintext. No authentication;
 * the share key itself is the access proof.
 */
export async function shareOpen(req: ShareOpenRequest): Promise<Uint8Array> {
  const client = await getSyncEnclaveClient()
  const resp = await client.postPublic<{ ok: true; plaintext: string }>(
    '/v1/share/open',
    {
      share_key: req.shareKeyHex,
      ciphertext: bytesToB64(req.ciphertext),
    },
  )
  return b64ToBytes(resp.plaintext)
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
  if (hex.length === 0) throw new Error('sync-api: empty hex')
  if (hex.length % 2 !== 0) throw new Error('sync-api: odd-length hex')
  // `parseInt` accepts non-hex characters (returning NaN) and
  // assigning NaN to a Uint8Array cell silently coerces to 0. Without
  // this guard a CEK string containing any non-hex char would be
  // converted to a zero-byte buffer and used to encrypt user data
  // under what is effectively a known constant key.
  if (!/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error('sync-api: invalid hex')
  }
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
