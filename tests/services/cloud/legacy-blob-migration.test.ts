import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/utils/error-handling', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
}))

const mockMigrateAll = vi.fn()
const mockMigrateStatus = vi.fn()
const mockRequirePrimaryKeyB64 = vi.fn<() => string>()
const mockPullKeys = vi.fn<() => Array<{ key: string }>>()

vi.mock('@/services/sync-enclave/sync-api', async () => {
  const real = await vi.importActual<
    typeof import('@/services/sync-enclave/sync-api')
  >('@/services/sync-enclave/sync-api')
  return {
    ...real,
    migrateAll: (...args: unknown[]) => mockMigrateAll(...args),
    migrateStatus: (...args: unknown[]) => mockMigrateStatus(...args),
  }
})

vi.mock('@/services/cloud/cek-encoding', () => ({
  requirePrimaryKeyB64: () => mockRequirePrimaryKeyB64(),
  migrationKeys: () => mockPullKeys(),
}))

const mockClearFallbackKeys = vi.fn()
const mockGetFallbackKeyCount = vi.fn<() => number>()
const mockHasPendingChatRecoveries = vi.fn()

vi.mock('@/services/encryption/encryption-service', () => ({
  encryptionService: {
    clearFallbackKeys: () => mockClearFallbackKeys(),
    getFallbackKeyCount: () => mockGetFallbackKeyCount(),
  },
}))

vi.mock('@/services/storage/indexed-db', () => ({
  indexedDBStorage: {
    hasPendingChatRecoveries: () => mockHasPendingChatRecoveries(),
  },
}))

import {
  finalizeAlternativesIfMigrated,
  hasDeferredAlternativesFinalization,
  markRecoveryHistoryReady,
  resetAlternativesFinalizationState,
  runLegacyBlobMigration,
  runLegacyBlobMigrationAndFinalize,
  type MigrationReport,
} from '@/services/cloud/legacy-blob-migration'

const ALL_SCOPES = ['profile', 'chat', 'project', 'project_document'] as const

function emptyEnclaveReport() {
  return {
    migrated: 0,
    retryable_remaining: 0,
    blocked_unmigrated: 0,
    partial: false,
    scopes: ALL_SCOPES.map((scope) => ({
      scope,
      migrated: 0,
      retryable_remaining: 0,
      blocked_unmigrated: 0,
    })),
  }
}

describe('runLegacyBlobMigration', () => {
  beforeEach(() => {
    mockMigrateAll.mockReset()
    mockMigrateStatus.mockReset()
    mockRequirePrimaryKeyB64.mockReset()
    mockPullKeys.mockReset()
    mockClearFallbackKeys.mockReset()
    mockGetFallbackKeyCount.mockReset()
    mockGetFallbackKeyCount.mockReturnValue(0)
    mockHasPendingChatRecoveries.mockReset()
    mockHasPendingChatRecoveries.mockResolvedValue(false)
    resetAlternativesFinalizationState()
    mockRequirePrimaryKeyB64.mockReturnValue('PRIMARY_B64')
    mockPullKeys.mockReturnValue([{ key: 'PRIMARY_B64' }, { key: 'ALT_B64' }])
  })

  afterEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  it('calls the enclave once when nothing needs migrating', async () => {
    mockMigrateAll.mockResolvedValue(emptyEnclaveReport())
    const report = await runLegacyBlobMigration()
    expect(mockMigrateAll).toHaveBeenCalledTimes(1)
    expect(report.fullyMigrated).toBe(true)
    expect(report.totalMigrated).toBe(0)
    expect(report.totalRemaining).toBe(0)
    expect(report.totalBlocked).toBe(0)
  })

  it('passes primary + alternatives to the enclave as candidate keys', async () => {
    mockMigrateAll.mockResolvedValue(emptyEnclaveReport())
    await runLegacyBlobMigration()
    const arg = mockMigrateAll.mock.calls[0][0]
    expect(arg.keys).toEqual([{ key: 'PRIMARY_B64' }, { key: 'ALT_B64' }])
    expect(arg.target).toEqual({ key: 'PRIMARY_B64' })
  })

  it('aggregates per-scope counts into a flat report', async () => {
    mockMigrateAll.mockResolvedValue({
      migrated: 150,
      retryable_remaining: 0,
      blocked_unmigrated: 2,
      partial: false,
      scopes: [
        {
          scope: 'profile',
          migrated: 1,
          retryable_remaining: 0,
          blocked_unmigrated: 0,
        },
        {
          scope: 'chat',
          migrated: 149,
          retryable_remaining: 0,
          blocked_unmigrated: 2,
          blocked: ['row-a', 'row-b'],
        },
      ],
    })
    const report = await runLegacyBlobMigration()
    expect(report.totalMigrated).toBe(150)
    expect(report.totalBlocked).toBe(2)
    expect(report.fullyMigrated).toBe(true)
    const chatScope = report.scopes.find((s) => s.scope === 'chat')!
    expect(chatScope.blocked).toEqual(['row-a', 'row-b'])
  })

  it('polls migrate-status until the enclave reports the job completed', async () => {
    vi.useFakeTimers()
    mockMigrateAll.mockResolvedValue({
      migrated: 0,
      retryable_remaining: 250,
      blocked_unmigrated: 0,
      partial: true,
      status: 'running',
      job_id: 'job-1',
      scopes: [
        {
          scope: 'chat',
          migrated: 0,
          retryable_remaining: 250,
          blocked_unmigrated: 0,
        },
      ],
    })
    mockMigrateStatus
      .mockResolvedValueOnce({
        migrated: 200,
        retryable_remaining: 50,
        blocked_unmigrated: 0,
        partial: true,
        status: 'running',
        job_id: 'job-1',
        scopes: [
          {
            scope: 'chat',
            migrated: 200,
            retryable_remaining: 50,
            blocked_unmigrated: 0,
          },
        ],
      })
      .mockResolvedValueOnce({
        migrated: 250,
        retryable_remaining: 0,
        blocked_unmigrated: 0,
        partial: false,
        status: 'completed',
        job_id: 'job-1',
        scopes: [
          {
            scope: 'chat',
            migrated: 250,
            retryable_remaining: 0,
            blocked_unmigrated: 0,
          },
        ],
      })
    const promise = runLegacyBlobMigration()
    await vi.runAllTimersAsync()
    const report = await promise
    expect(mockMigrateAll).toHaveBeenCalledTimes(1)
    expect(mockMigrateStatus).toHaveBeenCalledTimes(2)
    expect(report.fullyMigrated).toBe(true)
    expect(report.totalMigrated).toBe(250)
  })

  it('caps the poll budget so a permanently-running enclave cannot spin forever', async () => {
    vi.useFakeTimers()
    mockMigrateAll.mockResolvedValue({
      migrated: 1,
      retryable_remaining: 99,
      blocked_unmigrated: 0,
      partial: true,
      status: 'running',
      job_id: 'job-stuck',
      scopes: [
        {
          scope: 'chat',
          migrated: 1,
          retryable_remaining: 99,
          blocked_unmigrated: 0,
        },
      ],
    })
    mockMigrateStatus.mockResolvedValue({
      migrated: 1,
      retryable_remaining: 99,
      blocked_unmigrated: 0,
      partial: true,
      status: 'running',
      job_id: 'job-stuck',
      scopes: [
        {
          scope: 'chat',
          migrated: 1,
          retryable_remaining: 99,
          blocked_unmigrated: 0,
        },
      ],
    })
    const promise = runLegacyBlobMigration()
    await vi.advanceTimersByTimeAsync(16 * 60_000)
    const report = await promise
    expect(mockMigrateStatus).toHaveBeenCalled()
    expect(report.fullyMigrated).toBe(false)
    expect(report.totalRemaining).toBe(99)
  })

  it('rethrows when the enclave errors on the first pass so callers can retry', async () => {
    mockMigrateAll.mockRejectedValue(new Error('boom'))
    await expect(runLegacyBlobMigration()).rejects.toThrow('boom')
  })
})

function buildReport(
  overrides: Partial<MigrationReport> = {},
): MigrationReport {
  return {
    scopes: [],
    totalMigrated: 0,
    totalRemaining: 0,
    totalBlocked: 0,
    fullyMigrated: true,
    ...overrides,
  }
}

describe('finalizeAlternativesIfMigrated', () => {
  beforeEach(() => {
    mockClearFallbackKeys.mockReset()
    mockGetFallbackKeyCount.mockReset()
    mockGetFallbackKeyCount.mockReturnValue(0)
    mockHasPendingChatRecoveries.mockReset()
    mockHasPendingChatRecoveries.mockResolvedValue(false)
    resetAlternativesFinalizationState()
  })

  it('is a no-op when migration is not fully complete', async () => {
    const ran = await finalizeAlternativesIfMigrated(
      buildReport({ fullyMigrated: false, totalRemaining: 5 }),
    )
    expect(ran).toBe(false)
    expect(mockClearFallbackKeys).not.toHaveBeenCalled()
  })

  it('clears fallback keys when fullyMigrated is true', async () => {
    mockGetFallbackKeyCount.mockReturnValue(3)
    expect(
      await finalizeAlternativesIfMigrated(buildReport({ totalMigrated: 12 })),
    ).toBe(false)
    await markRecoveryHistoryReady()
    expect(mockClearFallbackKeys).toHaveBeenCalledOnce()
  })

  it('keeps fallback keys while recovery envelopes still need them', async () => {
    mockHasPendingChatRecoveries.mockResolvedValue(true)
    expect(await finalizeAlternativesIfMigrated(buildReport())).toBe(false)
    await markRecoveryHistoryReady()
    expect(mockClearFallbackKeys).not.toHaveBeenCalled()
  })

  it('clears fallback keys after deferred history readiness', async () => {
    mockGetFallbackKeyCount.mockReturnValue(0)
    await finalizeAlternativesIfMigrated(buildReport())
    await markRecoveryHistoryReady()
    expect(mockClearFallbackKeys).toHaveBeenCalledOnce()
  })

  it('retries deferred cleanup after recovery history is fully ingested', async () => {
    expect(await finalizeAlternativesIfMigrated(buildReport())).toBe(false)
    expect(mockClearFallbackKeys).not.toHaveBeenCalled()

    await markRecoveryHistoryReady()

    expect(mockClearFallbackKeys).toHaveBeenCalledOnce()
  })

  it('preserves history readiness reported before migration completes', async () => {
    await markRecoveryHistoryReady()

    expect(await finalizeAlternativesIfMigrated(buildReport())).toBe(true)
    expect(mockClearFallbackKeys).toHaveBeenCalledOnce()
  })

  it('keeps repeated finalization of the same report idempotent', async () => {
    const report = buildReport()
    expect(await finalizeAlternativesIfMigrated(report)).toBe(false)
    await markRecoveryHistoryReady()

    expect(await finalizeAlternativesIfMigrated(report)).toBe(true)
    expect(mockClearFallbackKeys).toHaveBeenCalledOnce()
    expect(hasDeferredAlternativesFinalization()).toBe(false)
  })

  it('does not clear fallback keys after finalization state resets', async () => {
    let resolvePending: ((value: boolean) => void) | undefined
    await finalizeAlternativesIfMigrated(buildReport())
    mockHasPendingChatRecoveries.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        resolvePending = resolve
      }),
    )

    const readiness = markRecoveryHistoryReady()
    resetAlternativesFinalizationState()
    resolvePending?.(false)
    await readiness

    expect(mockClearFallbackKeys).not.toHaveBeenCalled()
  })
})

describe('runLegacyBlobMigrationAndFinalize', () => {
  beforeEach(() => {
    mockMigrateAll.mockReset()
    mockRequirePrimaryKeyB64.mockReset()
    mockPullKeys.mockReset()
    mockClearFallbackKeys.mockReset()
    mockGetFallbackKeyCount.mockReset()
    mockGetFallbackKeyCount.mockReturnValue(0)
    mockHasPendingChatRecoveries.mockReset()
    mockHasPendingChatRecoveries.mockResolvedValue(false)
    resetAlternativesFinalizationState()
    mockRequirePrimaryKeyB64.mockReturnValue('PRIMARY_B64')
    mockPullKeys.mockReturnValue([{ key: 'PRIMARY_B64' }])
  })

  it('clears fallback keys when every scope drains', async () => {
    mockMigrateAll.mockResolvedValue(emptyEnclaveReport())
    const report = await runLegacyBlobMigrationAndFinalize()
    expect(report.fullyMigrated).toBe(true)
    expect(mockClearFallbackKeys).not.toHaveBeenCalled()
    await markRecoveryHistoryReady()
    expect(mockClearFallbackKeys).toHaveBeenCalledOnce()
  })

  it('keeps fallback keys when remaining rows are reported', async () => {
    mockMigrateAll.mockResolvedValue({
      migrated: 0,
      retryable_remaining: 1,
      blocked_unmigrated: 0,
      partial: false,
      scopes: [
        {
          scope: 'chat',
          migrated: 0,
          retryable_remaining: 1,
          blocked_unmigrated: 0,
        },
      ],
    })
    const report = await runLegacyBlobMigrationAndFinalize()
    expect(report.fullyMigrated).toBe(false)
    expect(mockClearFallbackKeys).not.toHaveBeenCalled()
  })
})
