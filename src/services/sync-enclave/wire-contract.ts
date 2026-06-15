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
  Idempotency: 'X-Idempotency-Key',
  KeyID: 'X-Key-Id',
  IfMatch: 'If-Match',
  ETag: 'ETag',
  OperationHash: 'X-Operation-Hash',
  MessageCount: 'X-Message-Count',
  ProjectID: 'X-Project-Id',
  ProjectIDSet: 'X-Project-Id-Set',
} as const

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
} as const

export type SyncHeaderName = (typeof SYNC_HEADERS)[keyof typeof SYNC_HEADERS]
export type RestoreDeletedHeaderName =
  (typeof RESTORE_DELETED_HEADERS)[keyof typeof RESTORE_DELETED_HEADERS]
export type IfMatchSentinel =
  (typeof IF_MATCH_SENTINELS)[keyof typeof IF_MATCH_SENTINELS]
export type WireCode = (typeof WIRE_CODES)[keyof typeof WIRE_CODES]
