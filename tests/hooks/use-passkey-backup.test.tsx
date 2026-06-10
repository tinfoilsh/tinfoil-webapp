import { usePasskeyBackup } from '@/hooks/use-passkey-backup'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  inspectRemoteEncryptedState: vi.fn(),
  validateCurrentPrimaryKey: vi.fn(),
  authorizeCurrentPrimaryKeyOrThrow: vi.fn(),
  getCurrentCloudKeyAuthorizationMode: vi.fn(),
  isPrfSupported: vi.fn(),
  authenticatePrfPasskey: vi.fn(),
  createPrfPasskey: vi.fn(),
  decryptKeyBundle: vi.fn(),
  deletePasskeyCredential: vi.fn(),
  deriveKeyEncryptionKey: vi.fn(),
  getCachedPrfResult: vi.fn(),
  getLocalPasskeyCredentialId: vi.fn(),
  getPasskeyCredentialState: vi.fn(),
  getPasskeyDeviceState: vi.fn(),
  loadPasskeyCredentials: vi.fn(),
  loadRecoveryCandidates: vi.fn(),
  retrieveEncryptedKeys: vi.fn(),
  storeEncryptedKeys: vi.fn(),
  getKey: vi.fn(),
  getAllKeys: vi.fn(),
  setAllKeys: vi.fn(),
  replaceKeyBundle: vi.fn(),
  getAlternativeKeyBytes: vi.fn(),
  encodeKeyFromBytes: vi.fn(),
  generateKey: vi.fn(),
  cekBytesToHex: vi.fn(),
  addBundleForCurrentKey: vi.fn(),
  promoteRecoveredCekToEnclave: vi.fn(),
  keyCurrent: vi.fn(),
  probeLegacyDataWithLocalKeys: vi.fn(),
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

vi.mock('@/services/cloud/legacy-key-probe', () => ({
  legacyKeyProbeAllowsBinding: (result: { outcome: string }) =>
    result.outcome === 'decryptable' || result.outcome === 'no_sample',
  probeLegacyDataWithLocalKeys: mocks.probeLegacyDataWithLocalKeys,
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
    authenticatePrfPasskey: mocks.authenticatePrfPasskey,
    createPrfPasskey: mocks.createPrfPasskey,
    decryptKeyBundle: mocks.decryptKeyBundle,
    deletePasskeyCredential: mocks.deletePasskeyCredential,
    deriveKeyEncryptionKey: mocks.deriveKeyEncryptionKey,
    getCachedPrfResult: mocks.getCachedPrfResult,
    getLocalPasskeyCredentialId: mocks.getLocalPasskeyCredentialId,
    getPasskeyCredentialState: mocks.getPasskeyCredentialState,
    getPasskeyDeviceState: mocks.getPasskeyDeviceState,
    loadPasskeyCredentials: mocks.loadPasskeyCredentials,
    loadRecoveryCandidates: mocks.loadRecoveryCandidates,
    PasskeyCredentialConflictError: MockPasskeyCredentialConflictError,
    PasskeyTimeoutError: class MockPasskeyTimeoutError extends Error {},
    PrfNotSupportedError: class MockPrfNotSupportedError extends Error {},
    retrieveEncryptedKeys: mocks.retrieveEncryptedKeys,
    storeEncryptedKeys: mocks.storeEncryptedKeys,
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

vi.mock('@/services/sync-enclave/key-bundle', () => ({
  cekBytesToHex: mocks.cekBytesToHex,
}))

vi.mock('@/services/sync-enclave/passkey-events', () => ({
  passkeyEvents: {
    on: mocks.passkeyEventsOn,
    emit: mocks.passkeyEventsEmit,
  },
}))

vi.mock('@/services/sync-enclave/passkey-key-flow', () => ({
  addBundleForCurrentKey: mocks.addBundleForCurrentKey,
  promoteRecoveredCekToEnclave: mocks.promoteRecoveredCekToEnclave,
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
    mocks.probeLegacyDataWithLocalKeys.mockResolvedValue({
      outcome: 'decryptable',
    })
    mocks.getCachedPrfResult.mockReturnValue(null)
    mocks.getLocalPasskeyCredentialId.mockReturnValue(null)
    mocks.getKey.mockReturnValue(null)
    mocks.getAllKeys.mockReturnValue({ primary: null, alternatives: [] })
    mocks.passkeyEventsOn.mockReturnValue(() => {})
  })

  afterEach(() => {
    vi.clearAllMocks()
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
})
