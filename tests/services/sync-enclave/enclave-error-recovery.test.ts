import { describe, expect, it } from 'vitest'

import type { EnclaveErrorCode } from '@/services/sync-enclave/enclave-error-classification'
import {
  COVERED_CODES,
  decideRecovery,
  type RecoveryAction,
} from '@/services/sync-enclave/enclave-error-recovery'
import {
  SyncEnclaveError,
  SyncNetworkError,
} from '@/services/sync-enclave/sync-enclave-client'

function err(code: EnclaveErrorCode, status?: number) {
  return new SyncEnclaveError(code, status, code)
}

describe('decideRecovery', () => {
  it('covers every Appendix B error code', () => {
    const required: EnclaveErrorCode[] = [
      'STALE_KEY',
      'STALE_BLOB',
      'SYNC_CONFLICT',
      'IDEMPOTENCY_CONFLICT',
      'EXISTING_DATA_UNDER_OTHER_KEY',
      'UNKNOWN_KEY',
      'LEGACY_BLOB_NOT_MIGRATED',
      'ATTESTATION_FAILED',
      'AUTH',
      'AUTH_PERSISTENT',
      'FORBIDDEN',
      'NETWORK',
      'NOT_FOUND',
      'PAYLOAD_TOO_LARGE',
      'MISSING_ATTACHMENT',
      'ATTACHMENT_PURGE_IN_PROGRESS',
    ]
    for (const code of required) {
      expect(COVERED_CODES, code).toContain(code)
    }
    expect(COVERED_CODES).toHaveLength(required.length)
  })

  it.each<[EnclaveErrorCode, RecoveryAction['type']]>([
    ['STALE_KEY', 'refresh-current-key-and-retry'],
    ['STALE_BLOB', 'surface-conflict'],
    ['SYNC_CONFLICT', 'surface-conflict'],
    ['IDEMPOTENCY_CONFLICT', 'abort'],
    ['EXISTING_DATA_UNDER_OTHER_KEY', 'surface-existing-data-under-other-key'],
    ['UNKNOWN_KEY', 'trigger-recovery-wizard'],
    ['LEGACY_BLOB_NOT_MIGRATED', 'migrate-legacy-and-retry'],
    ['ATTESTATION_FAILED', 'block-all-sync'],
    ['AUTH', 'retry'],
    ['AUTH_PERSISTENT', 'abort'],
    ['FORBIDDEN', 'abort'],
    ['NETWORK', 'retry'],
    ['NOT_FOUND', 'surface-not-found'],
    ['PAYLOAD_TOO_LARGE', 'abort'],
    // Bare code with no ids: nothing to re-upload, so it aborts. The
    // populated case is covered below.
    ['MISSING_ATTACHMENT', 'abort'],
    ['ATTACHMENT_PURGE_IN_PROGRESS', 'retry'],
  ])('maps %s → %s', (code, type) => {
    const decision = decideRecovery(err(code))
    expect(decision.action.type).toBe(type)
    expect(decision.classification.code).toBe(code)
  })

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

  it('aborts a MISSING_ATTACHMENT that names no attachments', () => {
    const decision = decideRecovery(
      new SyncEnclaveError('missing', 409, 'MISSING_ATTACHMENT', {}),
    )
    expect(decision.action).toEqual({ type: 'abort', reason: 'UNKNOWN' })
  })

  it('never retries an oversized payload', () => {
    const decision = decideRecovery(err('PAYLOAD_TOO_LARGE', 413))
    expect(decision.action.type).toBe('abort')
    if (decision.action.type === 'abort') {
      expect(decision.action.reason).toBe('PAYLOAD_TOO_LARGE')
    }
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
