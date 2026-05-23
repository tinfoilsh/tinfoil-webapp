import {
  buildCanonical,
  computeOperationHash,
  deriveOpHashKey,
  operationHashForCek,
} from '@/services/sync-enclave/operation-hash'
import { describe, expect, it } from 'vitest'

// §7.0 test vector, byte-for-byte identical to the Go reference at
// confidential-sync-enclave/internal/crypto/ophash_test.go. If this
// drifts on either side, sync writes will start failing at runtime.
const VECTOR = {
  cekHex: '4242424242424242424242424242424242424242424242424242424242424242',
  method: 'PUT',
  path: '/api/profile/',
  keyIdHex: '00112233445566778899aabbccddeeff',
  ifMatch: '0',
  idempotencyKey: '0123456789abcdef',
  body: new TextEncoder().encode('{"data":"hello"}'),
  expectedHash:
    '518d0af258a1001dbf5689ac11f85d783d152adcf664a24ef996010b12b52e23',
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('odd hex length')
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16)
  }
  return out
}

describe('operation-hash', () => {
  it('produces the pinned §7.0 vector', async () => {
    const cek = hexToBytes(VECTOR.cekHex)
    const hash = await operationHashForCek(cek, {
      method: VECTOR.method,
      path: VECTOR.path,
      keyIdHex: VECTOR.keyIdHex,
      ifMatch: VECTOR.ifMatch,
      idempotencyKey: VECTOR.idempotencyKey,
      body: VECTOR.body,
    })
    expect(hash).toBe(VECTOR.expectedHash)
  })

  it('rejects CEKs of the wrong size', async () => {
    await expect(deriveOpHashKey(new Uint8Array(31))).rejects.toThrow(
      /32 bytes/,
    )
    await expect(deriveOpHashKey(new Uint8Array(33))).rejects.toThrow(
      /32 bytes/,
    )
  })

  it('builds canonical input with big-endian uint32 length prefixes', () => {
    const got = buildCanonical({
      method: 'AB',
      path: 'C',
      keyIdHex: '',
      ifMatch: '0',
      idempotencyKey: 'I',
      body: new TextEncoder().encode('D'),
    })
    const want = new Uint8Array([
      0, 0, 0, 2, 0x41, 0x42, 0, 0, 0, 1, 0x43, 0, 0, 0, 0, 0, 0, 0, 1, 0x30, 0,
      0, 0, 1, 0x49, 0, 0, 0, 1, 0x44,
    ])
    expect(Array.from(got)).toEqual(Array.from(want))
  })

  it('caching the derived subkey is safe across many ops', async () => {
    const cek = hexToBytes(VECTOR.cekHex)
    const opKey = await deriveOpHashKey(cek)
    const a = await computeOperationHash(opKey, {
      method: VECTOR.method,
      path: VECTOR.path,
      keyIdHex: VECTOR.keyIdHex,
      ifMatch: VECTOR.ifMatch,
      idempotencyKey: VECTOR.idempotencyKey,
      body: VECTOR.body,
    })
    const b = await computeOperationHash(opKey, {
      method: VECTOR.method,
      path: VECTOR.path,
      keyIdHex: VECTOR.keyIdHex,
      ifMatch: VECTOR.ifMatch,
      idempotencyKey: VECTOR.idempotencyKey,
      body: VECTOR.body,
    })
    expect(a).toBe(b)
    expect(a).toBe(VECTOR.expectedHash)
  })

  it('any single-bit body change flips the MAC', async () => {
    const cek = hexToBytes(VECTOR.cekHex)
    const tampered = new Uint8Array(VECTOR.body)
    tampered[0] ^= 0x01
    const hash = await operationHashForCek(cek, {
      method: VECTOR.method,
      path: VECTOR.path,
      keyIdHex: VECTOR.keyIdHex,
      ifMatch: VECTOR.ifMatch,
      idempotencyKey: VECTOR.idempotencyKey,
      body: tampered,
    })
    expect(hash).not.toBe(VECTOR.expectedHash)
  })
})
