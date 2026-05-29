/**
 * retrieveEncryptedKeys cross-format tolerance.
 *
 * The wire bundle is just `AES-GCM(plaintext)` — the plaintext shape
 * is a client convention. iOS (and the modern webapp flow) wrap the
 * raw 32-byte CEK directly. The pre-v2 webapp wrapped a
 * `{primary, alternatives, ...}` JSON envelope. This file asserts
 * that the unlock path accepts both.
 */

import {
  encryptKeyBundle,
  retrieveEncryptedKeys,
} from '@/services/passkey/passkey-key-storage'
import { deriveKeyEncryptionKey } from '@/services/passkey/passkey-service'
import { wrapCekForCredential } from '@/services/sync-enclave/key-bundle'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/utils/error-handling', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
}))

const mockKeyCurrent = vi.fn()

vi.mock('@/services/encryption/encryption-service', () => ({
  encryptionService: {
    getKey: vi.fn().mockReturnValue('key_test'),
    getKeyBytesOrThrow: () => new TextEncoder().encode('key_test'),
    encodeKeyFromBytes: (bytes: Uint8Array) => {
      const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
      let result = ''
      for (let i = 0; i < bytes.length; i++) {
        result += chars[Math.floor(bytes[i] / chars.length)]
        result += chars[bytes[i] % chars.length]
      }
      return `key_${result}`
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
  }
})

const CRED_ID = 'cred_test_1'
const CEK_BYTES = new Uint8Array(32).map((_, i) => i + 1) // deterministic 32 raw bytes

function cekToKeyString(bytes: Uint8Array): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let result = ''
  for (let i = 0; i < bytes.length; i++) {
    result += chars[Math.floor(bytes[i] / chars.length)]
    result += chars[bytes[i] % chars.length]
  }
  return `key_${result}`
}

function base64ToHex(b64: string): string {
  const binary = atob(b64)
  let out = ''
  for (let i = 0; i < binary.length; i++) {
    out += binary.charCodeAt(i).toString(16).padStart(2, '0')
  }
  return out
}

describe('retrieveEncryptedKeys', () => {
  beforeEach(() => {
    mockKeyCurrent.mockReset()
  })

  it('returns the CEK when the bundle wraps raw CEK bytes (iOS / v2 webapp shape)', async () => {
    const prf = crypto.getRandomValues(new Uint8Array(32)).buffer as ArrayBuffer
    const kek = await deriveKeyEncryptionKey(prf)
    const wrapped = await wrapCekForCredential({
      credentialId: CRED_ID,
      kek,
      cek: CEK_BYTES,
    })
    mockKeyCurrent.mockResolvedValue({
      key_id: 'feedface'.repeat(8).slice(0, 64),
      etag: '1',
      bundles: {
        [CRED_ID]: {
          credential_id: CRED_ID,
          kek_iv: wrapped.kekIvHex,
          encrypted_keys: wrapped.wrappedKeyHex,
          bundle_version: 1,
          updated_at: new Date().toISOString(),
        },
      },
    })

    const bundle = await retrieveEncryptedKeys(CRED_ID, kek)
    expect(bundle).not.toBeNull()
    expect(bundle?.primary).toBe(cekToKeyString(CEK_BYTES))
    expect(bundle?.alternatives).toEqual([])
  })

  it('returns the CEK when the bundle wraps a legacy JSON envelope (pre-v2 webapp shape)', async () => {
    const prf = crypto.getRandomValues(new Uint8Array(32)).buffer as ArrayBuffer
    const kek = await deriveKeyEncryptionKey(prf)
    const original = {
      primary: 'key_legacy_primary',
      alternatives: ['key_legacy_alt_1', 'key_legacy_alt_2'],
    }
    const encrypted = await encryptKeyBundle(kek, original)
    mockKeyCurrent.mockResolvedValue({
      key_id: 'feedface'.repeat(8).slice(0, 64),
      etag: '1',
      bundles: {
        [CRED_ID]: {
          credential_id: CRED_ID,
          kek_iv: base64ToHex(encrypted.iv),
          encrypted_keys: base64ToHex(encrypted.data),
          bundle_version: 1,
          updated_at: new Date().toISOString(),
        },
      },
    })

    const bundle = await retrieveEncryptedKeys(CRED_ID, kek)
    expect(bundle).not.toBeNull()
    expect(bundle?.primary).toBe(original.primary)
    expect(bundle?.alternatives).toEqual(original.alternatives)
  })

  it('returns null when the credential id is not present in the enclave bundles', async () => {
    const prf = crypto.getRandomValues(new Uint8Array(32)).buffer as ArrayBuffer
    const kek = await deriveKeyEncryptionKey(prf)
    mockKeyCurrent.mockResolvedValue({
      key_id: 'feedface'.repeat(8).slice(0, 64),
      etag: '1',
      bundles: {},
    })

    const bundle = await retrieveEncryptedKeys(CRED_ID, kek)
    expect(bundle).toBeNull()
  })
})
