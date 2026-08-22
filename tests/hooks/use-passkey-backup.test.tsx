import { SETTINGS_MANUAL_RECOVERY_DISMISSED } from '@/constants/storage-keys'
import { usePasskeyBackup } from '@/hooks/use-passkey-backup'
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  inspectRemoteEncryptedState: vi.fn(),
  validateCurrentPrimaryKey: vi.fn(),
  authorizeCurrentPrimaryKeyOrThrow: vi.fn(),
  getCurrentCloudKeyAuthorizationMode: vi.fn(),
  isPrfSupported: vi.fn(),
  addWrappedKeyForCurrentKey: vi.fn(),
  createAndWrapTinfoilKey: vi.fn(),
  deletePasskeyCredential: vi.fn(),
  getLocalPasskeyCredentialId: vi.fn(),
  getPasskeyCredentialState: vi.fn(),
  getPasskeyDeviceState: vi.fn(),
  loadPasskeyCredentials: vi.fn(),
  loadRecoveryCandidates: vi.fn(),
  recoverPasskeyKeyBundle: vi.fn(),
  rewrapKeyFromCache: vi.fn(),
  wrapKeyWithPRFResult: vi.fn(),
  wrapTinfoilKeyBundle: vi.fn(),
  storeEncryptedKeys: vi.fn(),
  getKey: vi.fn(),
  getAllKeys: vi.fn(),
  setAllKeys: vi.fn(),
  replaceKeyBundle: vi.fn(),
  getAlternativeKeyBytes: vi.fn(),
  encodeKeyFromBytes: vi.fn(),
  generateKey: vi.fn(),
  promoteRecoveredCekToEnclave: vi.fn(),
  keyCurrent: vi.fn(),
  setCloudSyncEnabled: vi.fn(),
  passkeyEventsOn: vi.fn(),
  passkeyEventsEmit: vi.fn(),
  logError: vi.fn(),
  logInfo: vi.fn(),
}))

vi.mock('@/services/cloud/cloud-key-preflight', () => ({
  inspectRemoteEncryptedState: mocks.inspectRemoteEncryptedState,
  validateCurrentPrimaryKey: mocks.validateCurrentPrimaryKey,
}))

vi.mock('@/services/cloud/cloud-key-authorization', () => ({
  authorizeCurrentPrimaryKeyOrThrow: mocks.authorizeCurrentPrimaryKeyOrThrow,
  getCurrentCloudKeyAuthorizationMode:
    mocks.getCurrentCloudKeyAuthorizationMode,
}))

vi.mock('@/services/passkey/prf-support', () => ({
  isPrfSupported: mocks.isPrfSupported,
}))

vi.mock('@/services/passkey', () => {
  class MockPasskeyCredentialConflictError extends Error {
    remoteSyncVersion: number | null
    remoteBundleVersion: number

    constructor(
      message: string,
      options: {
        remoteSyncVersion: number | null
        remoteBundleVersion: number
      },
    ) {
      super(message)
      this.remoteSyncVersion = options.remoteSyncVersion
      this.remoteBundleVersion = options.remoteBundleVersion
    }
  }

  return {
    addWrappedKeyForCurrentKey: mocks.addWrappedKeyForCurrentKey,
    createAndWrapTinfoilKey: mocks.createAndWrapTinfoilKey,
    deletePasskeyCredential: mocks.deletePasskeyCredential,
    getLocalPasskeyCredentialId: mocks.getLocalPasskeyCredentialId,
    getPasskeyCredentialState: mocks.getPasskeyCredentialState,
    getPasskeyDeviceState: mocks.getPasskeyDeviceState,
    loadPasskeyCredentials: mocks.loadPasskeyCredentials,
    loadRecoveryCandidates: mocks.loadRecoveryCandidates,
    PasskeyCredentialConflictError: MockPasskeyCredentialConflictError,
    PasskeyTimeoutError: class MockPasskeyTimeoutError extends Error {},
    PrfNotSupportedError: class MockPrfNotSupportedError extends Error {},
    recoverPasskeyKeyBundle: mocks.recoverPasskeyKeyBundle,
    passkeyKeyManager: {
      rewrapKeyFromCache: mocks.rewrapKeyFromCache,
      wrapKeyWithPRFResult: mocks.wrapKeyWithPRFResult,
    },
    promoteRecoveredCekToEnclave: mocks.promoteRecoveredCekToEnclave,
    storeEncryptedKeys: mocks.storeEncryptedKeys,
    wrapTinfoilKeyBundle: mocks.wrapTinfoilKeyBundle,
  }
})

vi.mock('@/services/encryption/encryption-service', () => ({
  encryptionService: {
    getKey: mocks.getKey,
    getAllKeys: mocks.getAllKeys,
    setAllKeys: mocks.setAllKeys,
    replaceKeyBundle: mocks.replaceKeyBundle,
    getAlternativeKeyBytes: mocks.getAlternativeKeyBytes,
    encodeKeyFromBytes: mocks.encodeKeyFromBytes,
    generateKey: mocks.generateKey,
  },
}))

vi.mock('@/services/sync-enclave/passkey-events', () => ({
  passkeyEvents: {
    on: mocks.passkeyEventsOn,
    emit: mocks.passkeyEventsEmit,
  },
}))

vi.mock('@/services/sync-enclave/sync-api', () => ({
  keyCurrent: mocks.keyCurrent,
}))

vi.mock('@/utils/cloud-sync-settings', () => ({
  setCloudSyncEnabled: mocks.setCloudSyncEnabled,
}))

vi.mock('@/utils/error-handling', () => ({
  logError: mocks.logError,
  logInfo: mocks.logInfo,
}))

const baseOptions = {
  encryptionKey: null,
  initialized: true,
  isSignedIn: true,
  user: { id: 'user_1' } as any,
}

describe('usePasskeyBackup', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
    mocks.inspectRemoteEncryptedState.mockResolvedValue('empty')
    mocks.validateCurrentPrimaryKey.mockResolvedValue({ canWrite: true })
    mocks.getCurrentCloudKeyAuthorizationMode.mockResolvedValue(null)
    mocks.isPrfSupported.mockResolvedValue(true)
    mocks.getPasskeyCredentialState.mockResolvedValue('empty')
    mocks.getPasskeyDeviceState.mockResolvedValue('empty')
    mocks.loadPasskeyCredentials.mockResolvedValue([])
    mocks.getLocalPasskeyCredentialId.mockReturnValue(null)
    mocks.getKey.mockReturnValue(null)
    mocks.getAllKeys.mockReturnValue({ primary: null, alternatives: [] })
    mocks.wrapTinfoilKeyBundle.mockImplementation(async (primary) => ({
      primary,
      alternatives: [],
    }))
    mocks.passkeyEventsOn.mockReturnValue(() => {})
  })

  it('keeps transient remote-state failures retriable during initialization', async () => {
    mocks.inspectRemoteEncryptedState.mockResolvedValue('unknown')

    const { result } = renderHook(() => usePasskeyBackup(baseOptions))

    await waitFor(() =>
      expect(mocks.inspectRemoteEncryptedState).toHaveBeenCalled(),
    )
    await waitFor(() => expect(result.current.passkeySetupFailed).toBe(true))

    expect(result.current.manualRecoveryNeeded).toBe(false)
    expect(result.current.passkeyFirstTimePromptAvailable).toBe(false)
    expect(result.current.passkeyRetryAvailable).toBe(true)
  })

  it('keeps manual first-time prompt retries available on unknown remote state', async () => {
    mocks.inspectRemoteEncryptedState.mockResolvedValue('unknown')
    const { result } = renderHook(() =>
      usePasskeyBackup({ ...baseOptions, initialized: false }),
    )

    let prompted = true
    await act(async () => {
      prompted = await result.current.showFirstTimePasskeyPrompt()
    })

    expect(prompted).toBe(false)
    expect(result.current.manualRecoveryNeeded).toBe(false)
    expect(result.current.passkeySetupFailed).toBe(true)
    expect(result.current.passkeyRetryAvailable).toBe(true)
  })

  it('keeps explicit manual recovery available after a reload', async () => {
    localStorage.setItem(SETTINGS_MANUAL_RECOVERY_DISMISSED, 'true')
    mocks.inspectRemoteEncryptedState.mockResolvedValue('exists')
    const { result, unmount } = renderHook(() =>
      usePasskeyBackup({ ...baseOptions, initialized: false }),
    )

    let prompted = true
    await act(async () => {
      prompted = await result.current.showFirstTimePasskeyPrompt()
    })

    expect(prompted).toBe(false)
    expect(result.current.manualRecoveryNeeded).toBe(true)
    expect(result.current.passkeyFirstTimePromptAvailable).toBe(false)
    expect(result.current.passkeyRetryAvailable).toBe(false)
    expect(localStorage.getItem(SETTINGS_MANUAL_RECOVERY_DISMISSED)).toBeNull()

    unmount()
    const { result: reloadedResult } = renderHook(() =>
      usePasskeyBackup(baseOptions),
    )

    await waitFor(() =>
      expect(reloadedResult.current.manualRecoveryNeeded).toBe(true),
    )
  })

  describe('stale local key recovery routing', () => {
    const blockedValidation = {
      canWrite: false,
      remoteState: 'exists',
      probe: 'none',
      message: 'mismatch',
    }

    it('prompts passkey recovery when the registered key has bundles', async () => {
      mocks.validateCurrentPrimaryKey.mockResolvedValue(blockedValidation)
      mocks.keyCurrent.mockResolvedValue({
        key_id: 'kid-remote',
        has_data: true,
        bundles: { 'cred-1': { credential_id: 'cred-1' } },
      })

      const { result } = renderHook(() =>
        usePasskeyBackup({ ...baseOptions, encryptionKey: 'key_stale' }),
      )

      await waitFor(() =>
        expect(result.current.passkeyRecoveryNeeded).toBe(true),
      )
      expect(result.current.manualRecoveryNeeded).toBe(false)
      expect(result.current.passkeyActive).toBe(false)
    })

    it('prompts manual recovery when the registered key has no bundles', async () => {
      mocks.validateCurrentPrimaryKey.mockResolvedValue(blockedValidation)
      mocks.keyCurrent.mockResolvedValue({
        key_id: 'kid-remote',
        has_data: true,
        bundles: {},
      })

      const { result } = renderHook(() =>
        usePasskeyBackup({ ...baseOptions, encryptionKey: 'key_stale' }),
      )

      await waitFor(() =>
        expect(result.current.manualRecoveryNeeded).toBe(true),
      )
      expect(result.current.passkeyRecoveryNeeded).toBe(false)
      expect(result.current.passkeyRetryAvailable).toBe(false)
    })

    it('stays silent when validation only failed transiently', async () => {
      mocks.validateCurrentPrimaryKey.mockResolvedValue({
        canWrite: false,
        remoteState: 'unknown',
        probe: 'none',
      })

      const { result } = renderHook(() =>
        usePasskeyBackup({ ...baseOptions, encryptionKey: 'key_local' }),
      )

      await waitFor(() =>
        expect(mocks.validateCurrentPrimaryKey).toHaveBeenCalled(),
      )
      expect(result.current.passkeyRecoveryNeeded).toBe(false)
      expect(result.current.manualRecoveryNeeded).toBe(false)
    })
  })

  it('keeps recovery successful when legacy promotion fails', async () => {
    mocks.loadRecoveryCandidates.mockResolvedValue([
      { id: 'cred-legacy', source: 'legacy' },
    ])
    mocks.recoverPasskeyKeyBundle.mockResolvedValue({
      credentialId: 'cred-legacy',
      keyBundle: { primary: 'key_recovered', alternatives: [] },
      syncVersion: 1,
      bundleVersion: 1,
      source: 'legacy',
      prfResult: { output: new Uint8Array(32) },
    })
    mocks.getAlternativeKeyBytes.mockReturnValue(new Uint8Array(32))
    mocks.promoteRecoveredCekToEnclave.mockResolvedValue(false)
    mocks.authorizeCurrentPrimaryKeyOrThrow.mockResolvedValue(undefined)

    const { result } = renderHook(() =>
      usePasskeyBackup({ ...baseOptions, initialized: false }),
    )
    let recovered: string | null = null
    await act(async () => {
      recovered = await result.current.recoverWithPasskey()
    })

    expect(recovered).toBe('key_recovered')
    expect(result.current.passkeyRecoveryFailure).toBeNull()
    expect(result.current.passkeyActive).toBe(true)
    expect(mocks.promoteRecoveredCekToEnclave).toHaveBeenCalledOnce()
  })

  it('fails enrollment before remote storage when alternatives cannot be wrapped', async () => {
    mocks.getCurrentCloudKeyAuthorizationMode.mockResolvedValue('validated')
    mocks.getAllKeys.mockReturnValue({
      primary: 'key_primary',
      alternatives: ['key_alternative'],
    })
    mocks.getAlternativeKeyBytes.mockReturnValue(new Uint8Array(32))
    mocks.createAndWrapTinfoilKey.mockResolvedValue({
      credentialId: 'AQID',
      wrappedKey: { credentialId: 'AQID' },
    })
    mocks.wrapTinfoilKeyBundle.mockResolvedValue(null)

    const { result } = renderHook(() =>
      usePasskeyBackup({ ...baseOptions, initialized: false }),
    )
    let enrolled = true
    await act(async () => {
      enrolled = await result.current.setupPasskey()
    })

    expect(enrolled).toBe(false)
    expect(mocks.storeEncryptedKeys).not.toHaveBeenCalled()
  })

  describe('addPasskeyToThisDevice legacy promotion', () => {
    beforeEach(() => {
      mocks.getAllKeys.mockReturnValue({ primary: 'key_x', alternatives: [] })
      mocks.getAlternativeKeyBytes.mockReturnValue(new Uint8Array(32))
      mocks.loadRecoveryCandidates.mockResolvedValue([
        { id: 'cred-legacy', source: 'legacy' },
      ])
      mocks.recoverPasskeyKeyBundle.mockResolvedValue({
        credentialId: 'cred-legacy',
        keyBundle: { primary: 'key_x', alternatives: [] },
        source: 'legacy',
        prfResult: { output: new Uint8Array(32) },
      })
      mocks.promoteRecoveredCekToEnclave.mockResolvedValue(true)
    })

    it('proceeds with promotion when remote legacy data exists', async () => {
      mocks.keyCurrent.mockResolvedValue({ key_id: null, has_data: true })

      const { result } = renderHook(() => usePasskeyBackup(baseOptions))

      let success = false
      await act(async () => {
        success = await result.current.addPasskeyToThisDevice()
      })

      expect(success).toBe(true)
      expect(mocks.recoverPasskeyKeyBundle).toHaveBeenCalledOnce()
      expect(mocks.promoteRecoveredCekToEnclave).toHaveBeenCalledOnce()
    })

    it('proceeds with promotion when no remote data exists', async () => {
      mocks.keyCurrent.mockResolvedValue({ key_id: null, has_data: false })

      const { result } = renderHook(() => usePasskeyBackup(baseOptions))

      let success = false
      await act(async () => {
        success = await result.current.addPasskeyToThisDevice()
      })

      expect(success).toBe(true)
      expect(mocks.promoteRecoveredCekToEnclave).toHaveBeenCalledOnce()
    })
  })
})
