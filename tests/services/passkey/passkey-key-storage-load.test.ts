/**
 * passkey-key-storage load + delete + state — enclave-wire contract.
 *
 * The legacy implementation read /api/passkey-credentials/ over HTTP
 * and wrote the entire JSONB array on each save. The new module
 * routes through the enclave's key-current / remove-bundle wire.
 */

import {
  deletePasskeyCredential,
  getPasskeyCredentialState,
  hasPasskeyCredentials,
  loadPasskeyCredentials,
  loadRecoveryCandidates,
} from '@/services/passkey/passkey-key-storage'
import { SyncEnclaveError } from '@/services/sync-enclave/sync-enclave-client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/utils/error-handling', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
}))

const mockKeyCurrent = vi.fn()
const mockRemoveBundle = vi.fn()
const mockGetKey = vi.fn()
const mockFetchLegacy = vi.fn()

vi.mock('@/services/encryption/encryption-service', () => ({
  encryptionService: {
    getKey: (...args: unknown[]) => mockGetKey(...args),
    getKeyBytesOrThrow: () => {
      const key = mockGetKey()
      if (!key) throw new Error('no key')
      return new TextEncoder().encode(key)
    },
  },
}))

vi.mock('@/services/sync-enclave/sync-api', async () => {
  const real = await vi.importActual<
    typeof import('@/services/sync-enclave/sync-api')
  >('@/services/sync-enclave/sync-api')
  return {
    ...real,
    keyCurrent: (...args: unknown[]) => mockKeyCurrent(...args),
    removeBundle: (...args: unknown[]) => mockRemoveBundle(...args),
  }
})

vi.mock('@/services/passkey/legacy-passkey-credentials', () => ({
  fetchLegacyPasskeyCredentials: (...args: unknown[]) =>
    mockFetchLegacy(...args),
}))

describe('passkey-key-storage load + delete (enclave wire)', () => {
  beforeEach(() => {
    mockKeyCurrent.mockReset()
    mockRemoveBundle.mockReset()
    mockGetKey.mockReset().mockReturnValue('key_current')
    mockFetchLegacy.mockReset().mockResolvedValue([])
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('loadPasskeyCredentials', () => {
    it('returns empty when the enclave has no key', async () => {
      mockKeyCurrent.mockResolvedValue({ key_id: null, bundles: {} })
      expect(await loadPasskeyCredentials()).toEqual([])
    })

    it('returns empty on 404 from the enclave probe when legacy is empty', async () => {
      mockKeyCurrent.mockRejectedValue(
        new SyncEnclaveError('not found', 404, undefined),
      )
      mockFetchLegacy.mockResolvedValue([])
      expect(await loadPasskeyCredentials()).toEqual([])
    })

    it('reshapes wire bundles into legacy PasskeyCredentialEntry shape', async () => {
      // 12-byte IV (24 hex chars) and 16-byte ciphertext (32 hex chars)
      // are the smallest realistic shapes; the entry contract is
      // base64, so the reshape must convert from the enclave's hex
      // wire form to match what decryptKeyBundle / use-passkey-backup
      // expect (see passkey-key-storage hexToB64 boundary).
      const ivHex = '000102030405060708090a0b'
      const wrappedHex = '0a'.repeat(16)
      const ivB64 = Buffer.from(ivHex, 'hex').toString('base64')
      const wrappedB64 = Buffer.from(wrappedHex, 'hex').toString('base64')
      mockKeyCurrent.mockResolvedValue({
        key_id: 'abc',
        bundles: {
          'cred-a': {
            credential_id: 'cred-a',
            kek_iv: ivHex,
            encrypted_keys: wrappedHex,
            bundle_version: 3,
            created_at: '2026-05-12T00:00:00.000Z',
          },
        },
      })
      const entries = await loadPasskeyCredentials()
      expect(entries).toHaveLength(1)
      expect(entries[0]).toMatchObject({
        id: 'cred-a',
        iv: ivB64,
        encrypted_keys: wrappedB64,
        sync_version: 3,
        bundle_version: 3,
        version: 1,
        source: 'enclave',
      })
    })

    it('falls back to the legacy passkey-credentials API on 404 from the enclave', async () => {
      mockKeyCurrent.mockRejectedValue(
        new SyncEnclaveError('not found', 404, undefined),
      )
      mockFetchLegacy.mockResolvedValue([
        {
          id: 'legacy-cred',
          encrypted_keys: 'legacy-data',
          iv: 'legacy-iv',
          created_at: '2024-01-01T00:00:00.000Z',
          version: 1,
          sync_version: 7,
        },
      ])

      const entries = await loadPasskeyCredentials()
      expect(entries).toHaveLength(1)
      expect(entries[0]).toMatchObject({
        id: 'legacy-cred',
        iv: 'legacy-iv',
        encrypted_keys: 'legacy-data',
        sync_version: 7,
        source: 'legacy',
      })
      expect(mockFetchLegacy).toHaveBeenCalledOnce()
    })

    it('falls back to legacy credentials when the enclave reports no key', async () => {
      mockKeyCurrent.mockResolvedValue({ key_id: null, bundles: {} })
      mockFetchLegacy.mockResolvedValue([
        {
          id: 'legacy-cred',
          encrypted_keys: 'legacy-data',
          iv: 'legacy-iv',
          created_at: '2024-01-01T00:00:00.000Z',
          version: 1,
          sync_version: 1,
        },
      ])

      const entries = await loadPasskeyCredentials()
      expect(entries).toHaveLength(1)
      expect(entries[0].source).toBe('legacy')
    })

    it('falls back to legacy when the enclave key has no bundles (orphan key)', async () => {
      // The migrate-all bootstrap can stamp a current key before any
      // passkey bundle is written, leaving key_id set with empty
      // bundles. Recovery must still surface the legacy passkey instead
      // of reporting no credentials.
      mockKeyCurrent.mockResolvedValue({ key_id: 'orphan-kid', bundles: {} })
      mockFetchLegacy.mockResolvedValue([
        {
          id: 'legacy-cred',
          encrypted_keys: 'legacy-data',
          iv: 'legacy-iv',
          created_at: '2024-01-01T00:00:00.000Z',
          version: 1,
          sync_version: 1,
        },
      ])

      const entries = await loadPasskeyCredentials()
      expect(entries).toHaveLength(1)
      expect(entries[0].source).toBe('legacy')
      expect(mockFetchLegacy).toHaveBeenCalledOnce()
    })

    it('returns empty when both the enclave and the legacy fallback are empty', async () => {
      mockKeyCurrent.mockResolvedValue({ key_id: null, bundles: {} })
      mockFetchLegacy.mockResolvedValue([])
      expect(await loadPasskeyCredentials()).toEqual([])
    })
  })

  describe('loadRecoveryCandidates', () => {
    it('merges enclave bundles with the legacy credentials (multi-platform)', async () => {
      // The enclave already has a bundle for the first device (cred-a),
      // while this second device only has its own legacy passkey
      // (cred-b). Recovery must offer BOTH so cred-b can authenticate.
      mockKeyCurrent.mockResolvedValue({
        key_id: 'abc',
        bundles: {
          'cred-a': {
            credential_id: 'cred-a',
            kek_iv: '000102030405060708090a0b',
            encrypted_keys: '0a'.repeat(16),
            bundle_version: 1,
          },
        },
      })
      mockFetchLegacy.mockResolvedValue([
        {
          id: 'cred-b',
          encrypted_keys: 'legacy-data',
          iv: 'legacy-iv',
          created_at: '2024-01-01T00:00:00.000Z',
          version: 1,
          sync_version: 1,
        },
      ])

      const entries = await loadRecoveryCandidates()
      const ids = entries.map((e) => e.id).sort()
      expect(ids).toEqual(['cred-a', 'cred-b'])
      expect(entries.find((e) => e.id === 'cred-a')?.source).toBe('enclave')
      expect(entries.find((e) => e.id === 'cred-b')?.source).toBe('legacy')
    })

    it('prefers the enclave entry when an id is in both sources', async () => {
      mockKeyCurrent.mockResolvedValue({
        key_id: 'abc',
        bundles: {
          'cred-a': {
            credential_id: 'cred-a',
            kek_iv: '000102030405060708090a0b',
            encrypted_keys: '0a'.repeat(16),
            bundle_version: 1,
          },
        },
      })
      mockFetchLegacy.mockResolvedValue([
        {
          id: 'cred-a',
          encrypted_keys: 'legacy-data',
          iv: 'legacy-iv',
          created_at: '2024-01-01T00:00:00.000Z',
          version: 1,
          sync_version: 1,
        },
      ])

      const entries = await loadRecoveryCandidates()
      expect(entries).toHaveLength(1)
      expect(entries[0].source).toBe('enclave')
    })

    it('returns only legacy entries when no enclave key exists', async () => {
      mockKeyCurrent.mockResolvedValue({ key_id: null, bundles: {} })
      mockFetchLegacy.mockResolvedValue([
        {
          id: 'cred-b',
          encrypted_keys: 'legacy-data',
          iv: 'legacy-iv',
          created_at: '2024-01-01T00:00:00.000Z',
          version: 1,
          sync_version: 1,
        },
      ])

      const entries = await loadRecoveryCandidates()
      expect(entries).toHaveLength(1)
      expect(entries[0].source).toBe('legacy')
    })
  })

  describe('deletePasskeyCredential', () => {
    it('calls removeBundle when the credential is registered', async () => {
      mockKeyCurrent.mockResolvedValue({
        key_id: 'abc',
        bundles: {
          'cred-a': {
            credential_id: 'cred-a',
            kek_iv: 'iv',
            encrypted_keys: 'data',
          },
        },
      })
      mockRemoveBundle.mockResolvedValue({ ok: true })

      const ok = await deletePasskeyCredential('cred-a')
      expect(ok).toBe(true)
      expect(mockRemoveBundle).toHaveBeenCalledOnce()
      const arg = mockRemoveBundle.mock.calls[0][0]
      expect(arg.keyId).toBe('abc')
      expect(arg.keyB64).toBe('a2V5X2N1cnJlbnQ=')
      expect(arg.credentialId).toBe('cred-a')
      expect(typeof arg.idempotencyKey).toBe('string')
    })

    it('no-ops when the credential is already gone', async () => {
      mockKeyCurrent.mockResolvedValue({ key_id: 'abc', bundles: {} })
      const ok = await deletePasskeyCredential('cred-missing')
      expect(ok).toBe(true)
      expect(mockRemoveBundle).not.toHaveBeenCalled()
    })

    it('no-ops when the enclave has no key', async () => {
      mockKeyCurrent.mockResolvedValue({ key_id: null, bundles: {} })
      const ok = await deletePasskeyCredential('cred-a')
      expect(ok).toBe(true)
      expect(mockRemoveBundle).not.toHaveBeenCalled()
    })

    it('returns false when the enclave call throws', async () => {
      mockKeyCurrent.mockRejectedValue(new Error('network'))
      expect(await deletePasskeyCredential('cred-a')).toBe(false)
    })
  })

  describe('getPasskeyCredentialState / hasPasskeyCredentials', () => {
    it('reports empty when the enclave has no key', async () => {
      mockKeyCurrent.mockResolvedValue({ key_id: null, bundles: {} })
      expect(await getPasskeyCredentialState()).toBe('empty')
      expect(await hasPasskeyCredentials()).toBe(false)
    })

    it('reports exists when at least one bundle is registered', async () => {
      mockKeyCurrent.mockResolvedValue({
        key_id: 'abc',
        bundles: {
          'cred-a': {
            credential_id: 'cred-a',
            kek_iv: '000102030405060708090a0b',
            encrypted_keys: '0a'.repeat(16),
          },
        },
      })
      expect(await getPasskeyCredentialState()).toBe('exists')
      expect(await hasPasskeyCredentials()).toBe(true)
    })

    it('reports exists via legacy fallback when the key is an orphan (no bundles)', async () => {
      mockKeyCurrent.mockResolvedValue({ key_id: 'orphan-kid', bundles: {} })
      mockFetchLegacy.mockResolvedValue([
        {
          id: 'legacy-cred',
          encrypted_keys: 'legacy-data',
          iv: 'legacy-iv',
          created_at: '2024-01-01T00:00:00.000Z',
          version: 1,
          sync_version: 1,
        },
      ])
      expect(await getPasskeyCredentialState()).toBe('exists')
      expect(await hasPasskeyCredentials()).toBe(true)
    })

    it('reports unknown when the enclave probe fails', async () => {
      mockKeyCurrent.mockRejectedValue(new Error('boom'))
      expect(await getPasskeyCredentialState()).toBe('unknown')
    })
  })
})
