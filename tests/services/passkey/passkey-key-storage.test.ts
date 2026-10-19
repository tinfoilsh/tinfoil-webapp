import { SECRET_PASSKEY_PRF_OUTPUT } from '@/constants/storage-keys'
import { encryptionService } from '@/services/encryption/encryption-service'
import {
  passkeyKeyManager,
  TINFOIL_PASSKEY_PROFILE,
} from '@/services/passkey/kit'
import {
  decryptKeyBundle,
  recoverPasskeyKeyBundle,
  wrapTinfoilKeyBundle,
  type KeyBundle,
} from '@/services/passkey/passkey-key-storage'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/services/sync-enclave/sync-api', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@/services/sync-enclave/sync-api')
  >()),
  keyCurrent: vi.fn(async () => ({ key_id: null, bundles: {} })),
}))

const CREDENTIAL_ID = 'AQID'
const PRF_OUTPUT = Uint8Array.from({ length: 32 }, (_, index) => index)
const PRIMARY = `key_${'ar'.repeat(32)}`
const ALTERNATIVE = `key_${'as'.repeat(32)}`
const SECOND_ALTERNATIVE = `key_${'at'.repeat(32)}`
const LEGACY_IV = 'AQIDBAUGBwgJCgsM'
const PRIMARY_CIPHERTEXT =
  '1xR6jgDLBx4pG6hLEh6kLXlYz+gbmyu4YuMnGxOIcDIIkUlDVPF1+Gn/qJNUfTIfk1rAc+frkQlLs9cQVVHkribgOEmMopUnHVtbezyR8JutzN6w2S9wHWyyWviOKIy1lPgoqg6b37wo2/Pchdyaxnemk30='
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
    it('recovers a fixed legacy primary-only envelope', async () => {
      const original: KeyBundle = {
        primary: PRIMARY,
        alternatives: [],
      }

      const decrypted = (
        await recoverLegacy({ iv: LEGACY_IV, data: PRIMARY_CIPHERTEXT })
      )?.keyBundle

      expect(decrypted?.primary).toBe(original.primary)
      expect(decrypted?.alternatives).toEqual(original.alternatives)
    })

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

    it('wraps repeated primary and alternative keys with fresh IVs and ciphertext', async () => {
      const bundle: KeyBundle = {
        primary: PRIMARY,
        alternatives: [ALTERNATIVE],
      }

      const wrap = async () =>
        wrapTinfoilKeyBundle(
          await passkeyKeyManager.wrapKeyWithPRFResult({
            credentialId: CREDENTIAL_ID,
            keyMaterial: new Uint8Array(32).fill(0x11),
            prfResult: { output: PRF_OUTPUT },
          }),
          bundle,
          { output: PRF_OUTPUT },
        )
      const encrypted1 = await wrap()
      const encrypted2 = await wrap()
      expect(encrypted1).not.toBeNull()
      expect(encrypted2).not.toBeNull()
      expect(encrypted1?.primary.kekIvHex).not.toBe(
        encrypted2?.primary.kekIvHex,
      )
      expect(encrypted1?.primary.wrappedKeyHex).not.toBe(
        encrypted2?.primary.wrappedKeyHex,
      )
      expect(encrypted1?.alternatives[0].kekIvHex).not.toBe(
        encrypted2?.alternatives[0].kekIvHex,
      )
      expect(encrypted1?.alternatives[0].wrappedKeyHex).not.toBe(
        encrypted2?.alternatives[0].wrappedKeyHex,
      )
    })
  })

  describe('decryption failure cases', () => {
    it('should fail to decrypt with a different KEK', async () => {
      const encrypted = { iv: LEGACY_IV, data: PRIMARY_CIPHERTEXT }
      await expect(
        recoverLegacy(encrypted, new Uint8Array(32).fill(0xff)),
      ).resolves.toBeNull()
    })

    it('should fail to decrypt tampered ciphertext', async () => {
      const encrypted = { iv: LEGACY_IV, data: PRIMARY_CIPHERTEXT }

      // Tamper with one character in the middle of the ciphertext
      const tampered = {
        ...encrypted,
        data:
          encrypted.data.substring(0, 10) +
          (encrypted.data[10] === 'A' ? 'B' : 'A') +
          encrypted.data.substring(11),
      }

      await expect(recoverLegacy(tampered)).resolves.toBeNull()
    })

    it('should fail to decrypt with tampered IV', async () => {
      const encrypted = { iv: LEGACY_IV, data: PRIMARY_CIPHERTEXT }

      const tampered = {
        ...encrypted,
        iv:
          encrypted.iv.substring(0, 2) +
          (encrypted.iv[2] === 'A' ? 'B' : 'A') +
          encrypted.iv.substring(3),
      }

      await expect(recoverLegacy(tampered)).resolves.toBeNull()
    })
  })

  describe('key bundle validation', () => {
    it('should reject a decrypted payload with missing primary field', async () => {
      // Encrypt a malformed payload by going through the raw crypto
      const iv = crypto.getRandomValues(new Uint8Array(12))
      const malformed = JSON.stringify({ alternatives: [] })
      const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        kek,
        new TextEncoder().encode(malformed),
      )

      const uint8ToBase64 = (bytes: Uint8Array) => {
        let binary = ''
        for (let i = 0; i < bytes.length; i++) {
          binary += String.fromCharCode(bytes[i])
        }
        return btoa(binary)
      }

      const encrypted = {
        iv: uint8ToBase64(iv),
        data: uint8ToBase64(new Uint8Array(ciphertext)),
      }

      await expect(decryptKeyBundle(kek, encrypted)).rejects.toThrow(
        'Invalid key bundle structure',
      )
    })

    it('should reject a decrypted payload with missing alternatives field', async () => {
      const iv = crypto.getRandomValues(new Uint8Array(12))
      const malformed = JSON.stringify({ primary: 'key_test' })
      const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        kek,
        new TextEncoder().encode(malformed),
      )

      const uint8ToBase64 = (bytes: Uint8Array) => {
        let binary = ''
        for (let i = 0; i < bytes.length; i++) {
          binary += String.fromCharCode(bytes[i])
        }
        return btoa(binary)
      }

      const encrypted = {
        iv: uint8ToBase64(iv),
        data: uint8ToBase64(new Uint8Array(ciphertext)),
      }

      await expect(decryptKeyBundle(kek, encrypted)).rejects.toThrow(
        'Invalid key bundle structure',
      )
    })
  })
})
