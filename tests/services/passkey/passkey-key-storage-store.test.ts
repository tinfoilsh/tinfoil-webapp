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

import { HarnessError } from '@/services/harness/sse'
import { deriveTinfoilKeyIdHex } from '@/services/keys/tinfoil-key-id'
import { TINFOIL_PASSKEY_PROFILE } from '@/services/passkey/kit'
import {
  PasskeyCredentialConflictError,
  storeEncryptedKeys,
  type KeyBundle,
  type TinfoilWrappedKeyBundle,
} from '@/services/passkey/passkey-key-storage'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/utils/error-handling', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
}))

const mockRegisterKey = vi.fn()
const mockAddBundle = vi.fn()
const mockKeyCurrent = vi.fn()

vi.mock('@/services/harness/keys', async () => {
  const real = await vi.importActual<typeof import('@/services/harness/keys')>(
    '@/services/harness/keys',
  )
  return {
    ...real,
    registerKey: (...args: unknown[]) => mockRegisterKey(...args),
    addBundle: (...args: unknown[]) => mockAddBundle(...args),
    keyCurrent: (...args: unknown[]) => mockKeyCurrent(...args),
  }
})

const PRIMARY_BYTES = new Uint8Array(32).fill(0x11)
const PRIMARY_KEY_B64 = 'ERERERERERERERERERERERERERERERERERERERERERE='
const KEY_BUNDLE: KeyBundle = {
  primary: `key_${'ar'.repeat(32)}`,
  alternatives: [`key_${'a8'.repeat(32)}`],
  authorizationMode: 'validated',
}

function expectedBundle(wrappedKeys: TinfoilWrappedKeyBundle) {
  return {
    credentialId: wrappedKeys.primary.credentialId,
    kekIvHex: wrappedKeys.primary.kekIvHex,
    encryptedKeysHex: wrappedKeys.primary.wrappedKeyHex,
  }
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
    alternatives: [],
  })

  beforeEach(async () => {
    mockRegisterKey
      .mockReset()
      .mockRejectedValue(new Error('Unexpected registration'))
    mockAddBundle
      .mockReset()
      .mockRejectedValue(new Error('Unexpected bundle addition'))
    mockKeyCurrent.mockReset()

    expectedKeyId = await deriveTinfoilKeyIdHex(PRIMARY_BYTES)
  })

  it('uses created_via=start_fresh when the bundle is marked explicit_start_fresh', async () => {
    mockKeyCurrent
      .mockResolvedValueOnce({ key_id: null, bundles: {} })
      .mockResolvedValueOnce({
        key_id: expectedKeyId,
        bundles: { AQID: { bundle_version: 1 } },
      })
    mockRegisterKey.mockResolvedValue({ ok: true, key_id: expectedKeyId })
    const bundle = wrappedKeys('AQID')
    await storeEncryptedKeys(bundle, {
      ...KEY_BUNDLE,
      authorizationMode: 'explicit_start_fresh',
    })
    expect(mockRegisterKey.mock.calls[0][0].createdVia).toBe('start_fresh')
    expect(mockRegisterKey.mock.calls[0][0].initialBundle).toEqual(
      expectedBundle(bundle),
    )
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

  it.each([
    { code: 'KEY_MISMATCH', conflict: true },
    { code: 'REVISION_CONFLICT', conflict: false },
  ])(
    'maps only the harness key-mismatch refusal to a credential conflict: $code',
    async ({ code, conflict }) => {
      mockKeyCurrent.mockResolvedValue({ key_id: null, bundles: {} })
      mockRegisterKey.mockRejectedValue(
        new HarnessError({ message: 'refused', code }, 409),
      )
      const stored = storeEncryptedKeys(wrappedKeys('AQID'), KEY_BUNDLE)
      if (conflict)
        await expect(stored).rejects.toBeInstanceOf(
          PasskeyCredentialConflictError,
        )
      else await expect(stored).resolves.toBeNull()
      expect(mockRegisterKey).toHaveBeenCalledOnce()
    },
  )

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
    expect(arg).toEqual({
      keyId: expectedKeyId,
      keyB64: PRIMARY_KEY_B64,
      ...expectedBundle(bundle),
      idempotencyKey: expect.stringMatching(/^[0-9a-f]{32}$/),
    })
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
})
