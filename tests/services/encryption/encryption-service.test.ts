import {
  USER_ENCRYPTION_KEY,
  USER_ENCRYPTION_KEY_HISTORY,
} from '@/constants/storage-keys'
import { EncryptionService } from '@/services/encryption/encryption-service'
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
      expect(key.length).toBe(4 + 64)
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

    it('should reject odd-length keys', async () => {
      await expect(service.setKey('key_abc')).rejects.toThrow(
        'Key length must be even',
      )
    })

    it('should reject keys that decode to the wrong byte length', async () => {
      // 8 valid chars decode to 4 bytes — far short of the 32 a CEK
      // needs. Without the byte-length guard this would persist and
      // break every downstream crypto/sync operation.
      await expect(service.setKey('key_abcdefgh')).rejects.toThrow(
        /must decode to 32 bytes/,
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

  describe('getKey / getKeyBytesOrThrow', () => {
    it('should return null when no key is set', () => {
      expect(service.getKey()).toBeNull()
    })

    it('should return the key after it is set', async () => {
      const key = await service.generateKey()
      await service.setKey(key)
      expect(service.getKey()).toBe(key)
    })

    it('getKeyBytesOrThrow throws when no key is set', () => {
      expect(() => service.getKeyBytesOrThrow()).toThrow(
        /no encryption key available/,
      )
    })

    it('getKeyBytesOrThrow returns raw bytes for the current key', async () => {
      const key = await service.generateKey()
      await service.setKey(key)
      const bytes = service.getKeyBytesOrThrow()
      expect(bytes).toBeInstanceOf(Uint8Array)
      expect(bytes.byteLength).toBe(32)
    })

    it('encodeKeyFromBytes round-trips raw CEK bytes through setKey', async () => {
      const key = await service.generateKey()
      await service.setKey(key)
      const bytes = service.getKeyBytesOrThrow()

      const encoded = service.encodeKeyFromBytes(bytes)
      expect(encoded).toBe(key)

      service.clearKey()
      await service.setKey(encoded)
      expect(service.getKeyBytesOrThrow()).toEqual(bytes)
    })

    it('encodeKeyFromBytes rejects non-32-byte input', () => {
      expect(() => service.encodeKeyFromBytes(new Uint8Array(16))).toThrow(
        /32 bytes/,
      )
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

      const newService = new EncryptionService()
      const restoredKey = await newService.initialize()

      expect(restoredKey).toBe(key)
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

      service.addDecryptionKey(key)

      expect(service.getFallbackKeyCount()).toBe(0)
    })

    it('should not add duplicate keys', async () => {
      const primaryKey = await service.generateKey()
      await service.setKey(primaryKey)

      const fallbackKey = await service.generateKey()
      service.addDecryptionKey(fallbackKey)
      service.addDecryptionKey(fallbackKey)

      expect(service.getFallbackKeyCount()).toBe(1)
    })

    it('should persist fallback keys to storage', async () => {
      const primaryKey = await service.generateKey()
      await service.setKey(primaryKey)

      const fallbackKey = await service.generateKey()
      service.addDecryptionKey(fallbackKey)

      const stored = localStorage.getItem(USER_ENCRYPTION_KEY_HISTORY)
      expect(stored).toBeTruthy()

      const parsed = JSON.parse(stored!)
      expect(parsed).toContain(fallbackKey)
    })

    it('should trigger onFallbackKeyAdded callbacks', async () => {
      const primaryKey = await service.generateKey()
      await service.setKey(primaryKey)

      let calls = 0
      const unsubscribe = service.onFallbackKeyAdded(() => {
        calls += 1
      })

      service.addDecryptionKey(await service.generateKey())
      expect(calls).toBe(1)

      unsubscribe()
      service.addDecryptionKey(await service.generateKey())
      expect(calls).toBe(1)
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
      expect(service.getKeyBytesOrThrow()).toBeInstanceOf(Uint8Array)
    })
  })

  describe('setAllKeys / replaceKeyBundle', () => {
    it('setAllKeys persists the primary and alternatives', async () => {
      const primary = await service.generateKey()
      const alt1 = await service.generateKey()
      const alt2 = await service.generateKey()

      await service.setAllKeys(primary, [alt1, alt2])

      expect(service.getKey()).toBe(primary)
      expect(service.getFallbackKeyCount()).toBe(2)
      const stored = JSON.parse(
        localStorage.getItem(USER_ENCRYPTION_KEY_HISTORY) || '[]',
      )
      expect(stored).toEqual(expect.arrayContaining([alt1, alt2]))
    })

    it('setAllKeys skips invalid alternatives silently', async () => {
      const primary = await service.generateKey()
      const alt = await service.generateKey()

      await service.setAllKeys(primary, [alt, 'bogus_key'])

      expect(service.getFallbackKeyCount()).toBe(1)
    })

    it('replaceKeyBundle clears the bundle when primary is null', async () => {
      const primary = await service.generateKey()
      await service.setKey(primary)

      await service.replaceKeyBundle(null, [])

      expect(service.getKey()).toBeNull()
      expect(localStorage.getItem(USER_ENCRYPTION_KEY)).toBeNull()
    })

    it('replaceKeyBundle swaps primary and updates alternatives', async () => {
      const oldPrimary = await service.generateKey()
      const newPrimary = await service.generateKey()
      const alt = await service.generateKey()

      await service.setKey(oldPrimary)
      await service.replaceKeyBundle(newPrimary, [alt])

      expect(service.getKey()).toBe(newPrimary)
      expect(service.getFallbackKeyCount()).toBe(1)
    })
  })
})
