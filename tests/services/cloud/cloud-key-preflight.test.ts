import { beforeEach, describe, expect, it, vi } from 'vitest'

// The mocked service stores the current key (staged or loaded) as a
// base64 string behind getKeyBytesOrThrow.
const mockCurrentKey = vi.fn<() => string | null>()
const mockKeyCurrent = vi.fn()

function b64ToBytes(key: string): Uint8Array {
  const bin = atob(key)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

vi.mock('@/services/encryption/encryption-service', () => ({
  encryptionService: {
    getKeyBytesOrThrow: () => {
      const key = mockCurrentKey()
      if (!key) throw new Error('no key')
      return b64ToBytes(key)
    },
  },
}))

vi.mock('@/services/harness/keys', async () => {
  const real = await vi.importActual<typeof import('@/services/harness/keys')>(
    '@/services/harness/keys',
  )
  return {
    ...real,
    keyCurrent: (...args: unknown[]) => mockKeyCurrent(...args),
  }
})

import {
  inspectRemoteEncryptedState,
  validateCurrentPrimaryKey,
} from '@/services/keys/cloud-key-preflight'
import { deriveTinfoilKeyIdHex } from '@/services/keys/tinfoil-key-id'

function makeDeterministicCek(offset = 1): { cek: Uint8Array; b64: string } {
  const cek = new Uint8Array(32)
  for (let i = 0; i < 32; i++) cek[i] = (i + offset) % 256
  let bin = ''
  for (let i = 0; i < cek.length; i++) bin += String.fromCharCode(cek[i])
  return { cek, b64: btoa(bin) }
}

describe('cloud-key-preflight', () => {
  beforeEach(() => {
    mockCurrentKey.mockReset()
    mockKeyCurrent.mockReset()
  })

  describe('inspectRemoteEncryptedState', () => {
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

    it.each([undefined, false])(
      'returns empty when there is no key and no data',
      async (hasData) => {
        mockKeyCurrent.mockResolvedValue({
          key_id: null,
          bundles: {},
          has_data: hasData,
        })
        expect(await inspectRemoteEncryptedState()).toBe('empty')
      },
    )

    it('returns unknown when the enclave probe fails', async () => {
      mockKeyCurrent.mockRejectedValue(new Error('network'))
      expect(await inspectRemoteEncryptedState()).toBe('unknown')
    })
  })

  describe('validateCurrentPrimaryKey', () => {
    it('returns unknown/none with message when no local key is loaded', async () => {
      mockCurrentKey.mockReturnValue(null)
      const result = await validateCurrentPrimaryKey()
      expect(result.remoteState).toBe('unknown')
      expect(result.canWrite).toBe(false)
      expect(result.probe).toBe('none')
      expect(mockKeyCurrent).not.toHaveBeenCalled()
    })

    it('returns empty/writable when the enclave has no key', async () => {
      const { b64 } = makeDeterministicCek()
      mockCurrentKey.mockReturnValue(b64)
      mockKeyCurrent.mockResolvedValue({ key_id: null, bundles: {} })
      const result = await validateCurrentPrimaryKey()
      expect(result.remoteState).toBe('empty')
      expect(result.canWrite).toBe(true)
    })

    it('accepts the local key over legacy data when no key is registered', async () => {
      const { b64 } = makeDeterministicCek()
      mockCurrentKey.mockReturnValue(b64)
      mockKeyCurrent.mockResolvedValue({
        key_id: null,
        bundles: {},
        has_data: true,
      })

      const result = await validateCurrentPrimaryKey()

      expect(result.remoteState).toBe('exists')
      expect(result.canWrite).toBe(true)
      expect(result.needsAdoption).toBe(true)
    })

    it('allows writes when local KeyID matches enclave KeyID', async () => {
      const { cek, b64 } = makeDeterministicCek()
      const expectedKid = await deriveTinfoilKeyIdHex(cek)
      mockCurrentKey.mockReturnValue(b64)
      mockKeyCurrent.mockResolvedValue({
        key_id: expectedKid,
        bundles: {},
      })
      const result = await validateCurrentPrimaryKey()
      expect(result.remoteState).toBe('exists')
      expect(result.canWrite).toBe(true)
      expect(result.needsAdoption).toBeFalsy()
    })

    it('blocks writes when local KeyID does not match the enclave KeyID', async () => {
      const { b64 } = makeDeterministicCek()
      mockCurrentKey.mockReturnValue(b64)
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
      const { b64 } = makeDeterministicCek()
      mockCurrentKey.mockReturnValue(b64)
      mockKeyCurrent.mockRejectedValue(new Error('network'))
      const result = await validateCurrentPrimaryKey()
      expect(result.remoteState).toBe('unknown')
      expect(result.canWrite).toBe(false)
    })
  })
})
