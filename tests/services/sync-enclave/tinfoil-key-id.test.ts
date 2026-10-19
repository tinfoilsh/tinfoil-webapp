import { deriveTinfoilKeyIdHex } from '@/services/sync-enclave/tinfoil-key-id'
import { describe, expect, it } from 'vitest'

describe('deriveTinfoilKeyIdHex', () => {
  it('matches the enclave reference vector byte-for-byte', async () => {
    const cek = new Uint8Array(32).map((_, index) => index)
    await expect(deriveTinfoilKeyIdHex(cek)).resolves.toBe(
      '960e28ca37b723e7abc19995dbef143f',
    )
  })

  it('rejects a key with the wrong size', async () => {
    await expect(deriveTinfoilKeyIdHex(new Uint8Array(31))).rejects.toThrow(
      '32 bytes',
    )
  })
})
