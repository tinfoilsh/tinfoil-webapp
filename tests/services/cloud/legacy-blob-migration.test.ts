import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/utils/error-handling', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
}))

const mockMigrateAll = vi.fn()
const mockRequirePrimaryKeyB64 = vi.fn<() => string>()
const mockPullKeys = vi.fn<() => Array<{ key: string }>>()

vi.mock('@/services/sync-enclave/sync-api', async () => {
  const real = await vi.importActual<
    typeof import('@/services/sync-enclave/sync-api')
  >('@/services/sync-enclave/sync-api')
  return {
    ...real,
    migrateAll: (...args: unknown[]) => mockMigrateAll(...args),
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

  it('re-invokes the enclave when the first pass reports partial', async () => {
    mockMigrateAll
      .mockResolvedValueOnce({
        migrated: 200,
        retryable_remaining: 50,
        blocked_unmigrated: 0,
        partial: true,
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
        migrated: 50,
        retryable_remaining: 0,
        blocked_unmigrated: 0,
        partial: false,
        scopes: [
          {
            scope: 'chat',
            migrated: 50,
            retryable_remaining: 0,
            blocked_unmigrated: 0,
          },
        ],
      })
    const report = await runLegacyBlobMigration()
    expect(mockMigrateAll).toHaveBeenCalledTimes(2)
    expect(report.fullyMigrated).toBe(true)
    expect(report.totalMigrated).toBe(250)
  })

  it('caps the pass budget so a permanently-partial enclave cannot spin forever', async () => {
    mockMigrateAll.mockResolvedValue({
      migrated: 1,
      retryable_remaining: 99,
      blocked_unmigrated: 0,
      partial: true,
      scopes: [
        {
          scope: 'chat',
          migrated: 1,
          retryable_remaining: 99,
          blocked_unmigrated: 0,
        },
      ],
    })
    const report = await runLegacyBlobMigration()
    expect(mockMigrateAll).toHaveBeenCalledTimes(2)
    expect(report.fullyMigrated).toBe(false)
    expect(report.totalRemaining).toBe(99)
  })

  it('returns an empty report when the enclave errors on the first pass', async () => {
    mockMigrateAll.mockRejectedValue(new Error('boom'))
    const report = await runLegacyBlobMigration()
    expect(report.fullyMigrated).toBe(false)
    expect(report.totalMigrated).toBe(0)
    expect(report.scopes).toEqual([])
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
    mockMigrateAll.mockReset()
    mockRequirePrimaryKeyB64.mockReset()
    mockPullKeys.mockReset()
    mockClearFallbackKeys.mockReset()
    mockGetFallbackKeyCount.mockReset()
    mockGetFallbackKeyCount.mockReturnValue(0)
    mockRequirePrimaryKeyB64.mockReturnValue('PRIMARY_B64')
    mockPullKeys.mockReturnValue([{ key: 'PRIMARY_B64' }])
  })

  it('clears fallback keys when every scope drains', async () => {
    mockMigrateAll.mockResolvedValue(emptyEnclaveReport())
    const report = await runLegacyBlobMigrationAndFinalize()
    expect(report.fullyMigrated).toBe(true)
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
