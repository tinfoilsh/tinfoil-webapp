import { ProfileSyncService } from '@/services/cloud/profile-sync'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockIsAuthenticated = vi.fn()
const mockListStatus = vi.fn()
const mockPush = vi.fn()
const mockGetKeyBytesOrThrow = vi.fn()

vi.mock('@/services/auth', () => ({
  authTokenManager: {
    isAuthenticated: (...args: any[]) => mockIsAuthenticated(...args),
  },
}))

vi.mock('@/services/encryption/encryption-service', () => ({
  encryptionService: {
    getKeyBytesOrThrow: (...args: any[]) => mockGetKeyBytesOrThrow(...args),
  },
}))

vi.mock('@/services/sync-enclave/sync-api', async () => {
  const real = await vi.importActual<
    typeof import('@/services/sync-enclave/sync-api')
  >('@/services/sync-enclave/sync-api')
  return {
    ...real,
    listStatus: (...args: any[]) => mockListStatus(...args),
    push: (...args: any[]) => mockPush(...args),
  }
})

describe('ProfileSyncService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsAuthenticated.mockResolvedValue(true)
    mockGetKeyBytesOrThrow.mockReturnValue(new Uint8Array(32))
    mockListStatus.mockResolvedValue({
      updates: [{ id: 'profile', etag: '7', key_id: 'aa'.repeat(16) }],
      deletes: [],
    })
    mockPush.mockResolvedValue({ ok: true, etag: '8', key_id: 'aa'.repeat(16) })
  })

  it('saves profile updates with the caller last-synced etag', async () => {
    const service = new ProfileSyncService()
    const result = await service.saveProfile({ nickname: 'Sacha', version: 7 })

    expect(result.success).toBe(true)
    expect(mockListStatus).not.toHaveBeenCalled()
    expect(mockPush).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: 'profile',
        id: 'profile',
        ifMatch: '7',
      }),
    )
  })

  it('reports profile delete tombstones from list status', async () => {
    mockListStatus.mockResolvedValueOnce({
      updates: [],
      deletes: [
        {
          id: 'profile',
          scope: 'profile',
          deleted_at: '2026-05-20T12:00:00.000Z',
        },
      ],
    })

    const service = new ProfileSyncService()
    const status = await service.getSyncStatus()

    expect(status).toEqual({
      exists: false,
      deleted: true,
      lastUpdated: '2026-05-20T12:00:00.000Z',
    })
  })
})
