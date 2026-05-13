import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/utils/error-handling', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
}))

const mockMigrate = vi.fn()
const mockRequirePrimaryKeyB64 = vi.fn<() => string>()
const mockPullKeys = vi.fn<() => Array<{ key: string }>>()

vi.mock('@/services/sync-enclave/sync-api', async () => {
  const real = await vi.importActual<
    typeof import('@/services/sync-enclave/sync-api')
  >('@/services/sync-enclave/sync-api')
  return {
    ...real,
    migrate: (...args: unknown[]) => mockMigrate(...args),
  }
})

vi.mock('@/services/cloud/cek-encoding', () => ({
  requirePrimaryKeyB64: () => mockRequirePrimaryKeyB64(),
  pullKeysFromEncryptionService: () => mockPullKeys(),
}))

const mockClearFallbackKeys = vi.fn()
const mockGetFallbackKeyCount = vi.fn<() => number>()

vi.mock('@/services/encryption/encryption-service', () => ({
  encryptionService: {
    clearFallbackKeys: () => mockClearFallbackKeys(),
    getFallbackKeyCount: () => mockGetFallbackKeyCount(),
  },
}))

import {
  finalizeAlternativesIfMigrated,
  runLegacyBlobMigration,
  runLegacyBlobMigrationAndFinalize,
  type MigrationReport,
} from '@/services/cloud/legacy-blob-migration'

const ALL_SCOPES = ['profile', 'chat', 'project', 'project_document']

describe('runLegacyBlobMigration', () => {
  beforeEach(() => {
    mockMigrate.mockReset()
    mockRequirePrimaryKeyB64.mockReset()
    mockPullKeys.mockReset()
    mockClearFallbackKeys.mockReset()
    mockGetFallbackKeyCount.mockReset()
    mockGetFallbackKeyCount.mockReturnValue(0)
    mockRequirePrimaryKeyB64.mockReturnValue('PRIMARY_B64')
    mockPullKeys.mockReturnValue([{ key: 'PRIMARY_B64' }, { key: 'ALT_B64' }])
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('walks every scope once when nothing needs migrating', async () => {
    mockMigrate.mockResolvedValue({
      migrated: 0,
      retryable_remaining: 0,
      blocked_unmigrated: 0,
      blocked: [],
    })
    const report = await runLegacyBlobMigration()
    expect(mockMigrate).toHaveBeenCalledTimes(ALL_SCOPES.length)
    expect(report.fullyMigrated).toBe(true)
    expect(report.totalMigrated).toBe(0)
    expect(report.totalRemaining).toBe(0)
    expect(report.totalBlocked).toBe(0)
  })

  it('loops a scope until the enclave reports no retryable remaining', async () => {
    let call = 0
    mockMigrate.mockImplementation(async () => {
      call += 1
      // First scope: two batches, then drain. Other scopes: empty.
      if (call === 1) {
        return {
          migrated: 100,
          retryable_remaining: 50,
          blocked_unmigrated: 0,
          blocked: [],
        }
      }
      if (call === 2) {
        return {
          migrated: 50,
          retryable_remaining: 0,
          blocked_unmigrated: 0,
          blocked: [],
        }
      }
      return {
        migrated: 0,
        retryable_remaining: 0,
        blocked_unmigrated: 0,
        blocked: [],
      }
    })
    const report = await runLegacyBlobMigration()
    expect(report.fullyMigrated).toBe(true)
    expect(report.totalMigrated).toBe(150)
    const firstScope = report.scopes[0]
    expect(firstScope.batches).toBe(2)
    expect(firstScope.migrated).toBe(150)
  })

  it('passes primary + alternatives to the enclave as candidate keys', async () => {
    mockMigrate.mockResolvedValue({
      migrated: 0,
      retryable_remaining: 0,
      blocked_unmigrated: 0,
      blocked: [],
    })
    await runLegacyBlobMigration()
    const arg = mockMigrate.mock.calls[0][0]
    expect(arg.keys).toEqual([{ key: 'PRIMARY_B64' }, { key: 'ALT_B64' }])
    expect(arg.target).toEqual({ key: 'PRIMARY_B64' })
  })

  it('surfaces blocked ids and excludes them from "remaining"', async () => {
    mockMigrate.mockResolvedValueOnce({
      migrated: 5,
      retryable_remaining: 0,
      blocked_unmigrated: 2,
      blocked: ['row-a', 'row-b'],
    })
    mockMigrate.mockResolvedValue({
      migrated: 0,
      retryable_remaining: 0,
      blocked_unmigrated: 0,
      blocked: [],
    })
    const report = await runLegacyBlobMigration()
    expect(report.totalBlocked).toBe(2)
    expect(report.totalRemaining).toBe(0)
    // fullyMigrated reflects retryable_remaining only; blocked rows
    // are surfaced separately as candidates for LOST.
    expect(report.fullyMigrated).toBe(true)
    expect(report.scopes[0].blocked).toEqual(['row-a', 'row-b'])
  })

  it('breaks out of a scope when the enclave returns an error', async () => {
    mockMigrate.mockRejectedValueOnce(new Error('boom')).mockResolvedValue({
      migrated: 0,
      retryable_remaining: 0,
      blocked_unmigrated: 0,
      blocked: [],
    })
    const report = await runLegacyBlobMigration()
    // First scope aborted early — its remaining stays 0 (we don't
    // know better) and the rest still ran.
    expect(report.scopes.length).toBe(ALL_SCOPES.length)
    expect(report.scopes[0].batches).toBe(0)
  })

  it('caps batches per scope to avoid spinning forever on an enclave regression', async () => {
    // Enclave forever says "migrated 0, remaining 1". The loop must
    // break by the zero-progress guard within one batch, not run to
    // MIGRATE_MAX_BATCHES_PER_SCOPE.
    mockMigrate.mockResolvedValue({
      migrated: 0,
      retryable_remaining: 1,
      blocked_unmigrated: 0,
      blocked: [],
    })
    const report = await runLegacyBlobMigration()
    // Each scope runs exactly one batch because progress=0 trips the
    // defensive break.
    for (const scope of report.scopes) {
      expect(scope.batches).toBe(1)
    }
    expect(report.fullyMigrated).toBe(false)
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
  })

  it('is a no-op when migration is not fully complete', () => {
    const ran = finalizeAlternativesIfMigrated(
      buildReport({ fullyMigrated: false, totalRemaining: 5 }),
    )
    expect(ran).toBe(false)
    expect(mockClearFallbackKeys).not.toHaveBeenCalled()
  })

  it('clears fallback keys when fullyMigrated is true', () => {
    mockGetFallbackKeyCount.mockReturnValue(3)
    const ran = finalizeAlternativesIfMigrated(
      buildReport({ totalMigrated: 12 }),
    )
    expect(ran).toBe(true)
    expect(mockClearFallbackKeys).toHaveBeenCalledOnce()
  })

  it('is idempotent — still returns true when no fallbacks remain', () => {
    mockGetFallbackKeyCount.mockReturnValue(0)
    expect(finalizeAlternativesIfMigrated(buildReport())).toBe(true)
    expect(mockClearFallbackKeys).toHaveBeenCalledOnce()
  })
})

describe('runLegacyBlobMigrationAndFinalize', () => {
  beforeEach(() => {
    mockMigrate.mockReset()
    mockRequirePrimaryKeyB64.mockReset()
    mockPullKeys.mockReset()
    mockClearFallbackKeys.mockReset()
    mockGetFallbackKeyCount.mockReset()
    mockGetFallbackKeyCount.mockReturnValue(0)
    mockRequirePrimaryKeyB64.mockReturnValue('PRIMARY_B64')
    mockPullKeys.mockReturnValue([{ key: 'PRIMARY_B64' }])
  })

  it('clears fallback keys when every scope drains', async () => {
    mockMigrate.mockResolvedValue({
      migrated: 0,
      retryable_remaining: 0,
      blocked_unmigrated: 0,
      blocked: [],
    })
    const report = await runLegacyBlobMigrationAndFinalize()
    expect(report.fullyMigrated).toBe(true)
    expect(mockClearFallbackKeys).toHaveBeenCalledOnce()
  })

  it('keeps fallback keys when remaining rows are reported', async () => {
    mockMigrate.mockResolvedValue({
      migrated: 0,
      retryable_remaining: 1,
      blocked_unmigrated: 0,
      blocked: [],
    })
    const report = await runLegacyBlobMigrationAndFinalize()
    expect(report.fullyMigrated).toBe(false)
    expect(mockClearFallbackKeys).not.toHaveBeenCalled()
  })
})
