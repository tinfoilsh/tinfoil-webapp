import { describe, expect, it } from 'vitest'
import {
  base64ToBytes,
  base64UrlToBytes,
  bufferSourceToArrayBuffer,
  bytesToBase64,
  bytesToBase64Url,
  bytesToHex,
  hexToBytes,
} from '../src/codec'

describe('codec', () => {
  it('round-trips bytes through hex', () => {
    const bytes = crypto.getRandomValues(new Uint8Array(64))
    expect(hexToBytes(bytesToHex(bytes))).toEqual(bytes)
  })

  it('rejects malformed hex', () => {
    expect(() => hexToBytes('abc')).toThrow('odd-length')
    expect(() => hexToBytes('zz')).toThrow('invalid hex')
  })

  it('round-trips bytes through base64', () => {
    const bytes = new Uint8Array(100_000).map((_, i) => i % 256)
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes)
  })

  it('round-trips bytes through base64url without padding or unsafe chars', () => {
    const bytes = crypto.getRandomValues(new Uint8Array(33))
    const encoded = bytesToBase64Url(bytes)
    expect(encoded).not.toMatch(/[+/=]/)
    expect(base64UrlToBytes(encoded)).toEqual(bytes)
  })

  it('copies BufferSource views into standalone ArrayBuffers', () => {
    const backing = new Uint8Array([1, 2, 3, 4, 5])
    const view = backing.subarray(1, 4)
    const copy = new Uint8Array(bufferSourceToArrayBuffer(view))
    expect(copy).toEqual(new Uint8Array([2, 3, 4]))
    backing[2] = 99
    expect(copy[1]).toBe(3)
  })
})
