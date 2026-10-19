import { useCloudSync } from '@/hooks/use-cloud-sync'
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { reportSyncSuccessMock, smartSyncMock } = vi.hoisted(() => ({
  reportSyncSuccessMock: vi.fn(),
  smartSyncMock: vi.fn(),
}))

vi.mock('@clerk/react', () => ({
  useAuth: () => ({ getToken: vi.fn(), isSignedIn: false }),
}))

vi.mock('@/services/cloud/cloud-sync', () => ({
  cloudSync: {
    retryDecryptionWithNewKey: vi.fn(),
    smartSync: smartSyncMock,
  },
}))

vi.mock('@/services/cloud/sync-health', () => ({
  reportSyncSuccess: reportSyncSuccessMock,
}))

vi.mock('@/services/encryption/encryption-service', () => ({
  encryptionService: {
    onFallbackKeyAdded: vi.fn(() => vi.fn()),
  },
}))

vi.mock('@/utils/cloud-sync-settings', () => ({
  isCloudSyncEnabled: () => true,
  setCloudSyncEnabled: vi.fn(),
}))

describe('useCloudSync status', () => {
  beforeEach(() => {
    smartSyncMock.mockReset()
    reportSyncSuccessMock.mockReset()
  })

  it('records a successful completed sync', async () => {
    smartSyncMock.mockResolvedValue({
      uploaded: 1,
      downloaded: 0,
      errors: [],
    })
    const { result } = renderHook(() => useCloudSync())

    await act(async () => {
      await result.current.syncChats()
    })

    expect(result.current.lastSyncTime).not.toBeNull()
    expect(result.current.lastSyncFailed).toBe(false)
    expect(reportSyncSuccessMock).toHaveBeenCalledOnce()
  })

  it('records returned sync errors as a failed attempt', async () => {
    smartSyncMock.mockResolvedValue({
      uploaded: 0,
      downloaded: 0,
      errors: ["A chat couldn't be synced"],
    })
    const { result } = renderHook(() => useCloudSync())

    await act(async () => {
      await result.current.syncChats()
    })

    expect(result.current.lastSyncFailed).toBe(true)
    expect(reportSyncSuccessMock).not.toHaveBeenCalled()
  })

  it('records a thrown sync error as a failed attempt', async () => {
    const syncError = new Error('unavailable')
    smartSyncMock.mockRejectedValue(syncError)
    const { result } = renderHook(() => useCloudSync())
    let thrownError: unknown

    await act(async () => {
      try {
        await result.current.syncChats()
      } catch (error) {
        thrownError = error
      }
    })

    expect(thrownError).toBe(syncError)
    expect(result.current.lastSyncTime).toBeNull()
    expect(result.current.lastSyncFailed).toBe(true)
    expect(reportSyncSuccessMock).not.toHaveBeenCalled()
  })
})
