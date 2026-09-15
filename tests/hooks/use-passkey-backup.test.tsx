import {
  SECRET_PASSKEY_BACKED_UP,
  SETTINGS_MANUAL_RECOVERY_DISMISSED,
} from '@/constants/storage-keys'
import { usePasskeyBackup } from '@/hooks/use-passkey-backup'
import { PrfNotSupportedError } from '@/services/passkey'
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

vi.mock('@/services/keys/cloud-key-preflight', () => ({
  inspectRemoteEncryptedState: mocks.inspectRemoteEncryptedState,
  validateCurrentPrimaryKey: mocks.validateCurrentPrimaryKey,
}))

vi.mock('@/services/keys/cloud-key-authorization', () => ({
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

vi.mock('@/services/keys/passkey-events', () => ({
  passkeyEvents: {
    on: mocks.passkeyEventsOn,
    emit: mocks.passkeyEventsEmit,
  },
}))

vi.mock('@/services/harness/keys', () => ({
  keyCurrent: mocks.keyCurrent,
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

  it('surfaces unsupported passkey providers during first-time setup', async () => {
    const error = new PrfNotSupportedError('PRF is not supported')
    mocks.generateKey.mockResolvedValue('key_generated')
    mocks.getAlternativeKeyBytes.mockReturnValue(new Uint8Array(32))
    mocks.createAndWrapTinfoilKey.mockRejectedValue(error)
    const { result } = renderHook(() =>
      usePasskeyBackup({ ...baseOptions, initialized: false }),
    )

    await act(async () => {
      await expect(result.current.setupFirstTimePasskey()).rejects.toBe(error)
    })

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

  it('clears stale recovery state when no passkey bundles remain', async () => {
    localStorage.setItem(SECRET_PASSKEY_BACKED_UP, 'true')
    mocks.getLocalPasskeyCredentialId.mockReturnValue('cred-local')
    mocks.getPasskeyDeviceState
      .mockResolvedValueOnce('this-device')
      .mockResolvedValueOnce('empty')
    const { result } = renderHook(() =>
      usePasskeyBackup({
        ...baseOptions,
        initialized: false,
        encryptionKey: 'key_current',
      }),
    )

    await act(async () => {
      await result.current.refreshBundleState()
      await result.current.refreshBundleState()
    })

    expect(localStorage.getItem(SECRET_PASSKEY_BACKED_UP)).toBeNull()
    expect(result.current.passkeyActive).toBe(false)
    expect(result.current.passkeySetupAvailable).toBe(true)
  })

  it('updates empty refresh state when marker removal throws', async () => {
    localStorage.setItem(SECRET_PASSKEY_BACKED_UP, 'true')
    mocks.getLocalPasskeyCredentialId.mockReturnValue('cred-local')
    mocks.getPasskeyDeviceState
      .mockResolvedValueOnce('this-device')
      .mockResolvedValueOnce('empty')
    const { result } = renderHook(() =>
      usePasskeyBackup({
        ...baseOptions,
        initialized: false,
        encryptionKey: 'key_current',
      }),
    )

    await act(async () => {
      await result.current.refreshBundleState()
    })
    const removeItem = vi
      .spyOn(Storage.prototype, 'removeItem')
      .mockImplementationOnce(() => {
        throw new Error('storage unavailable')
      })

    await act(async () => {
      await result.current.refreshBundleState()
    })
    removeItem.mockRestore()

    expect(result.current.passkeyActive).toBe(false)
    expect(result.current.passkeySetupAvailable).toBe(true)
  })

  it('waits for a key change before initializing a switched user', async () => {
    let resolveOldState!: (state: 'empty') => void
    const oldState = new Promise<'empty'>((resolve) => {
      resolveOldState = resolve
    })
    localStorage.setItem(SECRET_PASSKEY_BACKED_UP, 'true')
    mocks.getLocalPasskeyCredentialId.mockReturnValue('cred-local')
    mocks.getPasskeyDeviceState
      .mockReturnValueOnce(oldState)
      .mockResolvedValueOnce('this-device')
    const { result, rerender } = renderHook(
      ({ userId, encryptionKey }) =>
        usePasskeyBackup({
          ...baseOptions,
          user: { id: userId } as any,
          encryptionKey,
        }),
      {
        initialProps: { userId: 'user_1', encryptionKey: 'key_1' },
      },
    )

    await waitFor(() => expect(mocks.getPasskeyDeviceState).toHaveBeenCalled())
    rerender({ userId: 'user_2', encryptionKey: 'key_1' })

    await act(async () => {
      resolveOldState('empty')
      await oldState
    })

    expect(mocks.getPasskeyDeviceState).toHaveBeenCalledTimes(1)
    expect(mocks.isPrfSupported).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem(SECRET_PASSKEY_BACKED_UP)).toBe('true')
    expect(result.current.passkeyActive).toBe(false)
    expect(result.current.passkeySetupAvailable).toBe(false)

    rerender({ userId: 'user_2', encryptionKey: 'key_2' })
    await waitFor(() => expect(result.current.passkeyActive).toBe(true))

    expect(mocks.getPasskeyDeviceState).toHaveBeenCalledTimes(2)
    expect(mocks.isPrfSupported).toHaveBeenCalledTimes(2)
    expect(result.current.passkeySetupAvailable).toBe(false)
  })

  it('initializes once when the signed-in user finishes hydrating', async () => {
    mocks.getPasskeyDeviceState.mockResolvedValue('this-device')
    const { result, rerender } = renderHook(
      ({ userId }) =>
        usePasskeyBackup({
          ...baseOptions,
          user: userId ? ({ id: userId } as any) : null,
          encryptionKey: 'key_current',
        }),
      { initialProps: { userId: null as string | null } },
    )

    expect(mocks.getPasskeyDeviceState).not.toHaveBeenCalled()
    rerender({ userId: 'user_1' })
    await waitFor(() => expect(result.current.passkeyActive).toBe(true))

    expect(mocks.isPrfSupported).toHaveBeenCalledTimes(1)
    expect(mocks.validateCurrentPrimaryKey).toHaveBeenCalledTimes(1)
    expect(mocks.getPasskeyDeviceState).toHaveBeenCalledTimes(1)
  })

  it('ignores stale empty initialization after encryption key rotation', async () => {
    let resolveOldState!: (state: 'empty') => void
    const oldState = new Promise<'empty'>((resolve) => {
      resolveOldState = resolve
    })
    localStorage.setItem(SECRET_PASSKEY_BACKED_UP, 'true')
    mocks.getLocalPasskeyCredentialId.mockReturnValue('cred-local')
    mocks.getPasskeyDeviceState
      .mockReturnValueOnce(oldState)
      .mockResolvedValueOnce('this-device')
    const { result, rerender } = renderHook(
      ({ encryptionKey }) =>
        usePasskeyBackup({
          ...baseOptions,
          encryptionKey,
        }),
      { initialProps: { encryptionKey: 'key_1' } },
    )

    await waitFor(() => expect(mocks.getPasskeyDeviceState).toHaveBeenCalled())
    rerender({ encryptionKey: 'key_2' })
    await waitFor(() => expect(result.current.passkeyActive).toBe(true))

    await act(async () => {
      resolveOldState('empty')
      await oldState
    })

    expect(localStorage.getItem(SECRET_PASSKEY_BACKED_UP)).toBe('true')
    expect(result.current.passkeyActive).toBe(true)
    expect(result.current.passkeySetupAvailable).toBe(false)
  })

  it('applies final-empty initialization for the current account and key', async () => {
    localStorage.setItem(SECRET_PASSKEY_BACKED_UP, 'true')
    const { result } = renderHook(() =>
      usePasskeyBackup({ ...baseOptions, encryptionKey: 'key_current' }),
    )

    await waitFor(() => expect(result.current.passkeySetupAvailable).toBe(true))

    expect(localStorage.getItem(SECRET_PASSKEY_BACKED_UP)).toBeNull()
    expect(result.current.passkeyActive).toBe(false)
  })

  it('does not initialize twice for equivalent rerenders', async () => {
    mocks.getPasskeyDeviceState.mockResolvedValue('this-device')
    const { rerender } = renderHook(
      ({ user }) =>
        usePasskeyBackup({
          ...baseOptions,
          user,
          encryptionKey: 'key_current',
        }),
      { initialProps: { user: { id: 'user_1' } as any } },
    )

    await waitFor(() =>
      expect(mocks.getPasskeyDeviceState).toHaveBeenCalledTimes(1),
    )
    rerender({ user: { id: 'user_1' } as any })
    await act(async () => {
      await Promise.resolve()
    })

    expect(mocks.isPrfSupported).toHaveBeenCalledTimes(1)
    expect(mocks.validateCurrentPrimaryKey).toHaveBeenCalledTimes(1)
    expect(mocks.getPasskeyDeviceState).toHaveBeenCalledTimes(1)
  })

  it.each([
    {
      name: 'signed-in user changes',
      initial: { userId: 'user_1', encryptionKey: 'key_1' },
      next: { userId: 'user_2', encryptionKey: 'key_1' },
    },
    {
      name: 'encryption key rotates',
      initial: { userId: 'user_1', encryptionKey: 'key_1' },
      next: { userId: 'user_1', encryptionKey: 'key_2' },
    },
  ])('ignores an old empty refresh when $name', async ({ initial, next }) => {
    let resolveOldState!: (state: 'empty') => void
    const oldState = new Promise<'empty'>((resolve) => {
      resolveOldState = resolve
    })
    mocks.getLocalPasskeyCredentialId.mockReturnValue('cred-local')
    mocks.getPasskeyDeviceState
      .mockReturnValueOnce(oldState)
      .mockResolvedValueOnce('this-device')
    const { result, rerender } = renderHook(
      ({ userId, encryptionKey }) =>
        usePasskeyBackup({
          ...baseOptions,
          initialized: false,
          user: { id: userId } as any,
          encryptionKey,
        }),
      { initialProps: initial },
    )

    let staleRefresh!: Promise<void>
    await act(async () => {
      staleRefresh = result.current.refreshBundleState()
      await Promise.resolve()
    })
    rerender(next)
    localStorage.setItem(SECRET_PASSKEY_BACKED_UP, 'true')
    await act(async () => {
      await result.current.refreshBundleState()
      resolveOldState('empty')
      await staleRefresh
    })

    expect(localStorage.getItem(SECRET_PASSKEY_BACKED_UP)).toBe('true')
    expect(result.current.passkeyActive).toBe(true)
    expect(result.current.passkeySetupAvailable).toBe(false)
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
      mocks.getCurrentCloudKeyAuthorizationMode.mockResolvedValue('validated')
    })

    it('proceeds with promotion when remote legacy data exists', async () => {
      mocks.keyCurrent.mockResolvedValue({ key_id: null, has_data: true })
      mocks.getCurrentCloudKeyAuthorizationMode.mockResolvedValue(
        'explicit_start_fresh',
      )

      const { result } = renderHook(() => usePasskeyBackup(baseOptions))

      let success = false
      await act(async () => {
        success = await result.current.addPasskeyToThisDevice()
      })

      expect(success).toBe(true)
      expect(mocks.recoverPasskeyKeyBundle).toHaveBeenCalledOnce()
      expect(mocks.promoteRecoveredCekToEnclave).toHaveBeenCalledOnce()
      expect(mocks.promoteRecoveredCekToEnclave).toHaveBeenCalledWith(
        expect.objectContaining({
          keyBundle: expect.objectContaining({
            authorizationMode: 'explicit_start_fresh',
          }),
        }),
      )
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

    it('fails before reading remote key state when authorization is unavailable', async () => {
      mocks.getCurrentCloudKeyAuthorizationMode.mockResolvedValue(null)

      const { result } = renderHook(() => usePasskeyBackup(baseOptions))
      let success = true
      await act(async () => {
        success = await result.current.addPasskeyToThisDevice()
      })

      expect(success).toBe(false)
      expect(mocks.keyCurrent).not.toHaveBeenCalled()
      expect(mocks.createAndWrapTinfoilKey).not.toHaveBeenCalled()
      expect(mocks.promoteRecoveredCekToEnclave).not.toHaveBeenCalled()
    })

    it('makes no authorization or remote calls without a local primary key', async () => {
      mocks.getAllKeys.mockReturnValue({ primary: null, alternatives: [] })

      const { result } = renderHook(() => usePasskeyBackup(baseOptions))
      let success = true
      await act(async () => {
        success = await result.current.addPasskeyToThisDevice()
      })

      expect(success).toBe(false)
      expect(mocks.getCurrentCloudKeyAuthorizationMode).not.toHaveBeenCalled()
      expect(mocks.keyCurrent).not.toHaveBeenCalled()
    })

    it('makes no authorization or remote calls for invalid local key bytes', async () => {
      mocks.getAlternativeKeyBytes.mockReturnValue(null)

      const { result } = renderHook(() => usePasskeyBackup(baseOptions))
      let success = true
      await act(async () => {
        success = await result.current.addPasskeyToThisDevice()
      })

      expect(success).toBe(false)
      expect(mocks.getCurrentCloudKeyAuthorizationMode).not.toHaveBeenCalled()
      expect(mocks.keyCurrent).not.toHaveBeenCalled()
    })

    it('preserves Start Fresh authorization for current-key add-device enrollment', async () => {
      mocks.getAllKeys.mockReturnValue({
        primary: 'key_x',
        alternatives: ['key_previous'],
      })
      mocks.getCurrentCloudKeyAuthorizationMode.mockResolvedValue(
        'explicit_start_fresh',
      )
      mocks.keyCurrent.mockResolvedValue({ key_id: 'kid-current', bundles: {} })
      const primary = { credentialId: 'AQID' }
      mocks.createAndWrapTinfoilKey.mockResolvedValue({
        credentialId: 'AQID',
        wrappedKey: primary,
      })
      const wrappedKeys = { primary, alternatives: [{ credentialId: 'AQID' }] }
      mocks.wrapTinfoilKeyBundle.mockResolvedValue(wrappedKeys)
      mocks.addWrappedKeyForCurrentKey.mockResolvedValue(undefined)

      const { result } = renderHook(() => usePasskeyBackup(baseOptions))
      let success = false
      await act(async () => {
        success = await result.current.addPasskeyToThisDevice()
      })

      expect(success).toBe(true)
      const keyBundle = {
        primary: 'key_x',
        alternatives: ['key_previous'],
        authorizationMode: 'explicit_start_fresh',
      }
      expect(mocks.wrapTinfoilKeyBundle).toHaveBeenCalledWith(
        primary,
        keyBundle,
      )
      expect(mocks.addWrappedKeyForCurrentKey).toHaveBeenCalledWith({
        wrappedKeys,
        cek: new Uint8Array(32),
        keyIdHex: 'kid-current',
      })
    })
  })
})
