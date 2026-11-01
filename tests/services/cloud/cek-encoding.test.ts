import { requirePrimaryKeyB64 } from '@/services/keys/cek-encoding'
import { beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ bytes: vi.fn() }))
vi.mock('@/services/encryption/encryption-service', () => ({
  encryptionService: { getKeyBytesOrThrow: mocks.bytes },
}))
beforeEach(() => {
  mocks.bytes.mockReset()
})
it('encodes the active CEK and clears its temporary bytes', () => {
  const bytes = Uint8Array.from({ length: 32 }, (_, index) => index)
  mocks.bytes.mockReturnValue(bytes)
  expect(requirePrimaryKeyB64()).toBe(
    'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
  )
  expect(bytes.every((byte) => byte === 0)).toBe(true)
})
