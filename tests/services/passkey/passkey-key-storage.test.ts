import { SECRET_PASSKEY_PRF_OUTPUT } from '@/constants/storage-keys'
import { encryptionService } from '@/services/encryption/encryption-service'
import { TINFOIL_PASSKEY_PROFILE } from '@/services/passkey/kit'
import {
  decryptKeyBundle,
  recoverPasskeyKeyBundle,
  type KeyBundle,
} from '@/services/passkey/passkey-key-storage'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/services/harness/keys', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/harness/keys')>()),
  keyCurrent: vi.fn(async () => ({ key_id: null, bundles: {} })),
}))

const CREDENTIAL_ID = 'AQID'
const PRF_OUTPUT = Uint8Array.from({ length: 32 }, (_, index) => index)
const PRIMARY = `key_${'ar'.repeat(32)}`
const ALTERNATIVE = `key_${'as'.repeat(32)}`
const SECOND_ALTERNATIVE = `key_${'at'.repeat(32)}`
const LEGACY_IV = 'AQIDBAUGBwgJCgsM'
const ALTERNATIVES_CIPHERTEXT =
  '1xR6jgDLBx4pG6hLEh6kLXlYz+gbmyu4YuMnGxOIcDIIkUlDVPF1+Gn/qJNUfTIfk1rAc+frkQlLs9cQVVHkribgOEmMopUnHVtbezyR8JutzN6w2S9wHWyyWviOKIy1lPhXvL9sfe2bdfUNlvHaLSgmiURYZzk63TFeErTj8oL9YgWyrNNIvTy096rYvUbscgUtiKvgibRV87L8Z0nBMXX5cj/SMdt09MNGay20GGUcktA4PrKs07cjcdmuqO8LjLl4tpxrncH/bKtknXpSqiATbarLyH54Yw6K3rOJKWi9/5Ml4zN90ghwJBivQ6bwU4nCOnihXql+/OwLl58ouxQ='

function recoverLegacy(
  encrypted: { iv: string; data: string },
  prf = PRF_OUTPUT,
) {
  localStorage.setItem(
    SECRET_PASSKEY_PRF_OUTPUT,
    JSON.stringify({
      credentialId: CREDENTIAL_ID,
      prfOutput: Buffer.from(prf).toString('base64'),
    }),
  )
  return recoverPasskeyKeyBundle(
    [
      {
        id: CREDENTIAL_ID,
        iv: encrypted.iv,
        encrypted_keys: encrypted.data,
        created_at: '2024-01-01T00:00:00.000Z',
        version: 1,
        sync_version: 1,
        source: 'legacy',
      },
    ],
    { cachedOnly: true },
  )
}

async function deriveKeyEncryptionKey(
  prfOutput: ArrayBuffer,
): Promise<CryptoKey> {
  const input = await crypto.subtle.importKey('raw', prfOutput, 'HKDF', false, [
    'deriveKey',
  ])
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

describe('passkey-key-storage', () => {
  let kek: CryptoKey
  let prfOutput: ArrayBuffer

  beforeEach(async () => {
    encryptionService.clearKey()
    prfOutput = PRF_OUTPUT.slice().buffer
    kek = await deriveKeyEncryptionKey(prfOutput)
  })

  describe('encryptKeyBundle / decryptKeyBundle round-trip', () => {
    it('recovers fixed legacy primary and alternative keys', async () => {
      const original: KeyBundle = {
        primary: PRIMARY,
        alternatives: [ALTERNATIVE, SECOND_ALTERNATIVE],
      }

      const decrypted = (
        await recoverLegacy({ iv: LEGACY_IV, data: ALTERNATIVES_CIPHERTEXT })
      )?.keyBundle

      expect(decrypted?.primary).toBe(original.primary)
      expect(decrypted?.alternatives).toEqual(original.alternatives)
    })
  })

  describe('decryption failure cases', () => {
    it('should fail to decrypt with a different KEK', async () => {
      const encrypted = { iv: LEGACY_IV, data: ALTERNATIVES_CIPHERTEXT }
      await expect(
        recoverLegacy(encrypted, new Uint8Array(32).fill(0xff)),
      ).resolves.toBeNull()
    })
  })

  describe('key bundle validation', () => {
    it.each([
      ['primary', { alternatives: [] }],
      ['alternatives', { primary: 'key_test' }],
    ])(
      'should reject a decrypted payload with missing %s field',
      async (_field, malformed) => {
        const iv = crypto.getRandomValues(new Uint8Array(12))
        const ciphertext = await crypto.subtle.encrypt(
          { name: 'AES-GCM', iv },
          kek,
          new TextEncoder().encode(JSON.stringify(malformed)),
        )
        const encrypted = {
          iv: Buffer.from(iv).toString('base64'),
          data: Buffer.from(ciphertext).toString('base64'),
        }

        await expect(decryptKeyBundle(kek, encrypted)).rejects.toThrow(
          'Invalid key bundle structure',
        )
      },
    )
  })
})
