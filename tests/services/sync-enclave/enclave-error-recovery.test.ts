import { describe, expect, it } from 'vitest'

import type { EnclaveErrorCode } from '@/services/sync-enclave/enclave-error-classification'
import {
  decideRecovery,
  type RecoveryAction,
} from '@/services/sync-enclave/enclave-error-recovery'
import {
  SyncEnclaveError,
  SyncNetworkError,
} from '@/services/sync-enclave/sync-enclave-client'

describe('decideRecovery', () => {
  const expectedActions = {
    STALE_KEY: { type: 'refresh-current-key-and-retry' },
    STALE_BLOB: { type: 'surface-conflict', reason: 'STALE_BLOB' },
    SYNC_CONFLICT: { type: 'surface-conflict', reason: 'SYNC_CONFLICT' },
    IDEMPOTENCY_CONFLICT: { type: 'abort', reason: 'IDEMPOTENCY_CONFLICT' },
    EXISTING_DATA_UNDER_OTHER_KEY: {
      type: 'surface-existing-data-under-other-key',
    },
    UNKNOWN_KEY: { type: 'trigger-recovery-wizard', reason: 'UNKNOWN_KEY' },
    LEGACY_BLOB_NOT_MIGRATED: { type: 'migrate-legacy-and-retry' },
    ATTESTATION_FAILED: {
      type: 'block-all-sync',
      reason: 'ATTESTATION_FAILED',
    },
    AUTH: { type: 'retry', reason: 'AUTH_REFRESH' },
    AUTH_PERSISTENT: { type: 'abort', reason: 'AUTH_PERSISTENT' },
    FORBIDDEN: { type: 'abort', reason: 'FORBIDDEN' },
    NETWORK: { type: 'retry', reason: 'NETWORK' },
    NOT_FOUND: { type: 'surface-not-found' },
    PAYLOAD_TOO_LARGE: { type: 'abort', reason: 'PAYLOAD_TOO_LARGE' },
    // Bare code with no ids: nothing to re-upload, so it aborts. The
    // populated case is covered below.
    MISSING_ATTACHMENT: { type: 'abort', reason: 'UNKNOWN' },
    ATTACHMENT_PURGE_IN_PROGRESS: { type: 'retry', reason: 'TRANSIENT_5XX' },
  } satisfies Record<EnclaveErrorCode, RecoveryAction>
  it.each(Object.entries(expectedActions))(
    'maps %s to its exact recovery action',
    (code, action) => {
      const decision = decideRecovery(
        new SyncEnclaveError('opaque', undefined, code),
      )
      expect(decision.action).toEqual(action)
      expect(decision.classification.code).toBe(code)
      if (code === 'MISSING_ATTACHMENT')
        expect(
          decideRecovery(new SyncEnclaveError('opaque', 409, code, {})).action,
        ).toEqual(action)
      if (code === 'PAYLOAD_TOO_LARGE')
        expect(
          decideRecovery(new SyncEnclaveError('opaque', 413, code)).action,
        ).toEqual(action)
    },
  )

  it('maps a typed network failure to retry', () => {
    const decision = decideRecovery(new SyncNetworkError())
    expect(decision.action.type).toBe('retry')
    if (decision.action.type === 'retry') {
      expect(decision.action.reason).toBe('NETWORK')
    }
  })

  it('carries the purged attachment ids into the reupload action', () => {
    const decision = decideRecovery(
      new SyncEnclaveError('missing', 409, 'MISSING_ATTACHMENT', {
        missing_attachments: ['att-a', 'att-b', 42],
      }),
    )
    expect(decision.action).toEqual({
      type: 'reupload-attachments-and-retry',
      attachmentIds: ['att-a', 'att-b'],
    })
  })

  it('maps a 5xx with no code to retry', () => {
    const decision = decideRecovery(
      new SyncEnclaveError('boom', 503, undefined),
    )
    expect(decision.action.type).toBe('retry')
    if (decision.action.type === 'retry') {
      expect(decision.action.reason).toBe('TRANSIENT_5XX')
    }
  })

  it('falls through to abort for unknown errors', () => {
    const decision = decideRecovery(new Error('???'))
    expect(decision.action.type).toBe('abort')
  })
})
