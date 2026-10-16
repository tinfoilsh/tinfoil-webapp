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
import { beforeEach, describe, expect, it, vi } from 'vitest'

const KEY_BYTES = new Uint8Array(32).fill(0x11)
const KEY_STRING = `key_${'ar'.repeat(32)}`
const ALTERNATIVE_KEY = `key_${'as'.repeat(32)}`
const REPLACEMENT_KEY = `key_${'at'.repeat(32)}`

describe('EncryptionService', () => {
  let service: EncryptionService

  beforeEach(() => {
    service = new EncryptionService()
  })

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
      await expect(service.setKey(`kex_${'ar'.repeat(32)}`)).rejects.toThrow(
        'Key must start with "key_" prefix',
      )
    })

    it.each([
      ['key_INVALID', /only contain lowercase letters and numbers/],
      ['key_abc!def', /only contain lowercase letters and numbers/],
      ['key_abc', /length must be even/],
      // 8 valid chars decode to 4 bytes — far short of the 32 a CEK
      // needs. Without the byte-length guard this would persist and
      // break every downstream crypto/sync operation.
      ['key_abcdefgh', /must decode to 32 bytes/],
    ])('should reject a malformed key: %s', async (key, message) => {
      await expect(service.setKey(key)).rejects.toThrow(message)
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
      await service.setAllKeys(key, [ALTERNATIVE_KEY])
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

  describe('setAllKeys / replaceKeyBundle', () => {
    it('setAllKeys skips invalid alternatives silently', async () => {
      const primary = await service.generateKey()
      const alt = await service.generateKey()

      await service.setAllKeys(primary, [
        alt,
        'bogus_key',
        `key_${'zz'.repeat(32)}`,
        'key_ab',
      ])

      expect(service.getKey()).toBe(primary)
      expect(service.getAllKeys()).toEqual({ primary, alternatives: [alt] })
      expect(
        JSON.parse(localStorage.getItem(USER_ENCRYPTION_KEY_HISTORY)!),
      ).toEqual([alt])
    })

    it('replaceKeyBundle clears the bundle when primary is null', async () => {
      const primary = await service.generateKey()
      await service.setAllKeys(primary, [ALTERNATIVE_KEY])

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

      await service.setAllKeys(oldPrimary, [ALTERNATIVE_KEY])
      await service.replaceKeyBundle(newPrimary, [alt])

      expect(service.getKey()).toBe(newPrimary)
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
