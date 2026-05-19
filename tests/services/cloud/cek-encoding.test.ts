import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockGetKey = vi.fn<() => string | null>()
const mockGetAllKeys =
  vi.fn<() => { primary: string | null; alternatives: string[] }>()
const mockGetKeyBytesOrThrow = vi.fn<() => Uint8Array>()
const mockGetAlternativeKeyBytes = vi.fn<(k: string) => Uint8Array | null>()

vi.mock('@/services/encryption/encryption-service', () => ({
  encryptionService: {
    getKey: () => mockGetKey(),
    getAllKeys: () => mockGetAllKeys(),
    getKeyBytesOrThrow: () => mockGetKeyBytesOrThrow(),
    getAlternativeKeyBytes: (k: string) => mockGetAlternativeKeyBytes(k),
  },
}))

import {
  migrationKeys,
  pullKey,
  requirePrimaryKeyB64,
} from '@/services/cloud/cek-encoding'

describe('cek-encoding', () => {
  beforeEach(() => {
    mockGetKey.mockReset()
    mockGetAllKeys.mockReset()
    mockGetKeyBytesOrThrow.mockReset()
    mockGetAlternativeKeyBytes.mockReset()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('requirePrimaryKeyB64', () => {
    it('encodes the CEK bytes via the encryption-service decoder', () => {
      const bytes = new Uint8Array(32).fill(1)
      mockGetKeyBytesOrThrow.mockReturnValue(bytes)
      const b64 = requirePrimaryKeyB64()
      // 32 bytes of 0x01 → 44-char base64 ending with =
      expect(b64).toMatch(/^[A-Za-z0-9+/]+=*$/)
      // Round-trip back through atob to confirm we did not just
      // forward the raw key string.
      const round = atob(b64)
      expect(round.length).toBe(32)
      expect(round.charCodeAt(0)).toBe(1)
    })

    it('propagates the underlying decoder error when no key is loaded', () => {
      mockGetKeyBytesOrThrow.mockImplementation(() => {
        throw new Error('no key')
      })
      expect(() => requirePrimaryKeyB64()).toThrow(/no key/)
    })
  })

  describe('pullKey', () => {
    it('returns only the primary CEK so steady-state reads never ship history', () => {
      mockGetKeyBytesOrThrow.mockReturnValue(new Uint8Array(32).fill(0x10))
      const keys = pullKey()
      expect(keys).toHaveLength(1)
      expect(atob(keys[0].key).charCodeAt(0)).toBe(0x10)
    })

    it('propagates errors from the encryption service', () => {
      mockGetKeyBytesOrThrow.mockImplementation(() => {
        throw new Error('no key')
      })
      expect(() => pullKey()).toThrow(/no key/)
    })
  })

  describe('migrationKeys', () => {
    it('emits primary first, then unique alternatives, each base64-encoded', () => {
      mockGetAllKeys.mockReturnValue({
        primary: 'key_primary',
        alternatives: ['key_alt1', 'key_alt2', 'key_primary'],
      })
      mockGetAlternativeKeyBytes.mockImplementation((k) => {
        const map: Record<string, Uint8Array> = {
          key_primary: new Uint8Array(32).fill(0x10),
          key_alt1: new Uint8Array(32).fill(0x20),
          key_alt2: new Uint8Array(32).fill(0x30),
        }
        return map[k] ?? null
      })
      const keys = migrationKeys()
      expect(keys).toHaveLength(3)
      const primaryDecoded = atob(keys[0].key)
      expect(primaryDecoded.charCodeAt(0)).toBe(0x10)
      expect(atob(keys[1].key).charCodeAt(0)).toBe(0x20)
      expect(atob(keys[2].key).charCodeAt(0)).toBe(0x30)
    })

    it('drops keys that fail the format decoder', () => {
      mockGetAllKeys.mockReturnValue({
        primary: 'key_primary',
        alternatives: ['key_bad'],
      })
      mockGetAlternativeKeyBytes.mockImplementation((k) =>
        k === 'key_primary' ? new Uint8Array(32) : null,
      )
      const keys = migrationKeys()
      expect(keys).toHaveLength(1)
    })

    it('returns an empty array when no primary key is loaded', () => {
      mockGetAllKeys.mockReturnValue({ primary: null, alternatives: [] })
      const keys = migrationKeys()
      expect(keys).toEqual([])
    })
  })
})
