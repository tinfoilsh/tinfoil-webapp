/**
 * Pin every wire-contract literal to the exact string the controlplane
 * sends on the wire. The Go source of truth is
 * github.com/tinfoilsh/controlplane/pkg/contract; if a constant changes
 * there and this file is not updated, the test below fails.
 *
 * Do not relax these assertions to "string truthy" — the point is to
 * catch typos before they reach a running server.
 */
import {
  IF_MATCH_SENTINELS,
  MAX_PULL_IDS,
  PULL_ITEM_CODE_UNSPECIFIED,
  PULL_ITEM_CODES,
  RESTORE_DELETED_HEADERS,
  SYNC_HEADERS,
  SYNC_PROTOCOL_VERSION,
  WIRE_CODES,
} from '@/services/keys/wire-contract'

describe('wire-contract', () => {
  it('pins the sync protocol version', () => {
    expect(SYNC_PROTOCOL_VERSION).toBe('2')
  })

  it('headers match controlplane/pkg/contract/headers.go', () => {
    expect(SYNC_HEADERS).toEqual({
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
    })
  })

  it('restore-deleted headers match controlplane/pkg/contract/headers.go', () => {
    expect(RESTORE_DELETED_HEADERS).toEqual({
      Chat: 'X-Restore-Deleted-Chat',
      Profile: 'X-Restore-Deleted-Profile',
      Project: 'X-Restore-Deleted-Project',
      ProjectDocument: 'X-Restore-Deleted-Project-Document',
    })
  })

  it('if-match sentinels match controlplane/pkg/contract/sentinels.go', () => {
    expect(IF_MATCH_SENTINELS).toEqual({
      CreateOnly: '0',
      AnyKey: '*',
    })
  })

  it('wire codes match controlplane/pkg/contract/wirecodes.go', () => {
    expect(WIRE_CODES).toEqual({
      PreconditionRequired: 'PRECONDITION_REQUIRED',
      StaleBlob: 'STALE_BLOB',
      StaleKey: 'STALE_KEY',
      IdempotencyConflict: 'IDEMPOTENCY_CONFLICT',
      ExistingDataUnderOtherKey: 'EXISTING_DATA_UNDER_OTHER_KEY',
      SyncConflict: 'SYNC_CONFLICT',
      ProfileSyncUpgradeRequired: 'PROFILE_SYNC_UPGRADE_REQUIRED',
    })
  })

  it('pull contract matches confidential-sync internal/server', () => {
    expect(MAX_PULL_IDS).toBe(100)
    expect(PULL_ITEM_CODES).toEqual({
      NotFound: 'NOT_FOUND',
      UnknownKey: 'UNKNOWN_KEY',
      Network: 'NETWORK',
      BadRequest: 'BAD_REQUEST',
      LegacyBlobNotMigrated: 'LEGACY_BLOB_NOT_MIGRATED',
    })
    expect(PULL_ITEM_CODE_UNSPECIFIED).toBe('UNSPECIFIED')
  })
})
