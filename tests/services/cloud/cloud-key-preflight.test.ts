import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The mocked service stores keys directly as base64 strings: the
// "current" key backs getKeyBytesOrThrow (staged or loaded), while
// the "persisted" key + alternatives back getKey/getStoredAlternatives
// (localStorage history used by migrationKeys()).
const mockCurrentKey = vi.fn<() => string | null>()
const mockPersistedKey = vi.fn<() => string | null>()
const mockStoredAlternatives = vi.fn<() => string[]>()
const mockKeyCurrent = vi.fn()

function b64ToBytes(key: string): Uint8Array {
  const bin = atob(key)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

vi.mock('@/services/encryption/encryption-service', () => ({
  encryptionService: {
    getKey: () => mockPersistedKey(),
    getKeyBytesOrThrow: () => {
      const key = mockCurrentKey()
      if (!key) throw new Error('no key')
      return b64ToBytes(key)
    },
    getStoredAlternatives: () => mockStoredAlternatives(),
    getAlternativeKeyBytes: (key: string) => b64ToBytes(key),
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
    mockPersistedKey.mockReset()
    mockStoredAlternatives.mockReset()
    mockStoredAlternatives.mockReturnValue([])
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
      mockCurrentKey.mockReturnValue(null)
      mockPersistedKey.mockReturnValue(null)
      const result = await validateCurrentPrimaryKey()
      expect(result.remoteState).toBe('unknown')
      expect(result.canWrite).toBe(false)
      expect(result.probe).toBe('none')
      expect(mockKeyCurrent).not.toHaveBeenCalled()
    })

    it('returns empty/writable when the enclave has no key', async () => {
      const { b64 } = makeDeterministicCek()
      mockCurrentKey.mockReturnValue(b64)
      mockPersistedKey.mockReturnValue(b64)
      mockKeyCurrent.mockResolvedValue({ key_id: null, bundles: {} })
      const result = await validateCurrentPrimaryKey()
      expect(result.remoteState).toBe('empty')
      expect(result.canWrite).toBe(true)
    })

    it('accepts the local key over legacy data when no key is registered', async () => {
      const { b64 } = makeDeterministicCek()
      mockCurrentKey.mockReturnValue(b64)
      mockPersistedKey.mockReturnValue(b64)
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

    it('accepts a staged key on a fresh device with no persisted keys', async () => {
      const { b64 } = makeDeterministicCek()
      mockCurrentKey.mockReturnValue(b64)
      mockPersistedKey.mockReturnValue(null)
      mockKeyCurrent.mockResolvedValue({
        key_id: null,
        bundles: {},
        has_data: true,
      })

      const result = await validateCurrentPrimaryKey()

      expect(result.canWrite).toBe(true)
    })

    it('allows writes when local KeyID matches enclave KeyID', async () => {
      const { cek, b64 } = makeDeterministicCek()
      const expectedKid = await deriveKeyIdHex(cek)
      mockCurrentKey.mockReturnValue(b64)
      mockPersistedKey.mockReturnValue(b64)
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
      mockPersistedKey.mockReturnValue(b64)
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
      mockPersistedKey.mockReturnValue(b64)
      mockKeyCurrent.mockRejectedValue(new Error('network'))
      const result = await validateCurrentPrimaryKey()
      expect(result.remoteState).toBe('unknown')
      expect(result.canWrite).toBe(false)
    })
  })
})
