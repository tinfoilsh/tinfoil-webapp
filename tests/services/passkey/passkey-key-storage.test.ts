import { TINFOIL_PASSKEY_PROFILE } from '@/services/passkey/kit'
import {
  decryptKeyBundle,
  encryptKeyBundle,
  type KeyBundle,
} from '@/services/passkey/passkey-key-storage'
import { beforeEach, describe, expect, it } from 'vitest'

/**
 * Generate a deterministic 32-byte PRF output for testing.
 * Real PRF outputs come from WebAuthn; here we simulate with random bytes.
 */
function generateTestPrfOutput(): ArrayBuffer {
  return crypto.getRandomValues(new Uint8Array(32)).buffer as ArrayBuffer
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
    prfOutput = generateTestPrfOutput()
    kek = await deriveKeyEncryptionKey(prfOutput)
  })

  describe('encryptKeyBundle / decryptKeyBundle round-trip', () => {
    it('should encrypt and decrypt a key bundle with primary only', async () => {
      const original: KeyBundle = {
        primary: 'key_abcdef1234567890',
        alternatives: [],
      }

      const encrypted = await encryptKeyBundle(kek, original)
      const decrypted = await decryptKeyBundle(kek, encrypted)

      expect(decrypted.primary).toBe(original.primary)
      expect(decrypted.alternatives).toEqual(original.alternatives)
    })

    it('should encrypt and decrypt a key bundle with alternatives', async () => {
      const original: KeyBundle = {
        primary: 'key_primary1234567890abcdef',
        alternatives: ['key_alt1abcdef1234567890', 'key_alt2abcdef1234567890'],
      }

      const encrypted = await encryptKeyBundle(kek, original)
      const decrypted = await decryptKeyBundle(kek, encrypted)

      expect(decrypted.primary).toBe(original.primary)
      expect(decrypted.alternatives).toEqual(original.alternatives)
    })

    it('should produce different ciphertext for the same plaintext (random IV)', async () => {
      const bundle: KeyBundle = {
        primary: 'key_abcdef1234567890',
        alternatives: [],
      }

      const encrypted1 = await encryptKeyBundle(kek, bundle)
      const encrypted2 = await encryptKeyBundle(kek, bundle)

      expect(encrypted1.iv).not.toBe(encrypted2.iv)
      expect(encrypted1.data).not.toBe(encrypted2.data)
    })
  })

  describe('decryption failure cases', () => {
    it('should fail to decrypt with a different KEK', async () => {
      const bundle: KeyBundle = {
        primary: 'key_abcdef1234567890',
        alternatives: [],
      }

      const encrypted = await encryptKeyBundle(kek, bundle)

      const differentPrf = generateTestPrfOutput()
      const differentKek = await deriveKeyEncryptionKey(differentPrf)

      await expect(decryptKeyBundle(differentKek, encrypted)).rejects.toThrow()
    })

    it('should fail to decrypt tampered ciphertext', async () => {
      const bundle: KeyBundle = {
        primary: 'key_abcdef1234567890',
        alternatives: [],
      }

      const encrypted = await encryptKeyBundle(kek, bundle)

      // Tamper with one character in the middle of the ciphertext
      const tampered = {
        ...encrypted,
        data:
          encrypted.data.substring(0, 10) +
          (encrypted.data[10] === 'A' ? 'B' : 'A') +
          encrypted.data.substring(11),
      }

      await expect(decryptKeyBundle(kek, tampered)).rejects.toThrow()
    })

    it('should fail to decrypt with tampered IV', async () => {
      const bundle: KeyBundle = {
        primary: 'key_abcdef1234567890',
        alternatives: [],
      }

      const encrypted = await encryptKeyBundle(kek, bundle)

      const tampered = {
        ...encrypted,
        iv:
          encrypted.iv.substring(0, 2) +
          (encrypted.iv[2] === 'A' ? 'B' : 'A') +
          encrypted.iv.substring(3),
      }

      await expect(decryptKeyBundle(kek, tampered)).rejects.toThrow()
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
