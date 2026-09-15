import { requirePrimaryKeyB64 } from '@/services/keys/cek-encoding'
import { expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ bytes: vi.fn() }))
vi.mock('@/services/encryption/encryption-service', () => ({
  encryptionService: { getKeyBytesOrThrow: mocks.bytes },
}))
it('encodes the active CEK and clears its temporary bytes', () => {
  const bytes = new Uint8Array(32).fill(1)
  mocks.bytes.mockReturnValue(bytes)
  expect(requirePrimaryKeyB64()).toBe(
    btoa(String.fromCharCode(...new Uint8Array(32).fill(1))),
  )
  expect(bytes.every((byte) => byte === 0)).toBe(true)
})
it('rejects a missing key', () => {
  mocks.bytes.mockImplementation(() => {
    throw new Error('missing key')
  })
  expect(requirePrimaryKeyB64).toThrow('missing key')
})
