import { ProfileSyncService } from '@/services/cloud/profile-sync'
import { SyncEnclaveError } from '@/services/sync-enclave/sync-enclave-client'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockIsAuthenticated = vi.fn()
const mockListStatus = vi.fn()
const mockPush = vi.fn()
const mockPull = vi.fn()
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
    pull: (...args: any[]) => mockPull(...args),
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

  it('re-pushes the fresher local profile after a stale-blob conflict', async () => {
    mockPush
      .mockRejectedValueOnce(
        new SyncEnclaveError('STALE_BLOB', 412, 'STALE_BLOB'),
      )
      .mockResolvedValueOnce({
        ok: true,
        etag: '10',
        key_id: 'aa'.repeat(16),
      })
    mockPull.mockResolvedValue({
      items: [
        {
          ok: true,
          etag: '9',
          plaintext: btoa(
            JSON.stringify({
              nickname: 'Remote',
              updatedAt: '2026-06-16T09:00:00.000Z',
            }),
          ),
        },
      ],
    })

    const service = new ProfileSyncService()
    const result = await service.saveProfile({
      nickname: 'Sacha',
      version: 0,
      updatedAt: '2026-06-16T10:00:00.000Z',
    })

    expect(result.success).toBe(true)
    expect(result.version).toBe(10)
    expect(result.remoteProfile).toBeUndefined()
    expect(mockPush).toHaveBeenCalledTimes(2)
    expect(mockPush.mock.calls[0][0]).toMatchObject({ ifMatch: null })
    expect(mockPush.mock.calls[1][0]).toMatchObject({ ifMatch: '9' })
  })

  it('adopts the newer remote field and re-pushes the merge on conflict', async () => {
    mockPush
      .mockRejectedValueOnce(
        new SyncEnclaveError('STALE_BLOB', 412, 'STALE_BLOB'),
      )
      .mockResolvedValueOnce({
        ok: true,
        etag: '10',
        key_id: 'aa'.repeat(16),
      })
    mockPull.mockResolvedValue({
      items: [
        {
          ok: true,
          etag: '9',
          plaintext: btoa(
            JSON.stringify({
              nickname: 'Remote',
              updatedAt: '2026-06-16T11:00:00.000Z',
            }),
          ),
        },
      ],
    })

    const service = new ProfileSyncService()
    const result = await service.saveProfile({
      nickname: 'Sacha',
      version: 0,
      updatedAt: '2026-06-16T10:00:00.000Z',
    })

    expect(result.success).toBe(true)
    expect(result.version).toBe(10)
    expect(result.remoteProfile).toMatchObject({ nickname: 'Remote' })
    // The merge re-pushes the resolved profile onto the server's
    // current version so both devices converge.
    expect(mockPush).toHaveBeenCalledTimes(2)
    expect(mockPush.mock.calls[1][0]).toMatchObject({ ifMatch: '9' })
    expect(service.getCachedProfile()).toMatchObject({ nickname: 'Remote' })
  })

  it('preserves unknown profile fields across a fetch and re-push', async () => {
    mockPull.mockResolvedValue({
      items: [
        {
          ok: true,
          etag: '7',
          plaintext: btoa(
            JSON.stringify({
              nickname: 'Remote',
              experimentalSetting: { foo: 1 },
              updatedAt: '2026-06-16T09:00:00.000Z',
            }),
          ),
        },
      ],
    })

    const service = new ProfileSyncService()
    await service.fetchProfile()
    const result = await service.saveProfile({ nickname: 'Sacha', version: 7 })

    expect(result.success).toBe(true)
    const pushed = JSON.parse(
      new TextDecoder().decode(mockPush.mock.calls[0][0].plaintext),
    )
    // The field we do not model survives the round-trip, and our own
    // known field still wins.
    expect(pushed.experimentalSetting).toEqual({ foo: 1 })
    expect(pushed.nickname).toBe('Sacha')
  })

  it('carries unknown remote fields onto the rebased push when local wins', async () => {
    mockPush
      .mockRejectedValueOnce(
        new SyncEnclaveError('STALE_BLOB', 412, 'STALE_BLOB'),
      )
      .mockResolvedValueOnce({
        ok: true,
        etag: '10',
        key_id: 'aa'.repeat(16),
      })
    mockPull.mockResolvedValue({
      items: [
        {
          ok: true,
          etag: '9',
          plaintext: btoa(
            JSON.stringify({
              nickname: 'Remote',
              experimentalSetting: 'keep-me',
              updatedAt: '2026-06-16T09:00:00.000Z',
            }),
          ),
        },
      ],
    })

    const service = new ProfileSyncService()
    const result = await service.saveProfile({
      nickname: 'Sacha',
      version: 0,
      updatedAt: '2026-06-16T10:00:00.000Z',
    })

    expect(result.success).toBe(true)
    const rebased = JSON.parse(
      new TextDecoder().decode(mockPush.mock.calls[1][0].plaintext),
    )
    expect(rebased.experimentalSetting).toBe('keep-me')
    expect(rebased.nickname).toBe('Sacha')
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
