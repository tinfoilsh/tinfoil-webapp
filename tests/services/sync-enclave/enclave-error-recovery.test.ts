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
