import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockGetKey = vi.fn<() => string | null>()
const mockKeyCurrent = vi.fn()

vi.mock('@/services/encryption/encryption-service', () => ({
  encryptionService: {
    getKey: () => mockGetKey(),
    getKeyBytesOrThrow: () => {
      const key = mockGetKey()
      if (!key) throw new Error('no key')
      const bin = atob(key)
      const out = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
      return out
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

import {
  inspectRemoteEncryptedState,
  validateCurrentPrimaryKey,
} from '@/services/cloud/cloud-key-preflight'
import { deriveKeyIdHex } from '@/services/sync-enclave/key-bundle'

function cekHexToBase64(): { cek: Uint8Array; b64: string } {
  const cek = new Uint8Array(32)
  for (let i = 0; i < 32; i++) cek[i] = i + 1
  let bin = ''
  for (let i = 0; i < cek.length; i++) bin += String.fromCharCode(cek[i])
  return { cek, b64: btoa(bin) }
}

describe('cloud-key-preflight', () => {
  beforeEach(() => {
    mockGetKey.mockReset()
    mockKeyCurrent.mockReset()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('inspectRemoteEncryptedState', () => {
    it('returns empty when the enclave has no key', async () => {
      mockKeyCurrent.mockResolvedValue({ key_id: null, bundles: {} })
      expect(await inspectRemoteEncryptedState()).toBe('empty')
    })

    it('returns exists when the enclave has a key', async () => {
      mockKeyCurrent.mockResolvedValue({ key_id: 'abc', bundles: {} })
      expect(await inspectRemoteEncryptedState()).toBe('exists')
    })

    it('returns exists when there is no key but legacy data exists', async () => {
      mockKeyCurrent.mockResolvedValue({
        key_id: null,
        bundles: {},
        has_data: true,
      })
      expect(await inspectRemoteEncryptedState()).toBe('exists')
    })

    it('returns empty when there is no key and no data', async () => {
      mockKeyCurrent.mockResolvedValue({
        key_id: null,
        bundles: {},
        has_data: false,
      })
      expect(await inspectRemoteEncryptedState()).toBe('empty')
    })

    it('returns unknown when the enclave probe fails', async () => {
      mockKeyCurrent.mockRejectedValue(new Error('network'))
      expect(await inspectRemoteEncryptedState()).toBe('unknown')
    })
  })

  describe('validateCurrentPrimaryKey', () => {
    it('returns unknown/none with message when no local key is loaded', async () => {
      mockGetKey.mockReturnValue(null)
      const result = await validateCurrentPrimaryKey()
      expect(result.remoteState).toBe('unknown')
      expect(result.canWrite).toBe(false)
      expect(result.probe).toBe('none')
      expect(mockKeyCurrent).not.toHaveBeenCalled()
    })

    it('returns empty/writable when the enclave has no key', async () => {
      const { b64 } = cekHexToBase64()
      mockGetKey.mockReturnValue(b64)
      mockKeyCurrent.mockResolvedValue({ key_id: null, bundles: {} })
      const result = await validateCurrentPrimaryKey()
      expect(result.remoteState).toBe('empty')
      expect(result.canWrite).toBe(true)
    })

    it('allows writes when local KeyID matches enclave KeyID', async () => {
      const { cek, b64 } = cekHexToBase64()
      const expectedKid = await deriveKeyIdHex(cek)
      mockGetKey.mockReturnValue(b64)
      mockKeyCurrent.mockResolvedValue({
        key_id: expectedKid,
        bundles: {},
      })
      const result = await validateCurrentPrimaryKey()
      expect(result.remoteState).toBe('exists')
      expect(result.canWrite).toBe(true)
    })

    it('blocks writes when local KeyID does not match the enclave KeyID', async () => {
      const { b64 } = cekHexToBase64()
      mockGetKey.mockReturnValue(b64)
      mockKeyCurrent.mockResolvedValue({
        key_id: 'ff'.repeat(16),
        bundles: {},
      })
      const result = await validateCurrentPrimaryKey()
      expect(result.remoteState).toBe('exists')
      expect(result.canWrite).toBe(false)
      expect(result.message).toMatch(/doesn't match/)
    })

    it('returns unknown when the enclave probe fails', async () => {
      const { b64 } = cekHexToBase64()
      mockGetKey.mockReturnValue(b64)
      mockKeyCurrent.mockRejectedValue(new Error('network'))
      const result = await validateCurrentPrimaryKey()
      expect(result.remoteState).toBe('unknown')
      expect(result.canWrite).toBe(false)
    })
  })
})
