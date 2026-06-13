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

import {
  PasskeyCredentialConflictError,
  storeEncryptedKeys,
  type KeyBundle,
} from '@/services/passkey/passkey-key-storage'
import { deriveKeyEncryptionKey } from '@/services/passkey/passkey-service'
import { deriveKeyIdHex } from '@/services/sync-enclave/key-bundle'
import { SyncEnclaveError } from '@/services/sync-enclave/sync-enclave-client'
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
const KEY_BUNDLE: KeyBundle = {
  primary: 'key_primary',
  alternatives: ['key_alt1'],
  authorizationMode: 'validated',
}

describe('passkey-key-storage storeEncryptedKeys (enclave wire)', () => {
  let kek: CryptoKey
  let expectedKeyId: string

  beforeEach(async () => {
    mockRegisterKey.mockReset()
    mockAddBundle.mockReset()
    mockKeyCurrent.mockReset()
    mockGetAlternativeKeyBytes.mockReset()
    mockGetAlternativeKeyBytes.mockImplementation((k) =>
      k === 'key_primary' ? PRIMARY_BYTES : null,
    )

    const prfOutput = crypto.getRandomValues(new Uint8Array(32))
      .buffer as ArrayBuffer
    kek = await deriveKeyEncryptionKey(prfOutput)
    expectedKeyId = await deriveKeyIdHex(PRIMARY_BYTES)
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('registers the key + initial bundle when the enclave has no key yet', async () => {
    mockKeyCurrent
      .mockResolvedValueOnce({ key_id: null, bundles: {} })
      .mockResolvedValueOnce({
        key_id: expectedKeyId,
        bundles: { 'cred-1': { bundle_version: 1 } },
      })
    mockRegisterKey.mockResolvedValue({ ok: true, key_id: expectedKeyId })

    const result = await storeEncryptedKeys('cred-1', kek, KEY_BUNDLE)

    expect(result).toEqual({ syncVersion: 1, bundleVersion: 1 })
    expect(mockRegisterKey).toHaveBeenCalledOnce()
    expect(mockAddBundle).not.toHaveBeenCalled()
    const arg = mockRegisterKey.mock.calls[0][0]
    expect(arg.createdVia).toBe('passkey')
    expect(arg.initialBundle.credentialId).toBe('cred-1')
  })

  it('uses created_via=start_fresh when the bundle is marked explicit_start_fresh', async () => {
    mockKeyCurrent
      .mockResolvedValueOnce({ key_id: null, bundles: {} })
      .mockResolvedValueOnce({
        key_id: expectedKeyId,
        bundles: { 'cred-1': { bundle_version: 1 } },
      })
    mockRegisterKey.mockResolvedValue({ ok: true, key_id: expectedKeyId })
    await storeEncryptedKeys('cred-1', kek, {
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
        bundles: { 'cred-1': { bundle_version: 1 } },
      })
    mockRegisterKey.mockResolvedValue({ ok: true, key_id: expectedKeyId })

    await storeEncryptedKeys('cred-1', kek, KEY_BUNDLE)

    expect(mockRegisterKey).toHaveBeenCalledOnce()
    const arg = mockRegisterKey.mock.calls[0][0]
    expect(arg.createdVia).toBe('recovery')
    // The bundle is still attached so the adopted key is never stranded.
    expect(arg.initialBundle.credentialId).toBe('cred-1')
  })

  it('maps EXISTING_DATA_UNDER_OTHER_KEY from register-key to a credential conflict', async () => {
    mockKeyCurrent.mockResolvedValue({ key_id: null, bundles: {} })
    mockRegisterKey.mockRejectedValue(
      new SyncEnclaveError('exists', 409, 'EXISTING_DATA_UNDER_OTHER_KEY'),
    )
    await expect(
      storeEncryptedKeys('cred-1', kek, KEY_BUNDLE),
    ).rejects.toBeInstanceOf(PasskeyCredentialConflictError)
  })

  it('adds a bundle when the enclave already has the same primary CEK registered', async () => {
    mockKeyCurrent
      .mockResolvedValueOnce({ key_id: expectedKeyId, bundles: {} })
      .mockResolvedValueOnce({
        key_id: expectedKeyId,
        bundles: { 'cred-2': { bundle_version: 7 } },
      })
    mockAddBundle.mockResolvedValue({ ok: true })

    const result = await storeEncryptedKeys('cred-2', kek, KEY_BUNDLE)
    expect(result).toEqual({ syncVersion: 7, bundleVersion: 7 })
    expect(mockRegisterKey).not.toHaveBeenCalled()
    expect(mockAddBundle).toHaveBeenCalledOnce()
    const arg = mockAddBundle.mock.calls[0][0]
    expect(arg.keyId).toBe(expectedKeyId)
    expect(arg.credentialId).toBe('cred-2')
    expect(typeof arg.idempotencyKey).toBe('string')
  })

  it('throws PasskeyCredentialConflictError when the enclave KeyID differs from the local CEK', async () => {
    mockKeyCurrent.mockResolvedValue({
      key_id: 'deadbeef'.repeat(4),
      bundles: { 'cred-3': { bundle_version: 2 } },
    })
    await expect(
      storeEncryptedKeys('cred-3', kek, KEY_BUNDLE),
    ).rejects.toBeInstanceOf(PasskeyCredentialConflictError)
    expect(mockRegisterKey).not.toHaveBeenCalled()
    expect(mockAddBundle).not.toHaveBeenCalled()
  })

  it('returns null when an unexpected error escapes the enclave call', async () => {
    mockKeyCurrent.mockResolvedValue({ key_id: null, bundles: {} })
    mockRegisterKey.mockRejectedValue(new Error('boom'))
    const result = await storeEncryptedKeys('cred-1', kek, KEY_BUNDLE)
    expect(result).toBeNull()
  })
})
