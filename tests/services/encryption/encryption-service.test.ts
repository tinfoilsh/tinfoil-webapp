import {
  LEGACY_ENCRYPTION_KEY,
  LEGACY_ENCRYPTION_KEY_HISTORY,
  USER_ENCRYPTION_KEY,
  USER_ENCRYPTION_KEY_HISTORY,
} from '@/constants/storage-keys'
import {
  ENCRYPTION_KEY_CHANGED_EVENT,
  EncryptionService,
} from '@/services/encryption/encryption-service'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const KEY_BYTES = new Uint8Array(32).fill(0x11)
const KEY_STRING = `key_${'ar'.repeat(32)}`
const ALTERNATIVE_KEY = `key_${'as'.repeat(32)}`
const REPLACEMENT_KEY = `key_${'at'.repeat(32)}`

describe('EncryptionService', () => {
  let service: EncryptionService

  beforeEach(() => {
    service = new EncryptionService()
    localStorage.clear()
  })

  afterEach(() => vi.restoreAllMocks())

  describe('generateKey', () => {
    it('should generate distinct canonical 256-bit keys', async () => {
      const key = await service.generateKey()
      expect(key).toMatch(/^key_[a-z0-9]{64}$/)
      expect(key.length).toBe(4 + 64)
      const key2 = await service.generateKey()
      expect(key).not.toBe(key2)
      for (const generated of [key, key2]) {
        await service.setKey(generated)
        expect(service.getKeyBytesOrThrow()).toHaveLength(32)
        expect(service.encodeKeyFromBytes(service.getKeyBytesOrThrow())).toBe(
          generated,
        )
      }
    })
  })

  describe('setKey', () => {
    it('should reject keys without key_ prefix', async () => {
      await expect(service.setKey('invalid_key')).rejects.toThrow(
        'Key must start with "key_" prefix',
      )
    })

    it.each(['key_INVALID', 'key_abc!def'])(
      'should reject keys with invalid characters: %s',
      async (key) => {
        await expect(service.setKey(key)).rejects.toThrow(
          'Key must only contain lowercase letters and numbers after the prefix',
        )
      },
    )

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

  describe('staged activation (persist: false)', () => {
    it('stages the key in memory without touching storage', async () => {
      expect(service.getKey()).toBeNull()
      const key = await service.generateKey()
      await service.setKey(key, { persist: false })

      expect(localStorage.getItem(USER_ENCRYPTION_KEY)).toBeNull()
      expect(service.getKey()).toBeNull()
      // The active CEK is still usable for the enclave handshake.
      expect(service.getKeyBytesOrThrow().byteLength).toBe(32)
    })

    it('persistCurrentKeyState commits the staged key to storage', async () => {
      const key = await service.generateKey()
      await service.setKey(key, { persist: false })

      service.persistCurrentKeyState()

      expect(service.getKey()).toBe(key)
      expect(localStorage.getItem(USER_ENCRYPTION_KEY)).toBe(key)
    })

    it('keeps the previous stored key until the staged key is committed', async () => {
      const existing = await service.generateKey()
      await service.setKey(existing)
      const existingBytes = service.getKeyBytesOrThrow()

      const staged = await service.generateKey()
      await service.setKey(staged, { persist: false })

      // Storage still reports the previous key, so an interrupted
      // activation can never strand a local-only key.
      expect(service.getKey()).toBe(existing)
      expect(localStorage.getItem(USER_ENCRYPTION_KEY)).toBe(existing)
      // The active CEK used by the enclave handshake is the staged key.
      expect(service.getKeyBytesOrThrow()).not.toEqual(existingBytes)

      service.persistCurrentKeyState()
      expect(service.getKey()).toBe(staged)
    })
  })

  describe('getKey / getKeyBytesOrThrow', () => {
    it('getKeyBytesOrThrow throws when no key is set', () => {
      expect(() => service.getKeyBytesOrThrow()).toThrow(
        /no encryption key available/,
      )
    })

    it('getKeyBytesOrThrow returns raw bytes for the current key', async () => {
      await service.setKey(KEY_STRING)
      const bytes = service.getKeyBytesOrThrow()
      expect(bytes).toBeInstanceOf(Uint8Array)
      expect(bytes.byteLength).toBe(32)
      expect(bytes).toEqual(KEY_BYTES)
      bytes.fill(0)
      expect(service.getKeyBytesOrThrow()).toEqual(KEY_BYTES)
    })

    it('encodeKeyFromBytes round-trips raw CEK bytes through setKey', async () => {
      const key = KEY_STRING
      const bytes = KEY_BYTES.slice()

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
      localStorage.setItem(LEGACY_ENCRYPTION_KEY, key)

      service.clearKey()

      expect(service.getKey()).toBeNull()
      expect(localStorage.getItem(USER_ENCRYPTION_KEY)).toBeNull()
      expect(() => service.getKeyBytesOrThrow()).toThrow(
        /no encryption key available/,
      )
      expect(service.getAllKeys()).toEqual({ primary: null, alternatives: [] })
      expect(localStorage.getItem(LEGACY_ENCRYPTION_KEY)).toBeNull()
    })

    it('should clear key history', async () => {
      const key1 = await service.generateKey()
      const key2 = await service.generateKey()
      await service.setKey(key1)
      await service.setKey(key2)

      localStorage.setItem(
        LEGACY_ENCRYPTION_KEY_HISTORY,
        JSON.stringify([key1]),
      )

      service.clearKey()

      expect(localStorage.getItem(USER_ENCRYPTION_KEY_HISTORY)).toBeNull()
      expect(localStorage.getItem(LEGACY_ENCRYPTION_KEY_HISTORY)).toBeNull()
      expect(service.getAllKeys()).toEqual({ primary: null, alternatives: [] })
    })

    it('should support clearing without persisting', async () => {
      const key = KEY_STRING
      await service.setKey(key)
      service.addDecryptionKey(ALTERNATIVE_KEY)
      await service.setKey(REPLACEMENT_KEY, { persist: false })

      service.clearKey({ persist: false })

      expect(localStorage.getItem(USER_ENCRYPTION_KEY)).toBe(key)
      expect(service.getAllKeys()).toEqual({ primary: null, alternatives: [] })
      expect(service.getKeyBytesOrThrow()).toEqual(KEY_BYTES)
      expect(
        JSON.parse(localStorage.getItem(USER_ENCRYPTION_KEY_HISTORY)!),
      ).toEqual([ALTERNATIVE_KEY])
    })
  })

  describe('initialize', () => {
    it('should return null when no key exists', async () => {
      const dispatch = vi.spyOn(window, 'dispatchEvent')
      const generate = vi.spyOn(service, 'generateKey')
      const result = await service.initialize()
      expect(result).toBeNull()
      expect(service.getAllKeys()).toEqual({ primary: null, alternatives: [] })
      expect(localStorage.length).toBe(0)
      expect(generate).not.toHaveBeenCalled()
      expect(dispatch).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: ENCRYPTION_KEY_CHANGED_EVENT }),
      )
    })

    it.each([
      [USER_ENCRYPTION_KEY, USER_ENCRYPTION_KEY_HISTORY],
      [LEGACY_ENCRYPTION_KEY, LEGACY_ENCRYPTION_KEY_HISTORY],
    ])(
      'should restore key and history from %s',
      async (primaryStorage, historyStorage) => {
        const key = KEY_STRING
        localStorage.setItem(primaryStorage, key)
        localStorage.setItem(historyStorage, JSON.stringify([ALTERNATIVE_KEY]))

        const newService = new EncryptionService()
        const restoredKey = await newService.initialize()

        expect(restoredKey).toBe(key)
        expect(newService.getAllKeys()).toEqual({
          primary: key,
          alternatives: [ALTERNATIVE_KEY],
        })
        expect(newService.getKeyBytesOrThrow()).toEqual(KEY_BYTES)
        expect(localStorage.getItem(USER_ENCRYPTION_KEY)).toBe(key)
      },
    )
  })

  describe('addDecryptionKey', () => {
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
      expect(service.getAllKeys()).toEqual({
        primary: primaryKey,
        alternatives: [fallbackKey],
      })
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
    it('drops every fallback key from memory and persists the empty history', async () => {
      const primaryKey = await service.generateKey()
      await service.setKey(primaryKey)
      service.addDecryptionKey(await service.generateKey())
      service.addDecryptionKey(await service.generateKey())
      expect(service.getFallbackKeyCount()).toBe(2)
      const primaryBytes = service.getKeyBytesOrThrow()

      service.clearFallbackKeys()

      expect(service.getFallbackKeyCount()).toBe(0)
      const stored = localStorage.getItem(USER_ENCRYPTION_KEY_HISTORY)
      expect(stored).toBe('[]')
      service.clearFallbackKeys()
      expect(service.getKey()).toBe(primaryKey)
      expect(service.getKeyBytesOrThrow()).toEqual(primaryBytes)
      expect(service.getAllKeys()).toEqual({
        primary: primaryKey,
        alternatives: [],
      })
      expect(localStorage.getItem(USER_ENCRYPTION_KEY_HISTORY)).toBe('[]')
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

      await service.setAllKeys(primary, [
        alt,
        'bogus_key',
        `key_${'zz'.repeat(32)}`,
        'key_ab',
      ])

      expect(service.getFallbackKeyCount()).toBe(1)
      expect(service.getAllKeys()).toEqual({ primary, alternatives: [alt] })
      expect(
        JSON.parse(localStorage.getItem(USER_ENCRYPTION_KEY_HISTORY)!),
      ).toEqual([alt])
    })

    it('replaceKeyBundle clears the bundle when primary is null', async () => {
      const primary = await service.generateKey()
      await service.setKey(primary)
      service.addDecryptionKey(ALTERNATIVE_KEY)

      await service.replaceKeyBundle(null, [])

      expect(service.getKey()).toBeNull()
      expect(localStorage.getItem(USER_ENCRYPTION_KEY)).toBeNull()
      expect(service.getAllKeys()).toEqual({ primary: null, alternatives: [] })
      expect(() => service.getKeyBytesOrThrow()).toThrow(
        /no encryption key available/,
      )
      expect(localStorage.getItem(USER_ENCRYPTION_KEY_HISTORY)).toBeNull()
    })

    it('replaceKeyBundle swaps primary and updates alternatives', async () => {
      const oldPrimary = await service.generateKey()
      const newPrimary = await service.generateKey()
      const alt = await service.generateKey()

      await service.setKey(oldPrimary)
      service.addDecryptionKey(ALTERNATIVE_KEY)
      await service.replaceKeyBundle(newPrimary, [alt])

      expect(service.getKey()).toBe(newPrimary)
      expect(service.getFallbackKeyCount()).toBe(1)
      expect(service.getAllKeys()).toEqual({
        primary: newPrimary,
        alternatives: [alt],
      })
      expect(localStorage.getItem(LEGACY_ENCRYPTION_KEY)).toBe(newPrimary)
      expect(
        JSON.parse(localStorage.getItem(USER_ENCRYPTION_KEY_HISTORY)!),
      ).toEqual([alt])
    })
  })
})
