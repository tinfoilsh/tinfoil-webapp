/**
 * Canonical TypeScript mirror of the Go wire contract defined in
 * github.com/tinfoilsh/controlplane/pkg/contract (headers.go,
 * sentinels.go, wirecodes.go).
 *
 * These strings are the public surface of the /api/sync/* HTTP API
 * the enclave and webapp talk to; renaming any of them is a
 * cross-repo wire break. When the controlplane changes the canonical
 * Go contract, this file must be updated to match — wire-contract.test.ts
 * pins every constant to its expected literal value so a typo here
 * fails CI instead of silently drifting from the server.
 *
 * Source of truth (do not edit independently):
 *   - controlplane/pkg/contract/headers.go
 *   - controlplane/pkg/contract/sentinels.go
 *   - controlplane/pkg/contract/wirecodes.go
 */

/** Request headers the webapp sends to /api/sync/*. */
export const SYNC_HEADERS = {
  SyncProtocol: 'X-Sync-Protocol',
  Idempotency: 'X-Idempotency-Key',
  KeyID: 'X-Key-Id',
  IfMatch: 'If-Match',
  ETag: 'ETag',
  OperationHash: 'X-Operation-Hash',
  MessageCount: 'X-Message-Count',
  ProjectID: 'X-Project-Id',
  ProjectIDSet: 'X-Project-Id-Set',
  ProfileSyncProtocol: 'X-Profile-Sync-Protocol',
} as const

export const SYNC_PROTOCOL_VERSION = '3'

/** Opt-in headers that bypass the legacy tombstone guard on re-upload. */
export const RESTORE_DELETED_HEADERS = {
  Chat: 'X-Restore-Deleted-Chat',
  Profile: 'X-Restore-Deleted-Profile',
  Project: 'X-Restore-Deleted-Project',
  ProjectDocument: 'X-Restore-Deleted-Project-Document',
} as const

/** Sentinel If-Match values; see controlplane/pkg/contract/sentinels.go. */
export const IF_MATCH_SENTINELS = {
  /** "Create only" — succeeds only if no row exists yet (blob scope). */
  CreateOnly: '0',
  /** "Any key" — succeeds only if no key is registered for the user. */
  AnyKey: '*',
} as const

/** JSON error wire codes embedded under `code` in apperrors responses. */
export const WIRE_CODES = {
  PreconditionRequired: 'PRECONDITION_REQUIRED',
  StaleBlob: 'STALE_BLOB',
  StaleKey: 'STALE_KEY',
  IdempotencyConflict: 'IDEMPOTENCY_CONFLICT',
  ExistingDataUnderOtherKey: 'EXISTING_DATA_UNDER_OTHER_KEY',
  SyncConflict: 'SYNC_CONFLICT',
  ProfileSyncUpgradeRequired: 'PROFILE_SYNC_UPGRADE_REQUIRED',
} as const

/**
 * Attachment ids the enclave mints: 18 random bytes, hex encoded. A chat
 * push reports the id of every attachment carrying a server key, and the
 * controlplane rejects the push when any of them has another shape; see
 * controlplane handlers/sync_blob_handler.go (isAttachmentID).
 */
const ENCLAVE_ATTACHMENT_ID = /^[0-9a-f]{36}$/

export function isEnclaveAttachmentId(id: string): boolean {
  return ENCLAVE_ATTACHMENT_ID.test(id)
}

/**
 * Sync enclave pull contract; see confidential-sync
 * internal/server/ops.go (MaxPullIDs) and errors.go (item codes).
 */

/** Upper bound on `ids` per pull request; larger batches are a 400. */
export const MAX_PULL_IDS = 100

/**
 * Per-item `code` values the enclave sets when a pull item has
 * `ok=false`. Every value here is emitted by the enclave's pullOne.
 */
export const PULL_ITEM_CODES = {
  NotFound: 'NOT_FOUND',
  UnknownKey: 'UNKNOWN_KEY',
  Network: 'NETWORK',
  BadRequest: 'BAD_REQUEST',
  LegacyBlobNotMigrated: 'LEGACY_BLOB_NOT_MIGRATED',
} as const

/**
 * Stand-in used when an `ok=false` item arrives without a code, so
 * downstream classification never has to handle `undefined`.
 */
export const PULL_ITEM_CODE_UNSPECIFIED = 'UNSPECIFIED'

/**
 * Request budgets of the enclave routes the webapp calls that run longer
 * than the standard 30 seconds; see confidential-sync
 * internal/server/http.go (SyncPushRequestTimeout, AttachmentRequestTimeout).
 * The client waits as long as the enclave works on a request, no longer.
 */
const PUSH_REQUEST_BUDGET_MS = 60_000
const TRANSFER_REQUEST_BUDGET_MS = 5 * 60_000

export const EXTENDED_ROUTE_BUDGETS_MS: Readonly<
  Partial<Record<string, number>>
> = {
  '/v1/sync/push': PUSH_REQUEST_BUDGET_MS,
  '/v1/sync/fork': TRANSFER_REQUEST_BUDGET_MS,
  '/v1/attachment/put': TRANSFER_REQUEST_BUDGET_MS,
  '/v1/attachment/get': TRANSFER_REQUEST_BUDGET_MS,
  '/v1/attachment/get-public': TRANSFER_REQUEST_BUDGET_MS,
  '/v1/import/upload': TRANSFER_REQUEST_BUDGET_MS,
}

export type SyncHeaderName = (typeof SYNC_HEADERS)[keyof typeof SYNC_HEADERS]
export type RestoreDeletedHeaderName =
  (typeof RESTORE_DELETED_HEADERS)[keyof typeof RESTORE_DELETED_HEADERS]
export type IfMatchSentinel =
  (typeof IF_MATCH_SENTINELS)[keyof typeof IF_MATCH_SENTINELS]
export type WireCode = (typeof WIRE_CODES)[keyof typeof WIRE_CODES]
export type PullItemCode =
  | (typeof PULL_ITEM_CODES)[keyof typeof PULL_ITEM_CODES]
  | typeof PULL_ITEM_CODE_UNSPECIFIED
