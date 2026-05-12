import {
  cekBytesToHex,
  deriveKeyIdHex,
  wrapCekForCredential,
} from '@/services/sync-enclave/key-bundle'
import * as flow from '@/services/sync-enclave/passkey-key-flow'
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

const mockGetCurrentKey = vi.fn()
const mockRegisterKey = vi.fn()
const mockAddBundle = vi.fn()

vi.mock('@/services/sync-enclave/sync-api', () => ({
  getCurrentKey: (...args: unknown[]) => mockGetCurrentKey(...args),
  registerKey: (...args: unknown[]) => mockRegisterKey(...args),
  addBundle: (...args: unknown[]) => mockAddBundle(...args),
}))

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
    mockGetCurrentKey.mockReset()
    mockRegisterKey.mockReset()
    mockAddBundle.mockReset()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('registerNewKeyWithPasskey', () => {
    it('creates a fresh CEK, wraps it, and registers with the enclave', async () => {
      const prfOutput = new Uint8Array(32).fill(0x77).buffer
      mockCreatePrfPasskey.mockResolvedValue({
        credentialId: 'cred-new',
        prfOutput,
      })
      const kek = await importKek(0xa1)
      mockDeriveKeyEncryptionKey.mockResolvedValue(kek)
      mockRegisterKey.mockResolvedValue({ ok: true, key_id: 'kid' })

      const result = await flow.registerNewKeyWithPasskey({ user: USER })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.credentialId).toBe('cred-new')
      expect(result.keyIdHex).toMatch(/^[0-9a-f]{32}$/)
      expect(result.cekHex).toMatch(/^[0-9a-f]{64}$/)
      expect(mockRegisterKey).toHaveBeenCalledOnce()
      const registerArg = mockRegisterKey.mock.calls[0][0]
      expect(registerArg.keyIdHex).toBe(result.keyIdHex)
      expect(registerArg.bundle.credentialId).toBe('cred-new')
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

    it('returns register_failed when the enclave call rejects', async () => {
      mockCreatePrfPasskey.mockResolvedValue({
        credentialId: 'cred-x',
        prfOutput: new Uint8Array(32).buffer,
      })
      mockDeriveKeyEncryptionKey.mockResolvedValue(await importKek(0xa2))
      mockRegisterKey.mockRejectedValue(new Error('STALE_KEY'))
      const result = await flow.registerNewKeyWithPasskey({ user: USER })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.reason).toBe('register_failed')
    })
  })

  describe('unlockWithPasskey', () => {
    it('round-trips a registered key bundle into a CEK', async () => {
      const cek = crypto.getRandomValues(new Uint8Array(32))
      const cekHex = cekBytesToHex(cek)
      const expectedKid = await deriveKeyIdHex(cek)
      const kek = await importKek(0xb1)
      const bundle = await wrapCekForCredential({
        credentialId: 'cred-r',
        kek,
        cek,
      })

      mockGetCurrentKey.mockResolvedValue({
        key_id: expectedKid,
        bundles: [
          {
            credential_id: bundle.credentialId,
            kek_iv: bundle.kekIvHex,
            wrapped_key: bundle.wrappedKeyHex,
            salt: bundle.saltHex,
            info: bundle.info ?? '',
            created_at: '2026-05-01T00:00:00Z',
          },
        ],
      })
      mockAuthenticatePrfPasskey.mockResolvedValue({
        credentialId: 'cred-r',
        prfOutput: new Uint8Array(32).buffer,
      })
      mockDeriveKeyEncryptionKey.mockResolvedValue(kek)

      const result = await flow.unlockWithPasskey()
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.cekHex).toBe(cekHex)
      expect(result.keyIdHex).toBe(expectedKid)
      expect(result.credentialId).toBe('cred-r')
    })

    it('reports no_remote_bundle when the enclave has no key registered', async () => {
      mockGetCurrentKey.mockResolvedValue({ key_id: null, bundles: [] })
      const result = await flow.unlockWithPasskey()
      expect(result).toEqual({ ok: false, reason: 'no_remote_bundle' })
      expect(mockAuthenticatePrfPasskey).not.toHaveBeenCalled()
    })

    it('reports bundle_decrypt_failed on KEK mismatch', async () => {
      const cek = crypto.getRandomValues(new Uint8Array(32))
      const wrongKek = await importKek(0xc1)
      const correctKek = await importKek(0xc2)
      const bundle = await wrapCekForCredential({
        credentialId: 'cred-mismatch',
        kek: correctKek,
        cek,
      })
      mockGetCurrentKey.mockResolvedValue({
        key_id: 'kid',
        bundles: [
          {
            credential_id: bundle.credentialId,
            kek_iv: bundle.kekIvHex,
            wrapped_key: bundle.wrappedKeyHex,
            salt: bundle.saltHex,
            info: bundle.info ?? '',
          },
        ],
      })
      mockAuthenticatePrfPasskey.mockResolvedValue({
        credentialId: 'cred-mismatch',
        prfOutput: new Uint8Array(32).buffer,
      })
      mockDeriveKeyEncryptionKey.mockResolvedValue(wrongKek)
      const result = await flow.unlockWithPasskey()
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.reason).toBe('bundle_decrypt_failed')
    })
  })

  describe('publishCurrentLocalCek', () => {
    it('reports no_remote_bundle when the enclave is empty', async () => {
      mockGetCurrentKey.mockResolvedValue({ key_id: null, bundles: [] })
      const result = await flow.publishCurrentLocalCek({
        legacyCekHex: 'aa'.repeat(32),
      })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.reason).toBe('no_remote_bundle')
    })

    it('passes through when local CEK matches the enclave key_id', async () => {
      const cek = crypto.getRandomValues(new Uint8Array(32))
      const cekHex = cekBytesToHex(cek)
      const kid = await deriveKeyIdHex(cek)
      mockGetCurrentKey.mockResolvedValue({
        key_id: kid,
        bundles: [
          {
            credential_id: 'cred-known',
            kek_iv: '',
            wrapped_key: '',
            salt: '',
            info: '',
          },
        ],
      })
      const result = await flow.publishCurrentLocalCek({ legacyCekHex: cekHex })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.keyIdHex).toBe(kid)
      expect(result.credentialId).toBe('cred-known')
    })

    it('refuses to overwrite a mismatched remote key', async () => {
      const local = crypto.getRandomValues(new Uint8Array(32))
      mockGetCurrentKey.mockResolvedValue({
        key_id: 'ff'.repeat(16),
        bundles: [],
      })
      const result = await flow.publishCurrentLocalCek({
        legacyCekHex: cekBytesToHex(local),
      })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.reason).toBe('no_remote_bundle')
    })
  })

  describe('addBundleForCurrentKey', () => {
    it('wraps the current CEK under a new passkey and posts to the enclave', async () => {
      const cek = crypto.getRandomValues(new Uint8Array(32))
      const kek = await importKek(0xd1)
      mockCreatePrfPasskey.mockResolvedValue({
        credentialId: 'cred-newdev',
        prfOutput: new Uint8Array(32).buffer,
      })
      mockDeriveKeyEncryptionKey.mockResolvedValue(kek)
      mockAddBundle.mockResolvedValue({ ok: true })
      const result = await flow.addBundleForCurrentKey({
        cekHex: cekBytesToHex(cek),
        keyIdHex: 'kid',
        user: USER,
      })
      expect(result.ok).toBe(true)
      expect(mockAddBundle).toHaveBeenCalledOnce()
      const [kid, bundle] = mockAddBundle.mock.calls[0]
      expect(kid).toBe('kid')
      expect(bundle.credentialId).toBe('cred-newdev')
    })
  })
})
