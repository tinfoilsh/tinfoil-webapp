import { SETTINGS_HAS_SEEN_ONBOARDING } from '@/constants/storage-keys'
import { performSignoutCleanup } from '@/utils/signout-cleanup'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/components/chat/renderers', () => ({
  resetRendererRegistry: vi.fn(),
}))

vi.mock('@/services/cloud/cloud-sync', () => ({
  cloudSync: { clearSyncStatus: vi.fn() },
}))

vi.mock('@/services/cloud/edit-clock', () => ({
  resetEditClockCache: vi.fn(),
}))

vi.mock('@/services/cloud/profile-sync', () => ({
  profileSync: { clearCache: vi.fn() },
}))

vi.mock('@/services/cloud/sync-health', () => ({
  resetSyncHealth: vi.fn(),
}))

vi.mock('@/services/encryption/encryption-service', () => ({
  encryptionService: { clearKey: vi.fn() },
}))

vi.mock('@/services/inference/tinfoil-client', () => ({
  resetTinfoilClient: vi.fn(),
}))

vi.mock('@/services/project/project-events', () => ({
  projectEvents: { clear: vi.fn() },
}))

vi.mock('@/services/storage/deleted-chats-tracker', () => ({
  deletedChatsTracker: { clear: vi.fn() },
}))

vi.mock('@/services/storage/indexed-db', () => ({
  indexedDBStorage: { clearAll: vi.fn().mockResolvedValue(undefined) },
}))

vi.mock('@/services/sync-enclave', () => ({
  resetSyncEnclaveClient: vi.fn(),
}))

vi.mock('@/utils/error-handling', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
}))

describe('performSignoutCleanup', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('preserves the browser onboarding flag while clearing user data', async () => {
    localStorage.setItem(SETTINGS_HAS_SEEN_ONBOARDING, 'true')
    localStorage.setItem('user-specific-data', 'value')

    await performSignoutCleanup()

    expect(localStorage.getItem(SETTINGS_HAS_SEEN_ONBOARDING)).toBe('true')
    expect(localStorage.getItem('user-specific-data')).toBeNull()
  })
})
