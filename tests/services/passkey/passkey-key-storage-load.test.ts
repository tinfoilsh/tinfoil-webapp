/**
 * passkey-key-storage load + delete + state — enclave-wire contract.
 */

import { encryptionService } from '@/services/encryption/encryption-service'
import {
  deletePasskeyCredential,
  getPasskeyCredentialState,
  loadPasskeyCredentials,
} from '@/services/passkey/passkey-key-storage'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/utils/error-handling', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
}))

const mockKeyCurrent = vi.fn()
const mockRemoveBundle = vi.fn()
const PRIMARY_KEY = `key_${'ar'.repeat(32)}`
const PRIMARY_KEY_B64 = 'ERERERERERERERERERERERERERERERERERERERERERE='

vi.mock('@/services/harness/keys', async () => {
  const real = await vi.importActual<typeof import('@/services/harness/keys')>(
    '@/services/harness/keys',
  )
  return {
    ...real,
    keyCurrent: (...args: unknown[]) => mockKeyCurrent(...args),
    removeBundle: (...args: unknown[]) => mockRemoveBundle(...args),
  }
})

describe('passkey-key-storage load + delete (enclave wire)', () => {
  beforeEach(async () => {
    mockKeyCurrent.mockReset()
    mockRemoveBundle
      .mockReset()
      .mockRejectedValue(new Error('Unexpected bundle removal'))
    encryptionService.clearKey()
    await encryptionService.setKey(PRIMARY_KEY)
  })

  describe('loadPasskeyCredentials', () => {
    it('reshapes wire bundles into the PasskeyCredentialEntry shape', async () => {
      // 12-byte IV (24 hex chars) and 16-byte ciphertext (32 hex chars)
      // are the smallest realistic shapes; the entry contract is
      // base64, so the reshape must convert from the enclave's hex
      // wire form to match what use-passkey-backup expects (see
      // passkey-key-storage hexToB64 boundary).
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
      expect(entries).toEqual([
        {
          id: 'cred-a',
          iv: ivB64,
          encrypted_keys: wrappedB64,
          created_at: '2026-05-12T00:00:00.000Z',
          sync_version: 3,
          bundle_version: 3,
        },
      ])
    })

    it('aborts hanging key-current discovery without accumulating requests', async () => {
      let activeRequests = 0
      mockKeyCurrent.mockImplementation((signal?: AbortSignal) => {
        activeRequests++
        return new Promise((_, reject) => {
          const onAbort = () => {
            activeRequests--
            reject(signal?.reason)
          }
          signal?.addEventListener('abort', onAbort, { once: true })
        })
      })

      for (let attempt = 0; attempt < 2; attempt++) {
        const controller = new AbortController()
        const discovery = loadPasskeyCredentials({
          signal: controller.signal,
        })
        expect(activeRequests).toBe(1)
        controller.abort()
        await expect(discovery).rejects.toMatchObject({ name: 'AbortError' })
        expect(activeRequests).toBe(0)
      }
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
      expect(arg.keyB64).toBe(PRIMARY_KEY_B64)
      expect(arg.credentialId).toBe('cred-a')
      expect(arg.idempotencyKey).toMatch(/^[0-9a-f]{32}$/)
    })

    it.each(['absent', 'keyless'] as const)(
      'reports success without removing anything when the bundle is %s',
      async (state) => {
        mockKeyCurrent.mockResolvedValue(
          state === 'keyless'
            ? { key_id: null, bundles: {} }
            : {
                key_id: 'abc',
                bundles: {
                  'cred-b': {
                    credential_id: 'cred-b',
                    kek_iv: 'iv',
                    encrypted_keys: 'data',
                  },
                },
              },
        )
        const ok = await deletePasskeyCredential('cred-a')
        expect(ok).toBe(true)
        expect(mockRemoveBundle).not.toHaveBeenCalled()
      },
    )
  })

  describe('getPasskeyCredentialState / hasPasskeyCredentials', () => {
    it('reports empty when the enclave has no key', async () => {
      mockKeyCurrent.mockResolvedValue({ key_id: null, bundles: {} })
      expect(await getPasskeyCredentialState()).toBe('empty')
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
    })

    it('reports unknown when the enclave probe fails', async () => {
      mockKeyCurrent.mockRejectedValue(new Error('boom'))
      expect(await getPasskeyCredentialState()).toBe('unknown')
    })
  })
})
