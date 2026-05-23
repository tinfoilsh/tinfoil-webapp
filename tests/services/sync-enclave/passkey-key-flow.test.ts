import {
  cekBytesToHex,
  deriveKeyIdHex,
  wrapCekForCredential,
} from '@/services/sync-enclave/key-bundle'
import * as flow from '@/services/sync-enclave/passkey-key-flow'
import { SyncEnclaveError } from '@/services/sync-enclave/sync-enclave-client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/utils/error-handling', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
}))

const mockCreatePrfPasskey = vi.fn()
const mockAuthenticatePrfPasskey = vi.fn()
const mockDeriveKeyEncryptionKey = vi.fn()

vi.mock('@/services/passkey/passkey-service', () => ({
  createPrfPasskey: (...args: unknown[]) => mockCreatePrfPasskey(...args),
  authenticatePrfPasskey: (...args: unknown[]) =>
    mockAuthenticatePrfPasskey(...args),
  deriveKeyEncryptionKey: (...args: unknown[]) =>
    mockDeriveKeyEncryptionKey(...args),
}))

const mockRegisterKey = vi.fn()
const mockAddBundle = vi.fn()
const mockKeyCurrent = vi.fn()

vi.mock('@/services/sync-enclave/sync-api', async () => {
  const real = await vi.importActual<
    typeof import('@/services/sync-enclave/sync-api')
  >('@/services/sync-enclave/sync-api')
  return {
    ...real,
    registerKey: (...args: unknown[]) => mockRegisterKey(...args),
    addBundle: (...args: unknown[]) => mockAddBundle(...args),
    keyCurrent: (...args: unknown[]) => mockKeyCurrent(...args),
  }
})

async function importKek(seed: number): Promise<CryptoKey> {
  const raw = new Uint8Array(32).fill(seed)
  return crypto.subtle.importKey(
    'raw',
    raw as unknown as BufferSource,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt'],
  )
}

const USER = {
  userId: 'user-1',
  userName: 'u@example.com',
  displayName: 'Test User',
}

describe('passkey-key-flow', () => {
  beforeEach(() => {
    mockCreatePrfPasskey.mockReset()
    mockAuthenticatePrfPasskey.mockReset()
    mockDeriveKeyEncryptionKey.mockReset()
    mockRegisterKey.mockReset()
    mockAddBundle.mockReset()
    mockKeyCurrent.mockReset()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('registerNewKeyWithPasskey', () => {
    it('creates a fresh CEK, wraps it, and registers with the enclave', async () => {
      mockCreatePrfPasskey.mockResolvedValue({
        credentialId: 'cred-new',
        prfOutput: new Uint8Array(32).fill(0x77).buffer,
      })
      mockDeriveKeyEncryptionKey.mockResolvedValue(await importKek(0xa1))
      mockRegisterKey.mockResolvedValue({ ok: true, key_id: 'kid' })

      const result = await flow.registerNewKeyWithPasskey({ user: USER })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.credentialId).toBe('cred-new')
      expect(result.keyIdHex).toMatch(/^[0-9a-f]{32}$/)
      expect(result.cekHex).toMatch(/^[0-9a-f]{64}$/)

      expect(mockRegisterKey).toHaveBeenCalledOnce()
      const arg = mockRegisterKey.mock.calls[0][0]
      expect(arg.ifMatch).toBe('*')
      expect(arg.createdVia).toBe('passkey')
      expect(arg.initialBundle.credentialId).toBe('cred-new')
      expect(arg.initialBundle.encryptedKeysHex).toMatch(/^[0-9a-f]+$/)
    })

    it('returns user_cancelled when the WebAuthn prompt is cancelled', async () => {
      mockCreatePrfPasskey.mockResolvedValue(null)
      const result = await flow.registerNewKeyWithPasskey({ user: USER })
      expect(result).toEqual({ ok: false, reason: 'user_cancelled' })
      expect(mockRegisterKey).not.toHaveBeenCalled()
    })

    it('maps PrfNotSupportedError to prf_unsupported', async () => {
      const err = Object.assign(new Error('no prf'), {
        name: 'PrfNotSupportedError',
      })
      mockCreatePrfPasskey.mockRejectedValue(err)
      const result = await flow.registerNewKeyWithPasskey({ user: USER })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.reason).toBe('prf_unsupported')
    })

    it('maps PasskeyTimeoutError to passkey_timeout', async () => {
      const err = Object.assign(new Error('timed out'), {
        name: 'PasskeyTimeoutError',
      })
      mockCreatePrfPasskey.mockRejectedValue(err)
      const result = await flow.registerNewKeyWithPasskey({ user: USER })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.reason).toBe('passkey_timeout')
    })

    it('maps a 409 from the enclave to remote_key_exists', async () => {
      mockCreatePrfPasskey.mockResolvedValue({
        credentialId: 'cred-x',
        prfOutput: new Uint8Array(32).buffer,
      })
      mockDeriveKeyEncryptionKey.mockResolvedValue(await importKek(0xa2))
      mockRegisterKey.mockRejectedValue(
        new SyncEnclaveError('exists', 409, 'EXISTING_DATA_UNDER_OTHER_KEY'),
      )
      const result = await flow.registerNewKeyWithPasskey({ user: USER })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.reason).toBe('remote_key_exists')
    })

    it('maps a 500 from the enclave to enclave_unavailable', async () => {
      mockCreatePrfPasskey.mockResolvedValue({
        credentialId: 'cred-x',
        prfOutput: new Uint8Array(32).buffer,
      })
      mockDeriveKeyEncryptionKey.mockResolvedValue(await importKek(0xa2))
      mockRegisterKey.mockRejectedValue(
        new SyncEnclaveError('boom', 503, 'BACKEND_DOWN'),
      )
      const result = await flow.registerNewKeyWithPasskey({ user: USER })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.reason).toBe('enclave_unavailable')
    })
  })

  describe('unlockWithPasskey', () => {
    it('round-trips a candidate bundle into a CEK', async () => {
      const cek = crypto.getRandomValues(new Uint8Array(32))
      const cekHex = cekBytesToHex(cek)
      const expectedKid = await deriveKeyIdHex(cek)
      const kek = await importKek(0xb1)
      const bundle = await wrapCekForCredential({
        credentialId: 'cred-r',
        kek,
        cek,
      })
      mockAuthenticatePrfPasskey.mockResolvedValue({
        credentialId: 'cred-r',
        prfOutput: new Uint8Array(32).buffer,
      })
      mockDeriveKeyEncryptionKey.mockResolvedValue(kek)

      const result = await flow.unlockWithPasskey({ candidates: [bundle] })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.cekHex).toBe(cekHex)
      expect(result.keyIdHex).toBe(expectedKid)
      expect(result.credentialId).toBe('cred-r')
    })

    it('returns no_remote_bundle when the candidate list is empty', async () => {
      const result = await flow.unlockWithPasskey({ candidates: [] })
      expect(result).toEqual({ ok: false, reason: 'no_remote_bundle' })
      expect(mockAuthenticatePrfPasskey).not.toHaveBeenCalled()
    })

    it('returns bundle_decrypt_failed on KEK mismatch', async () => {
      const cek = crypto.getRandomValues(new Uint8Array(32))
      const wrongKek = await importKek(0xc1)
      const correctKek = await importKek(0xc2)
      const bundle = await wrapCekForCredential({
        credentialId: 'cred-mismatch',
        kek: correctKek,
        cek,
      })
      mockAuthenticatePrfPasskey.mockResolvedValue({
        credentialId: 'cred-mismatch',
        prfOutput: new Uint8Array(32).buffer,
      })
      mockDeriveKeyEncryptionKey.mockResolvedValue(wrongKek)
      const result = await flow.unlockWithPasskey({ candidates: [bundle] })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.reason).toBe('bundle_decrypt_failed')
    })
  })

  describe('addBundleForCurrentKey', () => {
    it('wraps the current CEK under a new passkey and posts to the enclave', async () => {
      const cek = crypto.getRandomValues(new Uint8Array(32))
      mockCreatePrfPasskey.mockResolvedValue({
        credentialId: 'cred-newdev',
        prfOutput: new Uint8Array(32).buffer,
      })
      mockDeriveKeyEncryptionKey.mockResolvedValue(await importKek(0xd1))
      mockAddBundle.mockResolvedValue({ ok: true })
      const result = await flow.addBundleForCurrentKey({
        cekHex: cekBytesToHex(cek),
        keyIdHex: 'kid',
        user: USER,
      })
      expect(result.ok).toBe(true)
      expect(mockAddBundle).toHaveBeenCalledOnce()
      const arg = mockAddBundle.mock.calls[0][0]
      expect(arg.keyId).toBe('kid')
      expect(arg.credentialId).toBe('cred-newdev')
    })
  })

  describe('fetchServerKeyState', () => {
    it('returns empty when the enclave has no key for the user', async () => {
      mockKeyCurrent.mockResolvedValue({ key_id: null, bundles: {} })
      const state = await flow.fetchServerKeyState()
      expect(state).toEqual({ status: 'empty' })
    })

    it('reshapes wire bundles into BundleBody candidates', async () => {
      mockKeyCurrent.mockResolvedValue({
        key_id: 'aabb',
        bundles: {
          'cred-a': {
            credential_id: 'cred-a',
            kek_iv: '000102',
            encrypted_keys: '030405',
            bundle_version: 1,
          },
        },
      })
      const state = await flow.fetchServerKeyState()
      expect(state.status).toBe('exists')
      if (state.status !== 'exists') return
      expect(state.keyIdHex).toBe('aabb')
      expect(state.candidates).toHaveLength(1)
      expect(state.candidates[0].credentialId).toBe('cred-a')
      expect(state.candidates[0].kekIvHex).toBe('000102')
      expect(state.candidates[0].wrappedKeyHex).toBe('030405')
    })
  })

  describe('unlockFromServer', () => {
    it('returns no_remote_key when the server has no key', async () => {
      mockKeyCurrent.mockResolvedValue({ key_id: null, bundles: {} })
      const result = await flow.unlockFromServer()
      expect(result).toEqual({ ok: false, reason: 'no_remote_key' })
      expect(mockAuthenticatePrfPasskey).not.toHaveBeenCalled()
    })

    it('rejects when the unwrapped CEK derives a different key_id', async () => {
      const cek = crypto.getRandomValues(new Uint8Array(32))
      const kek = await importKek(0xe1)
      const bundle = await wrapCekForCredential({
        credentialId: 'cred-mismatch',
        kek,
        cek,
      })
      mockKeyCurrent.mockResolvedValue({
        key_id: 'deadbeef'.repeat(4),
        bundles: {
          'cred-mismatch': {
            credential_id: 'cred-mismatch',
            kek_iv: bundle.kekIvHex,
            encrypted_keys: bundle.wrappedKeyHex,
          },
        },
      })
      mockAuthenticatePrfPasskey.mockResolvedValue({
        credentialId: 'cred-mismatch',
        prfOutput: new Uint8Array(32).buffer,
      })
      mockDeriveKeyEncryptionKey.mockResolvedValue(kek)
      const result = await flow.unlockFromServer()
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.reason).toBe('key_id_mismatch')
    })
  })
})
