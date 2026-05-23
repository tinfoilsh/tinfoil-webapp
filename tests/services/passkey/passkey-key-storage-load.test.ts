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
} from '@/services/passkey/passkey-key-storage'
import { SyncEnclaveError } from '@/services/sync-enclave/sync-enclave-client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/utils/error-handling', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
}))

const mockKeyCurrent = vi.fn()
const mockRemoveBundle = vi.fn()

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

describe('passkey-key-storage load + delete (enclave wire)', () => {
  beforeEach(() => {
    mockKeyCurrent.mockReset()
    mockRemoveBundle.mockReset()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('loadPasskeyCredentials', () => {
    it('returns empty when the enclave has no key', async () => {
      mockKeyCurrent.mockResolvedValue({ key_id: null, bundles: {} })
      expect(await loadPasskeyCredentials()).toEqual([])
    })

    it('returns empty on 404 from the enclave probe', async () => {
      mockKeyCurrent.mockRejectedValue(
        new SyncEnclaveError('not found', 404, undefined),
      )
      expect(await loadPasskeyCredentials()).toEqual([])
    })

    it('reshapes wire bundles into legacy PasskeyCredentialEntry shape', async () => {
      mockKeyCurrent.mockResolvedValue({
        key_id: 'abc',
        bundles: {
          'cred-a': {
            credential_id: 'cred-a',
            kek_iv: 'iv-base64',
            encrypted_keys: 'data-base64',
            bundle_version: 3,
            created_at: '2026-05-12T00:00:00.000Z',
          },
        },
      })
      const entries = await loadPasskeyCredentials()
      expect(entries).toHaveLength(1)
      expect(entries[0]).toMatchObject({
        id: 'cred-a',
        iv: 'iv-base64',
        encrypted_keys: 'data-base64',
        sync_version: 3,
        bundle_version: 3,
        version: 1,
      })
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
      expect(arg.credentialId).toBe('cred-a')
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
            kek_iv: 'iv',
            encrypted_keys: 'data',
          },
        },
      })
      expect(await getPasskeyCredentialState()).toBe('exists')
      expect(await hasPasskeyCredentials()).toBe(true)
    })

    it('reports unknown when the enclave probe fails', async () => {
      mockKeyCurrent.mockRejectedValue(new Error('boom'))
      expect(await getPasskeyCredentialState()).toBe('unknown')
    })
  })
})
