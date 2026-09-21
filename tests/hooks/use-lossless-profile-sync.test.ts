import {
  SYNC_PROFILE_DIRTY,
  USER_PREFS_PINNED_CHAT_IDS,
} from '@/constants/storage-keys'
import { useProfileSync } from '@/hooks/use-lossless-profile-sync'
import type { ProfileData } from '@/services/cloud/profile-sync'
import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  localProfile: {} as ProfileData,
  fetchProfile: vi.fn(),
  getSyncStatus: vi.fn(),
  saveProfile: vi.fn(),
  getAuthorizationMode: vi.fn(),
  canWriteToCloud: vi.fn(),
}))

vi.mock('@clerk/react', () => ({
  useAuth: () => ({ isSignedIn: true, userId: 'user-1' }),
}))

vi.mock('@/services/cloud/cloud-key-authorization', () => ({
  getCurrentCloudKeyAuthorizationMode: () => mocks.getAuthorizationMode(),
  canWriteToCloud: () => mocks.canWriteToCloud(),
}))

vi.mock('@/services/cloud/profile-sync', () => ({
  profileSync: {
    fetchProfile: (...args: unknown[]) => mocks.fetchProfile(...args),
    getSyncStatus: (...args: unknown[]) => mocks.getSyncStatus(...args),
    hasFailedRemoteDecryption: vi.fn(() => false),
    saveProfile: (...args: unknown[]) => mocks.saveProfile(...args),
  },
}))

vi.mock('@/services/cloud/profile-sync-coordinator', () => ({
  invalidateProfileSyncGeneration: vi.fn(),
  runSerializedProfileSync: async (
    _userId: string,
    sync: (isCurrent: () => boolean) => Promise<void>,
  ) => sync(() => true),
}))

vi.mock(
  '@/services/cloud/profile-settings-serializer',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@/services/cloud/profile-settings-serializer')
      >()
    return {
      ...actual,
      applySettingsToLocal: (profile: ProfileData) => {
        mocks.localProfile = { ...profile }
      },
      loadLocalSettings: () => ({ ...mocks.localProfile }),
    }
  },
)

vi.mock('@/utils/cloud-sync-settings', () => ({
  CLOUD_SYNC_SETTING_CHANGED_EVENT: 'cloudSyncSettingChanged',
  isCloudSyncEnabled: vi.fn(() => true),
}))

vi.mock('@/utils/error-handling', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
}))

describe('useProfileSync', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
    mocks.localProfile = {
      nickname: 'Remote',
      pinnedChatIds: ['chat-a'],
    }
    localStorage.setItem(USER_PREFS_PINNED_CHAT_IDS, '["chat-a"]')
    localStorage.setItem(SYNC_PROFILE_DIRTY, 'true')
    mocks.fetchProfile.mockResolvedValue({
      nickname: 'Remote',
      version: 4,
    })
    mocks.saveProfile.mockResolvedValue({ success: true, version: 5 })
    mocks.getSyncStatus.mockResolvedValue(null)
    mocks.getAuthorizationMode.mockResolvedValue('validated')
    mocks.canWriteToCloud.mockResolvedValue(true)
  })

  it('uploads local favorites after establishing a missing baseline', async () => {
    const { unmount } = renderHook(() => useProfileSync())

    await waitFor(() => expect(mocks.saveProfile).toHaveBeenCalledTimes(1))

    expect(mocks.saveProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        nickname: 'Remote',
        pinnedChatIds: ['chat-a'],
        version: 4,
      }),
      expect.objectContaining({ nickname: 'Remote', version: 4 }),
    )
    expect(localStorage.getItem(SYNC_PROFILE_DIRTY)).toBeNull()
    unmount()
  })

  it('uploads populated local settings when the remote profile is absent', async () => {
    localStorage.removeItem(SYNC_PROFILE_DIRTY)
    mocks.fetchProfile.mockResolvedValue(null)
    mocks.getSyncStatus.mockResolvedValue({ exists: false, deleted: false })

    const { unmount } = renderHook(() => useProfileSync())

    await waitFor(() => expect(mocks.saveProfile).toHaveBeenCalledTimes(1))
    expect(mocks.saveProfile).toHaveBeenCalledWith(
      expect.objectContaining({ pinnedChatIds: ['chat-a'] }),
      null,
    )
    unmount()
  })

  it('pulls remote favorites before write authorization is available', async () => {
    localStorage.removeItem(SYNC_PROFILE_DIRTY)
    mocks.localProfile = {}
    mocks.getAuthorizationMode.mockResolvedValue(null)
    mocks.fetchProfile.mockResolvedValue({
      pinnedChatIds: ['remote-chat'],
      version: 4,
    })

    const { unmount } = renderHook(() => useProfileSync())

    await waitFor(() =>
      expect(mocks.localProfile.pinnedChatIds).toEqual(['remote-chat']),
    )
    expect(mocks.getAuthorizationMode).not.toHaveBeenCalled()
    expect(mocks.saveProfile).not.toHaveBeenCalled()
    unmount()
  })

  it('reports an indeterminate missing profile as an unsuccessful sync', async () => {
    localStorage.removeItem(SYNC_PROFILE_DIRTY)
    mocks.localProfile = {}
    mocks.fetchProfile.mockResolvedValue(null)
    mocks.getSyncStatus.mockResolvedValue(null)

    const { result, unmount } = renderHook(() => useProfileSync())

    await waitFor(() => expect(mocks.fetchProfile).toHaveBeenCalled())
    await expect(result.current.syncFromCloud()).resolves.toBe(false)
    expect(mocks.saveProfile).not.toHaveBeenCalled()
    unmount()
  })
})
