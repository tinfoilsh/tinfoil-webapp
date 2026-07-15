import { resetRendererRegistry } from '@/components/chat/renderers'
import { SETTINGS_HAS_SEEN_ONBOARDING } from '@/constants/storage-keys'
import { cloudSync } from '@/services/cloud/cloud-sync'
import { resetEditClockCache } from '@/services/cloud/edit-clock'
import { profileSync } from '@/services/cloud/profile-sync'
import { resetSyncHealth } from '@/services/cloud/sync-health'
import { encryptionService } from '@/services/encryption/encryption-service'
import { resetTinfoilClient } from '@/services/inference/tinfoil-client'
import { projectEvents } from '@/services/project/project-events'
import { deletedChatsTracker } from '@/services/storage/deleted-chats-tracker'
import { indexedDBStorage } from '@/services/storage/indexed-db'
import { resetSyncEnclaveClient } from '@/services/sync-enclave'
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
    vi.clearAllMocks()
    localStorage.clear()
    sessionStorage.clear()
  })

  it('preserves the browser onboarding flag while clearing user data', async () => {
    localStorage.setItem(SETTINGS_HAS_SEEN_ONBOARDING, 'true')
    localStorage.setItem('user-specific-data', 'value')

    await performSignoutCleanup()

    expect(localStorage.getItem(SETTINGS_HAS_SEEN_ONBOARDING)).toBe('true')
    expect(localStorage.getItem('user-specific-data')).toBeNull()
  })

  it('clears sessionStorage', async () => {
    sessionStorage.setItem('session-data', 'value')

    await performSignoutCleanup()

    expect(sessionStorage.getItem('session-data')).toBeNull()
  })

  it('clears the encryption key and every user data cache', async () => {
    await performSignoutCleanup()

    expect(encryptionService.clearKey).toHaveBeenCalledWith({ persist: true })
    expect(resetRendererRegistry).toHaveBeenCalled()
    expect(resetTinfoilClient).toHaveBeenCalled()
    expect(resetSyncEnclaveClient).toHaveBeenCalled()
    expect(profileSync.clearCache).toHaveBeenCalled()
    expect(cloudSync.clearSyncStatus).toHaveBeenCalled()
    expect(deletedChatsTracker.clear).toHaveBeenCalled()
    expect(resetSyncHealth).toHaveBeenCalled()
    expect(resetEditClockCache).toHaveBeenCalled()
    expect(projectEvents.clear).toHaveBeenCalled()
    expect(indexedDBStorage.clearAll).toHaveBeenCalled()
  })

  it('keeps the encryption key when preserveEncryptionKey is set', async () => {
    await performSignoutCleanup({ preserveEncryptionKey: true })

    expect(encryptionService.clearKey).not.toHaveBeenCalled()
    expect(indexedDBStorage.clearAll).toHaveBeenCalled()
  })
})
