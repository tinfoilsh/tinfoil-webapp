import { describe, expect, it } from 'vitest'

import {
  classifyEnclaveError,
  type EnclaveErrorCode,
} from '@/services/sync-enclave/enclave-error-classification'
import { SyncEnclaveError } from '@/services/sync-enclave/sync-enclave-client'

function err(code: string, status?: number) {
  return new SyncEnclaveError(code, status, code)
}

describe('classifyEnclaveError', () => {
  it('returns one of the four §9.6 R2 buckets for every Appendix B code', () => {
    const expectations: Record<EnclaveErrorCode, string> = {
      STALE_KEY: 'RETRYABLE_REFRESH',
      STALE_BLOB: 'USER_DECISION',
      SYNC_CONFLICT: 'USER_DECISION',
      EXISTING_DATA_UNDER_OTHER_KEY: 'USER_DECISION',
      IDEMPOTENCY_CONFLICT: 'TERMINAL',
      UNKNOWN_KEY: 'TERMINAL',
      FORBIDDEN: 'TERMINAL',
      ATTESTATION_FAILED: 'TERMINAL',
      AUTH: 'RETRYABLE_TRANSIENT',
      NETWORK: 'RETRYABLE_TRANSIENT',
      NOT_FOUND: 'USER_DECISION',
      LEGACY_BLOB_NOT_MIGRATED: 'RETRYABLE_REFRESH',
    }
    for (const [code, kind] of Object.entries(expectations)) {
      const result = classifyEnclaveError(err(code))
      expect(result.kind, `code=${code}`).toBe(kind)
      expect(result.code).toBe(code)
    }
  })

  it('maps 5xx without a code to RETRYABLE_TRANSIENT', () => {
    const result = classifyEnclaveError(
      new SyncEnclaveError('boom', 503, undefined),
    )
    expect(result.kind).toBe('RETRYABLE_TRANSIENT')
  })

  it('maps 401 without a code to RETRYABLE_TRANSIENT/AUTH', () => {
    const result = classifyEnclaveError(
      new SyncEnclaveError('unauthorized', 401, undefined),
    )
    expect(result.kind).toBe('RETRYABLE_TRANSIENT')
    expect(result.code).toBe('AUTH')
  })

  it('maps 403 without a code to TERMINAL/FORBIDDEN', () => {
    const result = classifyEnclaveError(
      new SyncEnclaveError('forbidden', 403, undefined),
    )
    expect(result.kind).toBe('TERMINAL')
    expect(result.code).toBe('FORBIDDEN')
  })

  it('maps TypeError "Failed to fetch" to RETRYABLE_TRANSIENT/NETWORK', () => {
    const result = classifyEnclaveError(new TypeError('Failed to fetch'))
    expect(result.kind).toBe('RETRYABLE_TRANSIENT')
    expect(result.code).toBe('NETWORK')
  })

  it('maps Safari TypeError "Load failed" to RETRYABLE_TRANSIENT/NETWORK', () => {
    const result = classifyEnclaveError(new TypeError('Load failed'))
    expect(result.kind).toBe('RETRYABLE_TRANSIENT')
    expect(result.code).toBe('NETWORK')
  })

  it('maps attestation failures to TERMINAL/ATTESTATION_FAILED', () => {
    const result = classifyEnclaveError(
      new Error('enclave attestation verification failed'),
    )
    expect(result.kind).toBe('TERMINAL')
    expect(result.code).toBe('ATTESTATION_FAILED')
  })

  it('falls through to TERMINAL for unknown errors', () => {
    const result = classifyEnclaveError(new Error('???'))
    expect(result.kind).toBe('TERMINAL')
    expect(result.code).toBeUndefined()
  })
})
