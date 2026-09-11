import type { ImportStatusResponse } from '@/services/sync-enclave/sync-api'
import { describe, expect, it } from 'vitest'
import failedFixture from '../../fixtures/native-backup-import-status-failed.json'
import fixture from '../../fixtures/native-backup-import-status.json'

describe('native backup import status contract', () => {
  it('matches the confidential-sync response exactly', () => {
    const status = fixture as ImportStatusResponse
    expect(Object.keys(status)).toEqual([
      'status',
      'phase',
      'imported',
      'failed',
      'total',
      'counts',
      'warnings',
      'errors',
      'project_mappings',
      'job_id',
    ])
    expect(Object.keys(status.counts ?? {})).toEqual([
      'project',
      'document',
      'chat',
    ])
    expect(status.project_mappings).toEqual({
      'source-project': 'destination-project',
    })
  })

  it('carries a failure reason only on a failed job', () => {
    const failed = failedFixture as ImportStatusResponse
    expect(Object.keys(failed)).toEqual([
      'status',
      'phase',
      'imported',
      'failed',
      'total',
      'counts',
      'errors',
      'job_id',
      'failure_reason',
    ])
    expect(failed.status).toBe('failed')
    expect(failed.failure_reason).toBe('timeout')
    expect(fixture).not.toHaveProperty('failure_reason')
  })
})
