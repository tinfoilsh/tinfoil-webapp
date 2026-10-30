import { SECRET_PASSKEY_PRF_OUTPUT } from '@/constants/storage-keys'
import { encryptionService } from '@/services/encryption/encryption-service'
import { hexToB64 } from '@/services/harness/keys'
import { passkeyKeyManager } from '@/services/passkey/kit'
import {
  recoverPasskeyKeyBundle,
  wrapTinfoilKeyBundle,
  type KeyBundle,
  type PasskeyCredentialEntry,
} from '@/services/passkey/passkey-key-storage'
import {
  decodeWrappedKeyRecord,
  encodeWrappedKeyRecord,
} from '@tinfoilsh/passkey-kit'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/utils/error-handling', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
}))

const CREDENTIAL_ID = 'AQID'
const PRF_OUTPUT = new Uint8Array(32).map((_, index) => index)
const EXPECTED_PRIMARY_BYTES = new Uint8Array(32).map(
  (_, index) => 0xff - index,
)
const originalCredentials = Object.getOwnPropertyDescriptor(
  navigator,
  'credentials',
)

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
  })
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

function entry(
  values: Partial<PasskeyCredentialEntry>,
): PasskeyCredentialEntry {
  return {
    id: CREDENTIAL_ID,
    encrypted_keys: '',
    iv: '',
    created_at: '2024-01-01T00:00:00.000Z',
    sync_version: 1,
    ...values,
  }
}

describe('recoverPasskeyKeyBundle', () => {
  beforeEach(() => {
    encryptionService.clearKey()
    cachePrf()
  })

  afterEach(() => {
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
    const recovered = await recoverPasskeyKeyBundle([candidate], {
      cachedOnly: true,
    })

    expect(recovered?.keyBundle).toEqual(keyBundle)
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

      if (result === 'matching') expect(recovered?.keyBundle).toEqual(keyBundle)
      else expect(recovered).toBeNull()
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
    const get = installCredentialGet(new Uint8Array([7, 8, 9]))

    const recovered = await recoverPasskeyKeyBundle([
      undecryptableEnclaveEntry(),
      await genericEnvelopeEntry(keyBundle, 'BwgJ'),
    ])

    expect(recovered?.credentialId).toBe('BwgJ')
    expect(recovered?.keyBundle).toEqual(keyBundle)
    expect(get.mock.calls[0][0]?.publicKey?.allowCredentials).toHaveLength(2)
  })
})
