import { importStatus } from '@/services/sync-enclave/sync-api'
import { resetSyncEnclaveClient } from '@/services/sync-enclave/sync-enclave-client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import failedFixture from '../../fixtures/native-backup-import-status-failed.json'
import fixture from '../../fixtures/native-backup-import-status.json'

const { secureFetch } = vi.hoisted(() => ({ secureFetch: vi.fn() }))
vi.mock('tinfoil', () => ({
  SecureClient: class {
    ready = vi.fn(async () => {})
    fetch = secureFetch
  },
}))
vi.mock('@/services/auth', () => ({
  authTokenManager: { getValidToken: vi.fn(async () => 'test-jwt') },
}))
beforeEach(() => {
  resetSyncEnclaveClient()
  secureFetch.mockReset()
})

describe('native backup import status contract', () => {
  it('preserves the confidential-sync status through the real transport', async () => {
    secureFetch.mockResolvedValueOnce(
      new Response(JSON.stringify(fixture), {
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    const status = await importStatus('job-1')
    expect(status).toEqual(fixture)
    expect(secureFetch).toHaveBeenCalledOnce()
    const [url, init] = secureFetch.mock.calls[0]
    expect(new URL(url).pathname).toBe('/v1/import/status')
    expect(JSON.parse(init.body)).toEqual({ job_id: 'job-1' })
    expect(new Headers(init.headers).get('Authorization')).toBe(
      'Bearer test-jwt',
    )
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

  it('preserves failed-job reasons and completed-job absence through importStatus', async () => {
    secureFetch.mockResolvedValueOnce(
      new Response(JSON.stringify(failedFixture), {
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    const failed = await importStatus('job-1')
    expect(failed).toEqual(failedFixture)
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
    secureFetch.mockResolvedValueOnce(
      new Response(JSON.stringify(fixture), {
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    expect(await importStatus('job-1')).not.toHaveProperty('failure_reason')
  })
})
