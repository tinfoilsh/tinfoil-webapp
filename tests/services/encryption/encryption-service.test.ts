import {
  USER_ENCRYPTION_KEY,
  USER_ENCRYPTION_KEY_HISTORY,
} from '@/constants/storage-keys'
import {
  EncryptionService,
  type EncryptedData,
} from '@/services/encryption/encryption-service'
import { beforeEach, describe, expect, it } from 'vitest'

describe('EncryptionService', () => {
  let service: EncryptionService

  beforeEach(() => {
    service = new EncryptionService()
    localStorage.clear()
  })

  describe('generateKey', () => {
    it('should generate a key with key_ prefix', async () => {
      const key = await service.generateKey()
      expect(key).toMatch(/^key_[a-z0-9]+$/)
    })

    it('should generate keys of consistent length (64 chars after prefix for 256-bit)', async () => {
      const key = await service.generateKey()
      // 256 bits = 32 bytes, each byte becomes 2 chars in alphanumeric encoding
      expect(key.length).toBe(4 + 64) // 'key_' + 64 chars
    })

    it('should generate unique keys each time', async () => {
      const key1 = await service.generateKey()
      const key2 = await service.generateKey()
      expect(key1).not.toBe(key2)
    })
  })

  describe('setKey', () => {
    it('should accept a valid key', async () => {
      const key = await service.generateKey()
      await expect(service.setKey(key)).resolves.toBeUndefined()
    })

    it('should reject keys without key_ prefix', async () => {
      await expect(service.setKey('invalid_key')).rejects.toThrow(
        'Key must start with "key_" prefix',
      )
    })

    it('should reject keys with invalid characters', async () => {
      await expect(service.setKey('key_INVALID')).rejects.toThrow(
        'Key must only contain lowercase letters and numbers after the prefix',
      )
    })

    it('should reject keys with special characters', async () => {
      await expect(service.setKey('key_abc!def')).rejects.toThrow(
        'Key must only contain lowercase letters and numbers after the prefix',
      )
    })

    it('should persist key to localStorage', async () => {
      const key = await service.generateKey()
      await service.setKey(key)
      expect(localStorage.getItem(USER_ENCRYPTION_KEY)).toBe(key)
    })

    it('should store previous key in history when setting new key', async () => {
      const key1 = await service.generateKey()
      const key2 = await service.generateKey()

      await service.setKey(key1)
      await service.setKey(key2)

      const history = JSON.parse(
        localStorage.getItem(USER_ENCRYPTION_KEY_HISTORY) || '[]',
      )
      expect(history).toContain(key1)
    })
  })

  describe('getKey', () => {
    it('should return null when no key is set', () => {
      expect(service.getKey()).toBeNull()
    })

    it('should return the key after it is set', async () => {
      const key = await service.generateKey()
      await service.setKey(key)
      expect(service.getKey()).toBe(key)
    })
  })

  describe('clearKey', () => {
    it('should clear the key from memory and storage', async () => {
      const key = await service.generateKey()
      await service.setKey(key)

      service.clearKey()

      expect(service.getKey()).toBeNull()
      expect(localStorage.getItem(USER_ENCRYPTION_KEY)).toBeNull()
    })

    it('should clear key history', async () => {
      const key1 = await service.generateKey()
      const key2 = await service.generateKey()
      await service.setKey(key1)
      await service.setKey(key2)

      service.clearKey()

      expect(localStorage.getItem(USER_ENCRYPTION_KEY_HISTORY)).toBeNull()
    })

    it('should support clearing without persisting', async () => {
      const key = await service.generateKey()
      await service.setKey(key)

      service.clearKey({ persist: false })

      // Key should still be in localStorage
      expect(localStorage.getItem(USER_ENCRYPTION_KEY)).toBe(key)
    })
  })

  describe('initialize', () => {
    it('should return null when no key exists', async () => {
      const result = await service.initialize()
      expect(result).toBeNull()
    })

    it('should restore key from localStorage', async () => {
      const key = await service.generateKey()
      await service.setKey(key)

      // Create new service instance to simulate page reload
      const newService = new EncryptionService()
      const restoredKey = await newService.initialize()

      expect(restoredKey).toBe(key)
    })
  })

  describe('encrypt/decrypt roundtrip', () => {
    it('should roundtrip simple object', async () => {
      const key = await service.generateKey()
      await service.setKey(key)

      const data = { message: 'Hello, World!' }
      const encrypted = await service.encrypt(data)
      const decrypted = await service.decrypt(encrypted)

      expect(decrypted).toEqual(data)
    })

    it('should roundtrip complex chat data', async () => {
      const key = await service.generateKey()
      await service.setKey(key)

      const chatData = {
        id: 'chat-123',
        title: 'Test Chat',
        messages: [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi there!' },
        ],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:01:00Z',
      }

      const encrypted = await service.encrypt(chatData)
      const decrypted = await service.decrypt(encrypted)

      expect(decrypted).toEqual(chatData)
    })

    it('should roundtrip data with unicode characters', async () => {
      const key = await service.generateKey()
      await service.setKey(key)

      const data = { content: '你好世界 🌍 émojis and spëcial chars' }
      const encrypted = await service.encrypt(data)
      const decrypted = await service.decrypt(encrypted)

      expect(decrypted).toEqual(data)
    })

    it('should roundtrip empty object', async () => {
      const key = await service.generateKey()
      await service.setKey(key)

      const data = {}
      const encrypted = await service.encrypt(data)
      const decrypted = await service.decrypt(encrypted)

      expect(decrypted).toEqual(data)
    })

    it('should roundtrip array data', async () => {
      const key = await service.generateKey()
      await service.setKey(key)

      const data = [1, 2, 3, 'test', { nested: true }]
      const encrypted = await service.encrypt(data)
      const decrypted = await service.decrypt(encrypted)

      expect(decrypted).toEqual(data)
    })
  })

  describe('encrypt', () => {
    it('should throw when key not initialized', async () => {
      await expect(service.encrypt({ data: 'test' })).rejects.toThrow(
        'Encryption key not initialized',
      )
    })

    it('should produce different ciphertext for same plaintext (random IV)', async () => {
      const key = await service.generateKey()
      await service.setKey(key)

      const data = { message: 'same content' }
      const encrypted1 = await service.encrypt(data)
      const encrypted2 = await service.encrypt(data)

      // IVs should be different
      expect(encrypted1.iv).not.toBe(encrypted2.iv)
      // Ciphertext should be different due to different IVs
      expect(encrypted1.data).not.toBe(encrypted2.data)
    })

    it('should produce valid EncryptedData structure', async () => {
      const key = await service.generateKey()
      await service.setKey(key)

      const encrypted = await service.encrypt({ test: true })

      expect(encrypted).toHaveProperty('iv')
      expect(encrypted).toHaveProperty('data')
      expect(typeof encrypted.iv).toBe('string')
      expect(typeof encrypted.data).toBe('string')
    })
  })

  describe('decrypt', () => {
    it('should throw when key not initialized', async () => {
      const fakeEncrypted: EncryptedData = { iv: 'abc', data: 'def' }
      await expect(service.decrypt(fakeEncrypted)).rejects.toThrow(
        'Encryption key not initialized',
      )
    })

    it('should fail with completely unknown key', async () => {
      const key1 = await service.generateKey()
      const key2 = await service.generateKey()

      await service.setKey(key1)
      const encrypted = await service.encrypt({ secret: 'data' })

      // Create fresh service with no key history and set a different key
      const freshService = new EncryptionService()
      localStorage.clear() // Clear all key history
      await freshService.setKey(key2)

      await expect(freshService.decrypt(encrypted)).rejects.toThrow()
    })

    it('should fail with invalid base64', async () => {
      const key = await service.generateKey()
      await service.setKey(key)

      const invalidEncrypted: EncryptedData = {
        iv: '!!!invalid-base64!!!',
        data: 'also-invalid',
      }

      await expect(service.decrypt(invalidEncrypted)).rejects.toThrow(
        'Invalid base64 encoding',
      )
    })

    it('should fail with missing iv', async () => {
      const key = await service.generateKey()
      await service.setKey(key)

      const invalidEncrypted = { data: 'some-data' } as EncryptedData

      await expect(service.decrypt(invalidEncrypted)).rejects.toThrow(
        'Missing IV or data',
      )
    })

    it('should fail with missing data', async () => {
      const key = await service.generateKey()
      await service.setKey(key)

      const invalidEncrypted = { iv: 'some-iv' } as EncryptedData

      await expect(service.decrypt(invalidEncrypted)).rejects.toThrow(
        'Missing IV or data',
      )
    })
  })

  describe('fallback key decryption', () => {
    it('should decrypt with previous key after key rotation', async () => {
      const key1 = await service.generateKey()
      const key2 = await service.generateKey()

      // Encrypt with first key
      await service.setKey(key1)
      const encrypted = await service.encrypt({ message: 'secret' })

      // Rotate to new key
      await service.setKey(key2)

      // Should still decrypt using fallback
      const decrypted = await service.decrypt(encrypted)
      expect(decrypted).toEqual({ message: 'secret' })
    })

    it('should maintain key history across reinitializations', async () => {
      const key1 = await service.generateKey()
      const key2 = await service.generateKey()

      // Set up key history
      await service.setKey(key1)
      const encrypted = await service.encrypt({ data: 'test' })
      await service.setKey(key2)

      // Simulate page reload with new service instance
      const newService = new EncryptionService()
      await newService.initialize()

      // Should still be able to decrypt with fallback key
      const decrypted = await newService.decrypt(encrypted)
      expect(decrypted).toEqual({ data: 'test' })
    })
  })

  describe('alphanumeric encoding', () => {
    it('should reject odd-length keys', async () => {
      // key_ prefix + odd number of chars
      await expect(service.setKey('key_abc')).rejects.toThrow(
        'Key length must be even',
      )
    })

    it('should handle all valid alphanumeric characters', async () => {
      // Generate and verify several keys to ensure encoding handles all chars
      for (let i = 0; i < 10; i++) {
        const key = await service.generateKey()
        // Should only contain key_ prefix and lowercase alphanumeric
        expect(key).toMatch(/^key_[a-z0-9]+$/)

        // Should be able to set and use the key
        await service.setKey(key)
        const data = { test: i }
        const encrypted = await service.encrypt(data)
        const decrypted = await service.decrypt(encrypted)
        expect(decrypted).toEqual(data)
      }
    })
  })

  describe('large data handling', () => {
    it('should handle large payloads', async () => {
      const key = await service.generateKey()
      await service.setKey(key)

      // Create a large message array
      const largeData = {
        messages: Array.from({ length: 100 }, (_, i) => ({
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: 'x'.repeat(1000), // 1KB per message
        })),
      }

      const encrypted = await service.encrypt(largeData)
      const decrypted = await service.decrypt(encrypted)

      expect(decrypted).toEqual(largeData)
    })
  })

  describe('addDecryptionKey', () => {
    it('should add a valid key to the fallback list', async () => {
      const primaryKey = await service.generateKey()
      await service.setKey(primaryKey)

      const fallbackKey = await service.generateKey()
      service.addDecryptionKey(fallbackKey)

      expect(service.getFallbackKeyCount()).toBe(1)
    })

    it('should allow decrypting data encrypted with a fallback key', async () => {
      // Create service 1 with key1 and encrypt data
      const service1 = new EncryptionService()
      const key1 = await service1.generateKey()
      await service1.setKey(key1)
      const testData = { message: 'encrypted with key1' }
      const encrypted = await service1.encrypt(testData)

      // Create service 2 with key2 as primary
      const service2 = new EncryptionService()
      const key2 = await service2.generateKey()
      await service2.setKey(key2)

      // Add key1 as fallback
      service2.addDecryptionKey(key1)

      // Should be able to decrypt data encrypted with key1
      const decrypted = await service2.decrypt(encrypted)
      expect(decrypted).toEqual(testData)
    })

    it('should reject invalid key format', async () => {
      const key = await service.generateKey()
      await service.setKey(key)

      expect(() => service.addDecryptionKey('invalid_key')).toThrow(
        'Key must start with "key_" prefix',
      )
    })

    it('should not add the primary key to fallback list', async () => {
      const key = await service.generateKey()
      await service.setKey(key)

      // Try to add the current primary key
      service.addDecryptionKey(key)

      expect(service.getFallbackKeyCount()).toBe(0)
    })

    it('should not add duplicate keys', async () => {
      const primaryKey = await service.generateKey()
      await service.setKey(primaryKey)

      const fallbackKey = await service.generateKey()
      service.addDecryptionKey(fallbackKey)
      service.addDecryptionKey(fallbackKey) // Add again

      expect(service.getFallbackKeyCount()).toBe(1)
    })

    it('should persist fallback keys to storage', async () => {
      const primaryKey = await service.generateKey()
      await service.setKey(primaryKey)

      const fallbackKey = await service.generateKey()
      service.addDecryptionKey(fallbackKey)

      // Check storage
      const stored = localStorage.getItem(USER_ENCRYPTION_KEY_HISTORY)
      expect(stored).toBeTruthy()

      const parsed = JSON.parse(stored!)
      expect(parsed).toContain(fallbackKey)
    })
  })

  describe('clearFallbackKeys', () => {
    it('is a no-op when no fallback keys are registered', async () => {
      const primaryKey = await service.generateKey()
      await service.setKey(primaryKey)

      service.clearFallbackKeys()
      expect(service.getFallbackKeyCount()).toBe(0)
      expect(localStorage.getItem(USER_ENCRYPTION_KEY)).toBe(primaryKey)
      const stored = localStorage.getItem(USER_ENCRYPTION_KEY_HISTORY)
      expect(stored === null || stored === '[]').toBe(true)
    })

    it('drops every fallback key from memory and persists the empty history', async () => {
      const primaryKey = await service.generateKey()
      await service.setKey(primaryKey)
      service.addDecryptionKey(await service.generateKey())
      service.addDecryptionKey(await service.generateKey())
      expect(service.getFallbackKeyCount()).toBe(2)

      service.clearFallbackKeys()

      expect(service.getFallbackKeyCount()).toBe(0)
      const stored = localStorage.getItem(USER_ENCRYPTION_KEY_HISTORY)
      expect(stored).toBe('[]')
    })

    it('leaves the primary key untouched', async () => {
      const primaryKey = await service.generateKey()
      await service.setKey(primaryKey)
      service.addDecryptionKey(await service.generateKey())

      service.clearFallbackKeys()

      expect(service.getKey()).toBe(primaryKey)
      // The primary should still be usable for encrypt/decrypt.
      const enc = await service.encrypt({ msg: 'hello' })
      const dec = await service.decrypt(enc)
      expect(dec).toEqual({ msg: 'hello' })
    })
  })
})
