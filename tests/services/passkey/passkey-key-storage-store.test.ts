/**
 * passkey-key-storage.storeEncryptedKeys — enclave-wire contract.
 *
 * The legacy implementation talked to /api/passkey-credentials/ and
 * ran an optimistic client-side concurrency loop. The new module
 * routes through the enclave's register-key / add-bundle wire and
 * leaves concurrency to the enclave, so these tests assert the
 * branching contract (first-time register vs add-bundle vs
 * conflict) rather than version counters.
 */

import { TINFOIL_PASSKEY_PROFILE } from '@/services/passkey/kit'
import {
  PasskeyCredentialConflictError,
  storeEncryptedKeys,
  tinfoilWrappedKeyBundleToEnclave,
  type KeyBundle,
} from '@/services/passkey/passkey-key-storage'
import { SyncEnclaveError } from '@/services/sync-enclave/sync-enclave-client'
import { deriveTinfoilKeyIdHex } from '@/services/sync-enclave/tinfoil-key-id'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/utils/error-handling', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
}))

const mockRegisterKey = vi.fn()
const mockAddBundle = vi.fn()
const mockKeyCurrent = vi.fn()

vi.mock('@/services/sync-enclave/sync-api', async () => {
  const real = await vi.importActual<
    typeof import('@/services/sync-enclave/sync-api')
  >('@/services/sync-enclave/sync-api')
  return {
    ...real,
    registerKey: (...args: unknown[]) => mockRegisterKey(...args),
    addBundle: (...args: unknown[]) => mockAddBundle(...args),
    keyCurrent: (...args: unknown[]) => mockKeyCurrent(...args),
  }
})

const mockGetAlternativeKeyBytes = vi.fn<(k: string) => Uint8Array | null>()

vi.mock('@/services/encryption/encryption-service', () => ({
  encryptionService: {
    getAlternativeKeyBytes: (k: string) => mockGetAlternativeKeyBytes(k),
  },
}))

const PRIMARY_BYTES = new Uint8Array(32).fill(0x11)
const ALTERNATIVE_BYTES = new Uint8Array(32).fill(0x22)
const KEY_BUNDLE: KeyBundle = {
  primary: 'key_primary',
  alternatives: ['key_alt1'],
  authorizationMode: 'validated',
}

describe('passkey-key-storage storeEncryptedKeys (enclave wire)', () => {
  let expectedKeyId: string
  const wrappedKeys = (credentialId: string) => ({
    primary: {
      profile: TINFOIL_PASSKEY_PROFILE,
      credentialId,
      kekIvHex: '01'.repeat(12),
      wrappedKeyHex: '02'.repeat(48),
    },
    alternatives: [
      {
        profile: TINFOIL_PASSKEY_PROFILE,
        credentialId,
        kekIvHex: '03'.repeat(12),
        wrappedKeyHex: '04'.repeat(48),
      },
    ],
  })

  beforeEach(async () => {
    mockRegisterKey.mockReset()
    mockAddBundle.mockReset()
    mockKeyCurrent.mockReset()
    mockGetAlternativeKeyBytes.mockReset()
    mockGetAlternativeKeyBytes.mockImplementation((k) => {
      if (k === 'key_primary') return PRIMARY_BYTES
      if (k === 'key_alt1') return ALTERNATIVE_BYTES
      return null
    })

    expectedKeyId = await deriveTinfoilKeyIdHex(PRIMARY_BYTES)
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('registers the key + initial bundle when the enclave has no key yet', async () => {
    mockKeyCurrent
      .mockResolvedValueOnce({ key_id: null, bundles: {} })
      .mockResolvedValueOnce({
        key_id: expectedKeyId,
        bundles: { AQID: { bundle_version: 1 } },
      })
    mockRegisterKey.mockResolvedValue({ ok: true, key_id: expectedKeyId })

    const bundle = wrappedKeys('AQID')
    const result = await storeEncryptedKeys(bundle, KEY_BUNDLE)

    expect(result).toEqual({ syncVersion: 1, bundleVersion: 1 })
    expect(mockRegisterKey).toHaveBeenCalledOnce()
    expect(mockAddBundle).not.toHaveBeenCalled()
    const arg = mockRegisterKey.mock.calls[0][0]
    expect(arg.createdVia).toBe('passkey')
    expect(arg.initialBundle.credentialId).toBe('AQID')
    expect(arg.initialBundle).toEqual(
      tinfoilWrappedKeyBundleToEnclave(bundle, KEY_BUNDLE),
    )
  })

  it('uses created_via=start_fresh when the bundle is marked explicit_start_fresh', async () => {
    mockKeyCurrent
      .mockResolvedValueOnce({ key_id: null, bundles: {} })
      .mockResolvedValueOnce({
        key_id: expectedKeyId,
        bundles: { AQID: { bundle_version: 1 } },
      })
    mockRegisterKey.mockResolvedValue({ ok: true, key_id: expectedKeyId })
    await storeEncryptedKeys(wrappedKeys('AQID'), {
      ...KEY_BUNDLE,
      authorizationMode: 'explicit_start_fresh',
    })
    expect(mockRegisterKey.mock.calls[0][0].createdVia).toBe('start_fresh')
  })

  it('adopts the existing CEK via created_via=recovery when legacy data exists', async () => {
    mockKeyCurrent
      .mockResolvedValueOnce({ key_id: null, has_data: true, bundles: {} })
      .mockResolvedValueOnce({
        key_id: expectedKeyId,
        bundles: { AQID: { bundle_version: 1 } },
      })
    mockRegisterKey.mockResolvedValue({ ok: true, key_id: expectedKeyId })

    await storeEncryptedKeys(wrappedKeys('AQID'), KEY_BUNDLE)

    expect(mockRegisterKey).toHaveBeenCalledOnce()
    const arg = mockRegisterKey.mock.calls[0][0]
    expect(arg.createdVia).toBe('recovery')
    // The bundle is still attached so the adopted key is never stranded.
    expect(arg.initialBundle.credentialId).toBe('AQID')
  })

  it('maps EXISTING_DATA_UNDER_OTHER_KEY from register-key to a credential conflict', async () => {
    mockKeyCurrent.mockResolvedValue({ key_id: null, bundles: {} })
    mockRegisterKey.mockRejectedValue(
      new SyncEnclaveError('exists', 409, 'EXISTING_DATA_UNDER_OTHER_KEY'),
    )
    await expect(
      storeEncryptedKeys(wrappedKeys('AQID'), KEY_BUNDLE),
    ).rejects.toBeInstanceOf(PasskeyCredentialConflictError)
  })

  it('adds a bundle when the enclave already has the same primary CEK registered', async () => {
    mockKeyCurrent
      .mockResolvedValueOnce({ key_id: expectedKeyId, bundles: {} })
      .mockResolvedValueOnce({
        key_id: expectedKeyId,
        bundles: { BAUG: { bundle_version: 7 } },
      })
    mockAddBundle.mockResolvedValue({ ok: true })

    const bundle = wrappedKeys('BAUG')
    const result = await storeEncryptedKeys(bundle, KEY_BUNDLE)
    expect(result).toEqual({ syncVersion: 7, bundleVersion: 7 })
    expect(mockRegisterKey).not.toHaveBeenCalled()
    expect(mockAddBundle).toHaveBeenCalledOnce()
    const arg = mockAddBundle.mock.calls[0][0]
    expect(arg.keyId).toBe(expectedKeyId)
    expect(arg.credentialId).toBe('BAUG')
    const expectedBundle = tinfoilWrappedKeyBundleToEnclave(bundle, KEY_BUNDLE)
    expect(arg.kekIvHex).toBe(expectedBundle.kekIvHex)
    expect(arg.encryptedKeysHex).toBe(expectedBundle.encryptedKeysHex)
    expect(typeof arg.idempotencyKey).toBe('string')
  })

  it('throws PasskeyCredentialConflictError when the enclave KeyID differs from the local CEK', async () => {
    mockKeyCurrent.mockResolvedValue({
      key_id: 'deadbeef'.repeat(4),
      bundles: { BwgJ: { bundle_version: 2 } },
    })
    await expect(
      storeEncryptedKeys(wrappedKeys('BwgJ'), KEY_BUNDLE),
    ).rejects.toBeInstanceOf(PasskeyCredentialConflictError)
    expect(mockRegisterKey).not.toHaveBeenCalled()
    expect(mockAddBundle).not.toHaveBeenCalled()
  })

  it('returns null when an unexpected error escapes the enclave call', async () => {
    mockKeyCurrent.mockResolvedValue({ key_id: null, bundles: {} })
    mockRegisterKey.mockRejectedValue(new Error('boom'))
    const result = await storeEncryptedKeys(wrappedKeys('AQID'), KEY_BUNDLE)
    expect(result).toBeNull()
  })
})
