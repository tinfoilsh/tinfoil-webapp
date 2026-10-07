import { USER_ENCRYPTION_KEY } from '@/constants/storage-keys'
import { useCloudSync } from '@/hooks/use-cloud-sync'
import { validateCurrentPrimaryKey } from '@/services/cloud/cloud-key-preflight'
import { encryptionService } from '@/services/encryption/encryption-service'
import { resetSyncEnclaveClient } from '@/services/sync-enclave/sync-enclave-client'
import { deleteEncryptionKey } from '@/utils/signout-cleanup'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// vi.hoisted runs before vi.mock factory evaluation, which is the only
// safe place to declare variables that the factory closes over.
const { mockReady, mockFetch, canWrite, authorize } = vi.hoisted(() => ({
  mockReady: vi.fn<() => Promise<void>>(),
  mockFetch: vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(),
  canWrite: vi.fn<() => Promise<boolean>>(),
  authorize: vi.fn<(mode: string) => Promise<void>>(),
}))

vi.mock('tinfoil', () => ({
  SecureClient: class {
    ready = mockReady
    fetch = mockFetch
    getVerificationDocument = () => ({})
  },
}))
vi.mock('@clerk/react', () => ({ useAuth: () => ({ isSignedIn: true }) }))
vi.mock('@/services/auth', () => ({
  authTokenManager: { getValidToken: async () => 'test-jwt' },
}))
vi.mock('@/services/cloud/cloud-key-authorization', () => ({
  canWriteToCloud: canWrite,
  authorizeCurrentPrimaryKeyOrThrow: authorize,
}))
vi.mock('@/services/cloud/cloud-sync', () => ({
  cloudSync: {
    retryDecryptionWithNewKey: () => {
      throw new Error('Unexpected decryption retry')
    },
    smartSync: () => {
      throw new Error('Unexpected chat sync')
    },
  },
}))
vi.mock('@/utils/cloud-sync-settings', () => ({
  isCloudSyncEnabled: () => true,
  setCloudSyncEnabled: () => {
    throw new Error('Unexpected sync preference change')
  },
}))
vi.mock('@/utils/error-handling', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
}))

const CEK_BYTE_LENGTH = 32
const PRIMARY_KEY = `key_${'ab'.repeat(CEK_BYTE_LENGTH)}`

describe('live cloud-sync key session', () => {
  beforeEach(() => {
    resetSyncEnclaveClient()
    encryptionService.clearKey()
    vi.resetAllMocks()
    mockReady.mockResolvedValue(undefined)
    mockFetch.mockImplementation(async () =>
      Response.json({ key_id: null, has_data: false, bundles: {} }),
    )
    canWrite.mockResolvedValue(false)
    authorize.mockResolvedValue(undefined)
  })

  afterEach(() => {
    cleanup()
    resetSyncEnclaveClient()
    encryptionService.clearKey()
  })

  it('does not attest or authorize cloud writes without a local CEK', async () => {
    const { result } = renderHook(() => useCloudSync())
    await waitFor(() => expect(result.current.initialized).toBe(true))
    expect(result.current.encryptionKey).toBeNull()
    expect(mockReady).not.toHaveBeenCalled()
    expect(mockFetch).not.toHaveBeenCalled()
    expect(authorize).not.toHaveBeenCalled()
  })

  it('publishes the local CEK only after verified preflight completes', async () => {
    await encryptionService.setKey(PRIMARY_KEY)
    let finishAttestation!: () => void
    mockReady.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishAttestation = resolve
      }),
    )
    const { result } = renderHook(() => useCloudSync())
    await waitFor(() => expect(mockReady).toHaveBeenCalledOnce())
    expect(result.current.encryptionKey).toBeNull()
    expect(result.current.initialized).toBe(false)
    expect(mockFetch).not.toHaveBeenCalled()
    expect(authorize).not.toHaveBeenCalled()

    await act(async () => finishAttestation())
    await waitFor(() => expect(result.current.encryptionKey).toBe(PRIMARY_KEY))
    expect(result.current.initialized).toBe(true)
    expect(authorize).toHaveBeenCalledExactlyOnceWith('validated')
    expect(mockFetch).toHaveBeenCalledExactlyOnceWith(
      'https://sync.tinfoil.sh/v1/key/current',
      expect.objectContaining({ method: 'POST', body: '{}' }),
    )
  })

  it('withholds cloud authorization when attestation fails without erasing the saved CEK', async () => {
    await encryptionService.setKey(PRIMARY_KEY)
    mockReady.mockRejectedValue(new Error('attestation unavailable'))
    const { result } = renderHook(() => useCloudSync())
    await waitFor(() => expect(result.current.initialized).toBe(true))
    expect(mockReady).toHaveBeenCalledOnce()
    expect(mockFetch).not.toHaveBeenCalled()
    expect(authorize).not.toHaveBeenCalled()
    expect(localStorage.getItem(USER_ENCRYPTION_KEY)).toBe(PRIMARY_KEY)
    await expect(validateCurrentPrimaryKey()).resolves.toMatchObject({
      canWrite: false,
      remoteState: 'unknown',
    })
    expect(mockFetch).not.toHaveBeenCalled()
    expect(authorize).not.toHaveBeenCalled()
  })

  it('retries failed attestation on remount before authorizing the saved key', async () => {
    await encryptionService.setKey(PRIMARY_KEY)
    mockReady.mockRejectedValueOnce(new Error('first attestation fails'))
    const first = renderHook(() => useCloudSync())
    await waitFor(() => expect(first.result.current.initialized).toBe(true))
    expect(authorize).not.toHaveBeenCalled()
    first.unmount()

    const second = renderHook(() => useCloudSync())
    await waitFor(() =>
      expect(second.result.current.encryptionKey).toBe(PRIMARY_KEY),
    )
    expect(mockReady).toHaveBeenCalledTimes(2)
    expect(authorize).toHaveBeenCalledExactlyOnceWith('validated')
    expect(mockFetch).toHaveBeenCalledOnce()
  })

  it('resetting the enclave client preserves the saved CEK but requires fresh attestation', async () => {
    await encryptionService.setKey(PRIMARY_KEY)
    const first = renderHook(() => useCloudSync())
    await waitFor(() =>
      expect(first.result.current.encryptionKey).toBe(PRIMARY_KEY),
    )
    first.unmount()
    resetSyncEnclaveClient()
    expect(localStorage.getItem(USER_ENCRYPTION_KEY)).toBe(PRIMARY_KEY)
    let finishAttestation!: () => void
    mockReady.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishAttestation = resolve
      }),
    )
    const second = renderHook(() => useCloudSync())
    await waitFor(() => expect(mockReady).toHaveBeenCalledTimes(2))
    expect(second.result.current.encryptionKey).toBeNull()
    expect(authorize).toHaveBeenCalledTimes(1)
    expect(mockFetch).toHaveBeenCalledTimes(1)
    await act(async () => finishAttestation())
    await waitFor(() =>
      expect(second.result.current.encryptionKey).toBe(PRIMARY_KEY),
    )
    expect(authorize).toHaveBeenCalledTimes(2)
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it.each(['ready', 'attesting'] as const)(
    'deleting the CEK while %s blocks preflight and leaves the next cloud-sync mount keyless',
    async (phase) => {
      await encryptionService.setKey(PRIMARY_KEY)
      let finishAttestation!: () => void
      mockReady.mockReturnValueOnce(
        new Promise<void>((resolve) => {
          finishAttestation = resolve
        }),
      )
      const first = renderHook(() => useCloudSync())
      await waitFor(() => expect(mockReady).toHaveBeenCalledOnce())
      if (phase === 'ready') {
        await act(async () => finishAttestation())
        await waitFor(() =>
          expect(first.result.current.encryptionKey).toBe(PRIMARY_KEY),
        )
      } else {
        expect(first.result.current.encryptionKey).toBeNull()
        expect(mockFetch).not.toHaveBeenCalled()
        expect(authorize).not.toHaveBeenCalled()
      }
      first.unmount()
      resetSyncEnclaveClient()
      deleteEncryptionKey()
      expect(encryptionService.getAllKeys()).toEqual({
        primary: null,
        alternatives: [],
      })
      expect(localStorage.getItem(USER_ENCRYPTION_KEY)).toBeNull()
      await expect(validateCurrentPrimaryKey()).resolves.toMatchObject({
        canWrite: false,
        remoteState: 'unknown',
      })
      const second = renderHook(() => useCloudSync())
      await waitFor(() => expect(second.result.current.initialized).toBe(true))
      await act(async () => finishAttestation())
      expect(second.result.current.encryptionKey).toBeNull()
      expect(mockReady).toHaveBeenCalledTimes(1)
      expect(mockFetch).toHaveBeenCalledTimes(phase === 'ready' ? 1 : 0)
      expect(authorize).toHaveBeenCalledTimes(phase === 'ready' ? 1 : 0)
    },
  )
})
