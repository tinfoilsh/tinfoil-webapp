import { SECRET_PASSKEY_PRF_OUTPUT } from '@/constants/storage-keys'
import { encryptionService } from '@/services/encryption/encryption-service'
import {
  passkeyKeyManager,
  TINFOIL_PASSKEY_PROFILE,
} from '@/services/passkey/kit'
import {
  promoteRecoveredCekToEnclave,
  recoverPasskeyKeyBundle,
  wrapTinfoilKeyBundle,
  type KeyBundle,
  type PasskeyCredentialEntry,
} from '@/services/passkey/passkey-key-storage'
import { hexToB64 } from '@/services/sync-enclave/sync-api'
import { SyncEnclaveError } from '@/services/sync-enclave/sync-enclave-client'
import { deriveTinfoilKeyIdHex } from '@/services/sync-enclave/tinfoil-key-id'
import {
  decodeWrappedKeyRecord,
  encodeWrappedKeyRecord,
} from '@tinfoilsh/passkey-kit'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
const originalCredentials = Object.getOwnPropertyDescriptor(
  navigator,
  'credentials',
)
const LEGACY_PRIMARY = `key_${'ar'.repeat(32)}`
const LEGACY_ALTERNATIVE = `key_${'as'.repeat(32)}`

function decodeEnvelope(candidate: PasskeyCredentialEntry) {
  return JSON.parse(
    Buffer.from(candidate.encrypted_keys, 'base64').toString('utf8'),
  ) as { primary: string; alternatives: string[] }
}

function installCredentialGet(
  rawId = new Uint8Array([1, 2, 3]),
  first: ArrayBuffer | number[] = PRF_OUTPUT.buffer,
) {
  const get = vi.fn(async (_options?: CredentialRequestOptions) => ({
    rawId: rawId.buffer,
    authenticatorAttachment: 'platform',
    getClientExtensionResults: () => ({ prf: { results: { first } } }),
  }))
  Object.defineProperty(navigator, 'credentials', {
    value: { create: vi.fn(), get },
    configurable: true,
  })
  return get
}

function undecryptableEnclaveEntry(): PasskeyCredentialEntry {
  return entry({
    id: 'BAUG',
    iv: Buffer.from(new Uint8Array(12)).toString('base64'),
    encrypted_keys: Buffer.from(new Uint8Array(48)).toString('base64'),
    source: 'enclave',
  })
}

async function encryptLegacyFixture(kek: CryptoKey, keys: KeyBundle) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    kek,
    new TextEncoder().encode(JSON.stringify(keys)),
  )
  return {
    iv: Buffer.from(iv).toString('base64'),
    data: Buffer.from(ciphertext).toString('base64'),
  }
}

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
  const envelope = JSON.stringify({
    version: 1,
    authorizationMode: keyBundle.authorizationMode ?? 'validated',
    primary: encodeWrappedKeyRecord(wrappedKeys.primary),
    alternatives: wrappedKeys.alternatives.map(encodeWrappedKeyRecord),
  })
  return entry({
    id: credentialId,
    iv: hexToB64(wrappedKeys.primary.kekIvHex),
    encrypted_keys: Buffer.from(envelope, 'utf8').toString('base64'),
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
    encryptionService.clearKey()
    cachePrf()
    mockKeyCurrent.mockReset().mockResolvedValue({ key_id: null, bundles: {} })
    mockAddBundle
      .mockReset()
      .mockRejectedValue(new Error('Unexpected bundle addition'))
    mockRegisterKey
      .mockReset()
      .mockRejectedValue(new Error('Unexpected registration'))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (originalCredentials)
      Object.defineProperty(navigator, 'credentials', originalCredentials)
    else Reflect.deleteProperty(navigator, 'credentials')
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

  it.each([
    { format: 'buffer', first: PRF_OUTPUT.buffer },
    { format: '1Password byte array', first: Array.from(PRF_OUTPUT) },
  ])('recovers with $format PRF output', async ({ first }) => {
    localStorage.clear()
    installCredentialGet(undefined, first)
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
    const envelope = decodeEnvelope(candidate)
    const ivs = [envelope.primary, ...envelope.alternatives].map(
      (record) => decodeWrappedKeyRecord(record).kekIvHex,
    )
    const recovered = await recoverPasskeyKeyBundle([candidate], {
      cachedOnly: true,
    })

    expect(recovered?.keyBundle).toEqual(keyBundle)
    expect(new Set(ivs).size).toBe(3)
  })

  it.each(['matching', 'missing', 'other-credential'] as const)(
    'routes cached recovery to each record and rejects unavailable alternatives: %s',
    async (result) => {
      const primary = new Uint8Array(32).fill(0x48)
      const alternative = new Uint8Array(32).fill(0x49)
      const keyBundle = {
        primary: encryptionService.encodeKeyFromBytes(primary),
        alternatives: [encryptionService.encodeKeyFromBytes(alternative)],
        authorizationMode: 'validated' as const,
      }
      const candidate = await genericEnvelopeEntry(keyBundle)
      const envelope = decodeEnvelope(candidate)
      const primaryRecord = decodeWrappedKeyRecord(envelope.primary)
      const alternativeRecord = decodeWrappedKeyRecord(envelope.alternatives[0])
      localStorage.removeItem(SECRET_PASSKEY_PRF_OUTPUT)
      const recoverFromCache = vi
        .spyOn(passkeyKeyManager, 'recoverKeyFromCache')
        .mockImplementation(async ({ wrappedKeys }) => {
          if (recoverFromCache.mock.calls.length === 1) {
            expect(wrappedKeys).toEqual([primaryRecord])
            return { credentialId: CREDENTIAL_ID, key: primary }
          }
          expect(wrappedKeys).toEqual([alternativeRecord])
          if (result === 'missing') return null
          return {
            credentialId: result === 'matching' ? CREDENTIAL_ID : 'BAUG',
            key: alternative,
          }
        })

      const recovered = await recoverPasskeyKeyBundle([candidate], {
        cachedOnly: true,
      })

      expect(localStorage.getItem(SECRET_PASSKEY_PRF_OUTPUT)).toBeNull()
      expect(recoverFromCache).toHaveBeenCalledTimes(2)
      if (result === 'matching') expect(recovered?.keyBundle).toEqual(keyBundle)
      else expect(recovered).toBeNull()
    },
  )

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

  it.each([
    'matching',
    'rotated',
    'unavailable',
    'not-found',
    'empty',
  ] as const)(
    'checks the registered key when recovering legacy candidates: %s',
    async (remoteState) => {
      const original = {
        primary: LEGACY_PRIMARY,
        alternatives: [LEGACY_ALTERNATIVE],
      }
      const encrypted = await encryptLegacyFixture(await legacyKek(), original)
      const keyId = await deriveTinfoilKeyIdHex(new Uint8Array(32).fill(0x11))
      if (remoteState === 'unavailable' || remoteState === 'not-found') {
        mockKeyCurrent.mockRejectedValue(
          new SyncEnclaveError(
            'opaque',
            remoteState === 'not-found' ? 404 : 503,
          ),
        )
      } else {
        mockKeyCurrent.mockResolvedValue({
          key_id:
            remoteState === 'matching'
              ? keyId
              : remoteState === 'rotated'
                ? 'ff'.repeat(16)
                : null,
          bundles: {},
        })
      }
      const generic = await genericEnvelopeEntry(
        {
          primary: encryptionService.encodeKeyFromBytes(
            new Uint8Array(32).fill(0x71),
          ),
          alternatives: [],
        },
        'BwgJ',
      )
      const get = installCredentialGet()
      const candidates = [
        undecryptableEnclaveEntry(),
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
      ]
      for (const cachedOnly of [false, true]) {
        cachePrf()
        const recovered = await recoverPasskeyKeyBundle(candidates, {
          cachedOnly,
        })
        if (remoteState === 'rotated' || remoteState === 'unavailable')
          expect(recovered).toBeNull()
        else {
          expect(recovered?.keyBundle).toEqual(original)
          expect(recovered?.source).toBe('legacy')
        }
      }
      expect(mockKeyCurrent).toHaveBeenCalledTimes(2)
      expect(get).toHaveBeenCalledOnce()
      expect(get.mock.calls[0][0]?.publicKey?.allowCredentials).toHaveLength(3)
    },
  )

  it('recovers Start Fresh authorization on another device among mixed credentials', async () => {
    const keyBundle = {
      primary: encryptionService.encodeKeyFromBytes(
        new Uint8Array(32).fill(0x75),
      ),
      alternatives: [
        encryptionService.encodeKeyFromBytes(new Uint8Array(32).fill(0x76)),
      ],
      authorizationMode: 'explicit_start_fresh' as const,
    }
    const legacy = await encryptLegacyFixture(await legacyKek(), {
      primary: LEGACY_PRIMARY,
      alternatives: [],
    })
    const get = installCredentialGet(new Uint8Array([7, 8, 9]))

    const recovered = await recoverPasskeyKeyBundle([
      undecryptableEnclaveEntry(),
      await genericEnvelopeEntry(keyBundle, 'BwgJ'),
      entry({
        iv: legacy.iv,
        encrypted_keys: legacy.data,
        source: 'legacy',
      }),
    ])

    expect(recovered?.credentialId).toBe('BwgJ')
    expect(recovered?.keyBundle).toEqual(keyBundle)
    expect(get.mock.calls[0][0]?.publicKey?.allowCredentials).toHaveLength(3)
  })

  it('persists the primary CEK when promoting a recovered legacy bundle', async () => {
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
    expect(mockRegisterKey).toHaveBeenCalledWith({
      keyB64: Buffer.from(cek).toString('base64'),
      ifMatch: '*',
      createdVia: 'recovery',
      idempotencyKey: expect.stringMatching(/^[0-9a-f]{32}$/),
      initialBundle: {
        credentialId: CREDENTIAL_ID,
        kekIvHex: expect.stringMatching(/^[0-9a-f]{24}$/),
        encryptedKeysHex: expect.stringMatching(/^[0-9a-f]{96}$/),
      },
    })
    expect(initialBundle.encryptedKeysHex).toMatch(/^[0-9a-f]{96}$/)
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
      primary: keyBundle.primary,
      alternatives: [],
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
