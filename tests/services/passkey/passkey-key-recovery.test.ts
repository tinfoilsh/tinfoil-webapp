import { SECRET_PASSKEY_PRF_OUTPUT } from '@/constants/storage-keys'
import { encryptionService } from '@/services/encryption/encryption-service'
import {
  passkeyKeyManager,
  TINFOIL_PASSKEY_PROFILE,
} from '@/services/passkey/kit'
import {
  encryptKeyBundle,
  promoteRecoveredCekToEnclave,
  recoverPasskeyKeyBundle,
  tinfoilWrappedKeyBundleToEnclave,
  wrapTinfoilKeyBundle,
  type KeyBundle,
  type PasskeyCredentialEntry,
} from '@/services/passkey/passkey-key-storage'
import { hexToB64 } from '@/services/sync-enclave/sync-api'
import {
  decodeWrappedKeyRecord,
  encodeWrappedKeyRecord,
} from '@tinfoilsh/passkey-kit'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/utils/error-handling', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
}))

const mockKeyCurrent = vi.fn()
const mockAddBundle = vi.fn()
const mockRegisterKey = vi.fn()

vi.mock('@/services/sync-enclave/sync-api', async () => {
  const actual = await vi.importActual<
    typeof import('@/services/sync-enclave/sync-api')
  >('@/services/sync-enclave/sync-api')
  return {
    ...actual,
    addBundle: (...args: unknown[]) => mockAddBundle(...args),
    keyCurrent: (...args: unknown[]) => mockKeyCurrent(...args),
    registerKey: (...args: unknown[]) => mockRegisterKey(...args),
  }
})

const CREDENTIAL_ID = 'AQID'
const PRF_OUTPUT = new Uint8Array(32).map((_, index) => index)
const EXPECTED_PRIMARY_BYTES = new Uint8Array(32).map(
  (_, index) => 0xff - index,
)

async function genericEnvelopeEntry(
  keyBundle: KeyBundle,
  credentialId = CREDENTIAL_ID,
): Promise<PasskeyCredentialEntry> {
  const primaryBytes = encryptionService.getAlternativeKeyBytes(
    keyBundle.primary,
  )!
  const primary = await passkeyKeyManager.wrapKeyWithPRFResult({
    keyMaterial: primaryBytes,
    credentialId,
    prfResult: { output: PRF_OUTPUT },
  })
  const wrappedKeys = await wrapTinfoilKeyBundle(primary, keyBundle, {
    output: PRF_OUTPUT,
  })
  if (!wrappedKeys) throw new Error('failed to create generic envelope fixture')
  const transport = tinfoilWrappedKeyBundleToEnclave(wrappedKeys, keyBundle)
  return entry({
    id: credentialId,
    iv: hexToB64(transport.kekIvHex),
    encrypted_keys: hexToB64(transport.encryptedKeysHex),
    source: 'enclave',
  })
}

function cachePrf(): void {
  localStorage.setItem(
    SECRET_PASSKEY_PRF_OUTPUT,
    JSON.stringify({
      credentialId: CREDENTIAL_ID,
      prfOutput: btoa(String.fromCharCode(...PRF_OUTPUT)),
    }),
  )
}

async function legacyKek(): Promise<CryptoKey> {
  const input = await crypto.subtle.importKey(
    'raw',
    PRF_OUTPUT,
    'HKDF',
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(),
      info: TINFOIL_PASSKEY_PROFILE.hkdfInfo as BufferSource,
    },
    input,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

function entry(
  values: Partial<PasskeyCredentialEntry>,
): PasskeyCredentialEntry {
  return {
    id: CREDENTIAL_ID,
    encrypted_keys: '',
    iv: '',
    created_at: '2024-01-01T00:00:00.000Z',
    version: 1,
    sync_version: 1,
    ...values,
  }
}

describe('recoverPasskeyKeyBundle', () => {
  beforeEach(() => {
    localStorage.clear()
    cachePrf()
    mockKeyCurrent.mockReset().mockResolvedValue({ key_id: null, bundles: {} })
    mockAddBundle.mockReset()
    mockRegisterKey.mockReset()
  })

  it('adapts and unlocks existing raw bundle bytes through the manager', async () => {
    const recovered = await recoverPasskeyKeyBundle(
      [
        entry({
          iv: btoa(
            String.fromCharCode(
              ...new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]),
            ),
          ),
          encrypted_keys: btoa(
            String.fromCharCode(
              ...new Uint8Array(
                '53c8f700925c9f94a7cf679d8a892c82f7c443769103a322e477a38d9118f0a014a659136ee1b9f6ed4921877f17aca7'
                  .match(/../g)!
                  .map((byte) => parseInt(byte, 16)),
              ),
            ),
          ),
          source: 'enclave',
        }),
      ],
      { cachedOnly: true },
    )

    expect(recovered?.credentialId).toBe(CREDENTIAL_ID)
    expect(recovered?.keyBundle.primary).toBe(
      encryptionService.encodeKeyFromBytes(EXPECTED_PRIMARY_BYTES),
    )
    expect(recovered?.keyBundle.alternatives).toEqual([])
  })

  it('unwraps an evaluated current bundle without reading the PRF cache', async () => {
    localStorage.clear()
    const get = vi.fn(async () => ({
      rawId: new Uint8Array([1, 2, 3]).buffer,
      authenticatorAttachment: 'platform',
      getClientExtensionResults: () => ({
        prf: { results: { first: PRF_OUTPUT.buffer } },
      }),
    }))
    Object.defineProperty(navigator, 'credentials', {
      value: { create: vi.fn(), get },
      configurable: true,
    })
    const cacheRecovery = vi.spyOn(passkeyKeyManager, 'recoverKeyFromCache')
    const recovered = await recoverPasskeyKeyBundle([
      entry({
        iv: btoa(
          String.fromCharCode(
            ...new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]),
          ),
        ),
        encrypted_keys: btoa(
          String.fromCharCode(
            ...new Uint8Array(
              '53c8f700925c9f94a7cf679d8a892c82f7c443769103a322e477a38d9118f0a014a659136ee1b9f6ed4921877f17aca7'
                .match(/../g)!
                .map((byte) => parseInt(byte, 16)),
            ),
          ),
        ),
        source: 'enclave',
      }),
    ])

    expect(recovered?.credentialId).toBe(CREDENTIAL_ID)
    expect(recovered?.keyBundle.primary).toBe(
      encryptionService.encodeKeyFromBytes(EXPECTED_PRIMARY_BYTES),
    )
    expect(recovered?.prfResult?.output).toEqual(PRF_OUTPUT)
    expect(cacheRecovery).not.toHaveBeenCalled()
    cacheRecovery.mockRestore()
  })

  it('skips a malformed generic envelope without aborting a valid candidate', async () => {
    const malformed = new TextEncoder().encode(
      JSON.stringify({ version: 99, primary: 'invalid', alternatives: [] }),
    )
    const recovered = await recoverPasskeyKeyBundle(
      [
        entry({
          id: 'BAUG',
          iv: btoa(String.fromCharCode(...new Uint8Array(12))),
          encrypted_keys: btoa(String.fromCharCode(...malformed)),
          source: 'enclave',
        }),
        entry({
          iv: btoa(
            String.fromCharCode(
              ...new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]),
            ),
          ),
          encrypted_keys: btoa(
            String.fromCharCode(
              ...new Uint8Array(
                '53c8f700925c9f94a7cf679d8a892c82f7c443769103a322e477a38d9118f0a014a659136ee1b9f6ed4921877f17aca7'
                  .match(/../g)!
                  .map((byte) => parseInt(byte, 16)),
              ),
            ),
          ),
          source: 'enclave',
        }),
      ],
      { cachedOnly: true },
    )

    expect(recovered?.keyBundle.primary).toBe(
      encryptionService.encodeKeyFromBytes(EXPECTED_PRIMARY_BYTES),
    )
  })

  it('round-trips a primary and multiple alternatives through the generic envelope', async () => {
    const keyBundle = {
      primary: encryptionService.encodeKeyFromBytes(
        new Uint8Array(32).fill(0x41),
      ),
      alternatives: [
        encryptionService.encodeKeyFromBytes(new Uint8Array(32).fill(0x42)),
        encryptionService.encodeKeyFromBytes(new Uint8Array(32).fill(0x43)),
      ],
      authorizationMode: 'validated' as const,
    }
    const candidate = await genericEnvelopeEntry(keyBundle)
    const envelope = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(atob(candidate.encrypted_keys), (char) =>
          char.charCodeAt(0),
        ),
      ),
    ) as { primary: string; alternatives: string[] }
    const ivs = [envelope.primary, ...envelope.alternatives].map(
      (record) => decodeWrappedKeyRecord(record).kekIvHex,
    )
    const recovered = await recoverPasskeyKeyBundle([candidate], {
      cachedOnly: true,
    })

    expect(recovered?.keyBundle).toEqual(keyBundle)
    expect(new Set(ivs).size).toBe(3)
  })

  it('rejects generic envelopes encrypted for the wrong PRF', async () => {
    const keyBundle = {
      primary: encryptionService.encodeKeyFromBytes(
        new Uint8Array(32).fill(0x51),
      ),
      alternatives: [],
    }
    const candidate = await genericEnvelopeEntry(keyBundle)
    localStorage.setItem(
      SECRET_PASSKEY_PRF_OUTPUT,
      JSON.stringify({
        credentialId: CREDENTIAL_ID,
        prfOutput: btoa(String.fromCharCode(...new Uint8Array(32).fill(0xff))),
      }),
    )

    await expect(
      recoverPasskeyKeyBundle([candidate], { cachedOnly: true }),
    ).resolves.toBeNull()
  })

  it('rejects an envelope whose alternatives duplicate the primary key', async () => {
    const keyBytes = new Uint8Array(32).fill(0x61)
    const primary = await passkeyKeyManager.wrapKeyWithPRFResult({
      keyMaterial: keyBytes,
      credentialId: CREDENTIAL_ID,
      prfResult: { output: PRF_OUTPUT },
    })
    const duplicate = await passkeyKeyManager.wrapKeyWithPRFResult({
      keyMaterial: keyBytes,
      credentialId: CREDENTIAL_ID,
      prfResult: { output: PRF_OUTPUT },
    })
    const envelope = new TextEncoder().encode(
      JSON.stringify({
        version: 1,
        authorizationMode: 'validated',
        primary: encodeWrappedKeyRecord(primary),
        alternatives: [encodeWrappedKeyRecord(duplicate)],
      }),
    )
    const candidate = entry({
      iv: btoa(String.fromCharCode(...new Uint8Array(12))),
      encrypted_keys: btoa(String.fromCharCode(...envelope)),
      source: 'enclave',
    })

    await expect(
      recoverPasskeyKeyBundle([candidate], { cachedOnly: true }),
    ).resolves.toBeNull()
  })

  it('retains the legacy primary and alternatives decoder among candidates', async () => {
    const original = {
      primary: 'key_legacy_primary',
      alternatives: ['key_legacy_alternative'],
    }
    const encrypted = await encryptKeyBundle(await legacyKek(), original)
    const generic = await genericEnvelopeEntry(
      {
        primary: encryptionService.encodeKeyFromBytes(
          new Uint8Array(32).fill(0x71),
        ),
        alternatives: [],
      },
      'BwgJ',
    )
    const get = vi.fn(async () => ({
      rawId: new Uint8Array([1, 2, 3]).buffer,
      authenticatorAttachment: 'platform',
      getClientExtensionResults: () => ({
        prf: { results: { first: PRF_OUTPUT.buffer } },
      }),
    }))
    Object.defineProperty(navigator, 'credentials', {
      value: { create: vi.fn(), get },
      configurable: true,
    })
    const recovered = await recoverPasskeyKeyBundle([
      entry({
        id: 'BAUG',
        iv: btoa(String.fromCharCode(...new Uint8Array(12))),
        encrypted_keys: btoa(String.fromCharCode(...new Uint8Array(48))),
        source: 'enclave',
      }),
      generic,
      entry({
        id: 'CgsM',
        iv: btoa(String.fromCharCode(...new Uint8Array(12))),
        encrypted_keys: 'not base64!',
        source: 'enclave',
      }),
      entry({
        iv: encrypted.iv,
        encrypted_keys: encrypted.data,
        source: 'legacy',
      }),
    ])

    expect(recovered?.keyBundle).toEqual(original)
    expect(recovered?.source).toBe('legacy')
    expect(get.mock.calls[0][0].publicKey.allowCredentials).toHaveLength(3)
  })

  it('recovers the selected generic envelope among raw and legacy credentials', async () => {
    const keyBundle = {
      primary: encryptionService.encodeKeyFromBytes(
        new Uint8Array(32).fill(0x75),
      ),
      alternatives: [
        encryptionService.encodeKeyFromBytes(new Uint8Array(32).fill(0x76)),
      ],
      authorizationMode: 'validated' as const,
    }
    const legacy = await encryptKeyBundle(await legacyKek(), {
      primary: 'key_legacy_primary',
      alternatives: [],
    })
    const get = vi.fn(async () => ({
      rawId: new Uint8Array([7, 8, 9]).buffer,
      authenticatorAttachment: 'platform',
      getClientExtensionResults: () => ({
        prf: { results: { first: PRF_OUTPUT.buffer } },
      }),
    }))
    Object.defineProperty(navigator, 'credentials', {
      value: { create: vi.fn(), get },
      configurable: true,
    })

    const recovered = await recoverPasskeyKeyBundle([
      entry({
        id: 'BAUG',
        iv: btoa(String.fromCharCode(...new Uint8Array(12))),
        encrypted_keys: btoa(String.fromCharCode(...new Uint8Array(48))),
        source: 'enclave',
      }),
      await genericEnvelopeEntry(keyBundle, 'BwgJ'),
      entry({
        iv: legacy.iv,
        encrypted_keys: legacy.data,
        source: 'legacy',
      }),
    ])

    expect(recovered?.credentialId).toBe('BwgJ')
    expect(recovered?.keyBundle).toEqual(keyBundle)
    expect(get.mock.calls[0][0].publicKey.allowCredentials).toHaveLength(3)
  })

  it('persists all alternatives when promoting a recovered legacy bundle', async () => {
    const cek = new Uint8Array(32).fill(0x81)
    const keyBundle = {
      primary: encryptionService.encodeKeyFromBytes(cek),
      alternatives: [
        encryptionService.encodeKeyFromBytes(new Uint8Array(32).fill(0x82)),
        encryptionService.encodeKeyFromBytes(new Uint8Array(32).fill(0x83)),
      ],
    }
    mockKeyCurrent
      .mockResolvedValueOnce({ key_id: null, bundles: {} })
      .mockResolvedValue({ key_id: null, bundles: {} })
    mockRegisterKey.mockResolvedValue({ ok: true })

    await expect(
      promoteRecoveredCekToEnclave({
        cek,
        keyBundle,
        credentialId: CREDENTIAL_ID,
        prfResult: { output: PRF_OUTPUT },
      }),
    ).resolves.toBe(true)
    expect(mockRegisterKey).toHaveBeenCalledOnce()
    const initialBundle = mockRegisterKey.mock.calls[0][0].initialBundle
    const recovered = await recoverPasskeyKeyBundle(
      [
        entry({
          iv: hexToB64(initialBundle.kekIvHex),
          encrypted_keys: hexToB64(initialBundle.encryptedKeysHex),
          source: 'enclave',
        }),
      ],
      { cachedOnly: true },
    )
    expect(recovered?.keyBundle).toEqual({
      ...keyBundle,
      authorizationMode: 'validated',
    })
  })

  it('returns false when legacy promotion registration fails', async () => {
    const cek = new Uint8Array(32).map((_, index) => 0xff - index)
    const keyBundle = {
      primary: encryptionService.encodeKeyFromBytes(cek),
      alternatives: [
        encryptionService.encodeKeyFromBytes(new Uint8Array(32).fill(0x31)),
      ],
    }
    localStorage.clear()
    mockRegisterKey.mockRejectedValue(new Error('register unavailable'))

    await expect(
      promoteRecoveredCekToEnclave({
        cek,
        keyBundle,
        credentialId: CREDENTIAL_ID,
        prfResult: { output: PRF_OUTPUT },
      }),
    ).resolves.toBe(false)
    expect(mockRegisterKey).toHaveBeenCalledOnce()
  })

  it('returns false when legacy promotion add-bundle fails', async () => {
    const cek = new Uint8Array(32).map((_, index) => 0xff - index)
    const keyBundle = {
      primary: encryptionService.encodeKeyFromBytes(cek),
      alternatives: [
        encryptionService.encodeKeyFromBytes(new Uint8Array(32).fill(0x32)),
      ],
    }
    localStorage.clear()
    const { deriveTinfoilKeyIdHex } =
      await import('@/services/sync-enclave/tinfoil-key-id')
    mockKeyCurrent.mockResolvedValue({
      key_id: await deriveTinfoilKeyIdHex(cek),
      bundles: {},
    })
    mockAddBundle.mockRejectedValue(new Error('add unavailable'))

    await expect(
      promoteRecoveredCekToEnclave({
        cek,
        keyBundle,
        credentialId: CREDENTIAL_ID,
        prfResult: { output: PRF_OUTPUT },
      }),
    ).resolves.toBe(false)
    expect(mockAddBundle).toHaveBeenCalledOnce()
  })
})
