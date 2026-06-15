import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockGetKey = vi.fn<() => string | null>()
const mockGetStoredAlternatives = vi.fn<() => string[]>()
const mockGetKeyBytesOrThrow = vi.fn<() => Uint8Array>()
const mockGetAlternativeKeyBytes = vi.fn<(k: string) => Uint8Array | null>()

vi.mock('@/services/encryption/encryption-service', () => ({
  encryptionService: {
    getKey: () => mockGetKey(),
    getStoredAlternatives: () => mockGetStoredAlternatives(),
    getKeyBytesOrThrow: () => mockGetKeyBytesOrThrow(),
    getAlternativeKeyBytes: (k: string) => mockGetAlternativeKeyBytes(k),
  },
}))

// Map each candidate CEK to a deterministic id by its fill byte so the
// fingerprint test exercises the helper's sorting/dedup/join logic
// without depending on the crypto-backed key-id derivation.
vi.mock('@/services/sync-enclave/key-bundle', () => ({
  deriveKeyIdHex: async (cek: Uint8Array) =>
    `id_${cek[0].toString(16).padStart(2, '0')}`,
}))

import {
  migrationKeySetFingerprint,
  migrationKeys,
  pullKey,
  requirePrimaryKeyB64,
} from '@/services/cloud/cek-encoding'

describe('cek-encoding', () => {
  beforeEach(() => {
    mockGetKey.mockReset()
    mockGetStoredAlternatives.mockReset()
    mockGetStoredAlternatives.mockReturnValue([])
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
      mockGetKey.mockReturnValue('key_primary')
      mockGetStoredAlternatives.mockReturnValue([
        'key_alt1',
        'key_alt2',
        'key_primary',
      ])
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
      mockGetKey.mockReturnValue('key_primary')
      mockGetStoredAlternatives.mockReturnValue(['key_bad'])
      mockGetAlternativeKeyBytes.mockImplementation((k) =>
        k === 'key_primary' ? new Uint8Array(32) : null,
      )
      const keys = migrationKeys()
      expect(keys).toHaveLength(1)
    })

    it('returns an empty array when no primary key is loaded', () => {
      mockGetKey.mockReturnValue(null)
      mockGetStoredAlternatives.mockReturnValue([])
      const keys = migrationKeys()
      expect(keys).toEqual([])
    })

    it('never emits alternatives without a primary at keys[0]', () => {
      mockGetKey.mockReturnValue(null)
      mockGetStoredAlternatives.mockReturnValue(['key_alt1'])
      mockGetAlternativeKeyBytes.mockReturnValue(new Uint8Array(32))
      const keys = migrationKeys()
      expect(keys).toEqual([])
    })

    it('returns an empty array when the primary bytes are unreadable', () => {
      mockGetKey.mockReturnValue('key_primary')
      mockGetStoredAlternatives.mockReturnValue(['key_alt1'])
      mockGetAlternativeKeyBytes.mockImplementation((k) =>
        k === 'key_alt1' ? new Uint8Array(32) : null,
      )
      const keys = migrationKeys()
      expect(keys).toEqual([])
    })

    it('sources primary bytes from persisted storage, not the in-memory decoder', () => {
      mockGetKey.mockReturnValue('key_primary')
      mockGetStoredAlternatives.mockReturnValue([])
      mockGetAlternativeKeyBytes.mockImplementation((k) =>
        k === 'key_primary' ? new Uint8Array(32).fill(0x42) : null,
      )
      const keys = migrationKeys()
      expect(keys).toHaveLength(1)
      expect(atob(keys[0].key).charCodeAt(0)).toBe(0x42)
      expect(mockGetKeyBytesOrThrow).not.toHaveBeenCalled()
    })
  })

  describe('migrationKeySetFingerprint', () => {
    const bytesByKey: Record<string, Uint8Array> = {
      key_primary: new Uint8Array(32).fill(0x10),
      key_alt1: new Uint8Array(32).fill(0x20),
      key_alt2: new Uint8Array(32).fill(0x30),
    }

    beforeEach(() => {
      mockGetAlternativeKeyBytes.mockImplementation(
        (k) => bytesByKey[k] ?? null,
      )
    })

    it('fingerprints the sorted ids of the primary and unique alternatives', async () => {
      mockGetKey.mockReturnValue('key_primary')
      mockGetStoredAlternatives.mockReturnValue([
        'key_alt2',
        'key_alt1',
        'key_primary',
      ])
      const fp = await migrationKeySetFingerprint()
      expect(fp).toBe('id_10,id_20,id_30')
    })

    it('is order-independent: the same key set yields the same fingerprint', async () => {
      mockGetKey.mockReturnValue('key_primary')
      mockGetStoredAlternatives.mockReturnValue(['key_alt1', 'key_alt2'])
      const a = await migrationKeySetFingerprint()
      mockGetStoredAlternatives.mockReturnValue(['key_alt2', 'key_alt1'])
      const b = await migrationKeySetFingerprint()
      expect(a).toBe(b)
    })

    it('changes when a new key joins the candidate set', async () => {
      mockGetKey.mockReturnValue('key_primary')
      mockGetStoredAlternatives.mockReturnValue(['key_alt1'])
      const before = await migrationKeySetFingerprint()
      mockGetStoredAlternatives.mockReturnValue(['key_alt1', 'key_alt2'])
      const after = await migrationKeySetFingerprint()
      expect(after).not.toBe(before)
    })

    it('returns null when no primary key is loaded', async () => {
      mockGetKey.mockReturnValue(null)
      mockGetStoredAlternatives.mockReturnValue([])
      expect(await migrationKeySetFingerprint()).toBeNull()
    })

    it('skips keys whose bytes are unreadable', async () => {
      mockGetKey.mockReturnValue('key_primary')
      mockGetStoredAlternatives.mockReturnValue(['key_missing'])
      const fp = await migrationKeySetFingerprint()
      expect(fp).toBe('id_10')
    })
  })
})
