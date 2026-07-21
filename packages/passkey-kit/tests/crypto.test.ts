import { describe, expect, it } from 'vitest'
import { bytesToHex } from '../src/codec'
import {
  CEK_BYTES,
  deriveKeyEncryptionKey,
  deriveKeyId,
  unwrapCek,
  wrapCek,
} from '../src/crypto'
import { PasskeyKitError } from '../src/errors'

const HKDF_INFO = 'test-kek-v1'

function randomPrfOutput(): ArrayBuffer {
  return crypto.getRandomValues(new Uint8Array(32)).buffer as ArrayBuffer
}

describe('deriveKeyEncryptionKey', () => {
  it('derives a non-extractable AES-256-GCM key', async () => {
    const kek = await deriveKeyEncryptionKey(randomPrfOutput(), HKDF_INFO)
    expect(kek.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 })
    expect(kek.extractable).toBe(false)
    expect(kek.usages).toContain('encrypt')
    expect(kek.usages).toContain('decrypt')
  })

  it('is deterministic for the same PRF output and info', async () => {
    const prf = crypto.getRandomValues(new Uint8Array(32))
    const cek = crypto.getRandomValues(new Uint8Array(CEK_BYTES))
    const kek1 = await deriveKeyEncryptionKey(prf.slice(), HKDF_INFO)
    const kek2 = await deriveKeyEncryptionKey(prf.slice(), HKDF_INFO)
    const wrapped = await wrapCek({ credentialId: 'c', kek: kek1, cek })
    expect(await unwrapCek(kek2, wrapped)).toEqual(cek)
  })

  it('domain-separates by hkdf info', async () => {
    const prf = crypto.getRandomValues(new Uint8Array(32))
    const cek = crypto.getRandomValues(new Uint8Array(CEK_BYTES))
    const kek1 = await deriveKeyEncryptionKey(prf.slice(), HKDF_INFO)
    const kek2 = await deriveKeyEncryptionKey(prf.slice(), 'other-info')
    const wrapped = await wrapCek({ credentialId: 'c', kek: kek1, cek })
    await expect(unwrapCek(kek2, wrapped)).rejects.toThrow()
  })
})

describe('wrapCek / unwrapCek', () => {
  it('round-trips a CEK', async () => {
    const kek = await deriveKeyEncryptionKey(randomPrfOutput(), HKDF_INFO)
    const cek = crypto.getRandomValues(new Uint8Array(CEK_BYTES))
    const wrapped = await wrapCek({ credentialId: 'cred-1', kek, cek })
    expect(wrapped.credentialId).toBe('cred-1')
    expect(wrapped.kekIvHex).toMatch(/^[0-9a-f]{24}$/)
    expect(await unwrapCek(kek, wrapped)).toEqual(cek)
  })

  it('uses a fresh IV per wrap', async () => {
    const kek = await deriveKeyEncryptionKey(randomPrfOutput(), HKDF_INFO)
    const cek = crypto.getRandomValues(new Uint8Array(CEK_BYTES))
    const a = await wrapCek({ credentialId: 'c', kek, cek })
    const b = await wrapCek({ credentialId: 'c', kek, cek })
    expect(a.kekIvHex).not.toBe(b.kekIvHex)
    expect(a.wrappedKeyHex).not.toBe(b.wrappedKeyHex)
  })

  it('rejects a CEK of the wrong length', async () => {
    const kek = await deriveKeyEncryptionKey(randomPrfOutput(), HKDF_INFO)
    await expect(
      wrapCek({ credentialId: 'c', kek, cek: new Uint8Array(16) }),
    ).rejects.toBeInstanceOf(PasskeyKitError)
  })

  it('rejects tampered ciphertext', async () => {
    const kek = await deriveKeyEncryptionKey(randomPrfOutput(), HKDF_INFO)
    const cek = crypto.getRandomValues(new Uint8Array(CEK_BYTES))
    const wrapped = await wrapCek({ credentialId: 'c', kek, cek })
    const firstByte = parseInt(wrapped.wrappedKeyHex.slice(0, 2), 16)
    const flipped =
      ((firstByte ^ 0xff).toString(16).padStart(2, '0') as string) +
      wrapped.wrappedKeyHex.slice(2)
    await expect(
      unwrapCek(kek, { ...wrapped, wrappedKeyHex: flipped }),
    ).rejects.toThrow()
  })

  it('rejects malformed inputs', async () => {
    const kek = await deriveKeyEncryptionKey(randomPrfOutput(), HKDF_INFO)
    await expect(
      unwrapCek(kek, { kekIvHex: '', wrappedKeyHex: 'aa' }),
    ).rejects.toBeInstanceOf(PasskeyKitError)
    await expect(
      unwrapCek(kek, { kekIvHex: 'aabb', wrappedKeyHex: 'aa' }),
    ).rejects.toBeInstanceOf(PasskeyKitError)
  })
})

describe('deriveKeyId', () => {
  it('is deterministic and hex-encodable', async () => {
    const cek = crypto.getRandomValues(new Uint8Array(CEK_BYTES))
    const id1 = await deriveKeyId(cek, { info: 'key-id-v1' })
    const id2 = await deriveKeyId(cek, { info: 'key-id-v1' })
    expect(id1).toEqual(id2)
    expect(bytesToHex(id1)).toMatch(/^[0-9a-f]{32}$/)
  })

  it('domain-separates by info and differs per CEK', async () => {
    const cek = crypto.getRandomValues(new Uint8Array(CEK_BYTES))
    const other = crypto.getRandomValues(new Uint8Array(CEK_BYTES))
    const a = await deriveKeyId(cek, { info: 'key-id-v1' })
    const b = await deriveKeyId(cek, { info: 'key-id-v2' })
    const c = await deriveKeyId(other, { info: 'key-id-v1' })
    expect(a).not.toEqual(b)
    expect(a).not.toEqual(c)
  })

  it('supports custom output lengths and rejects bad CEKs', async () => {
    const cek = crypto.getRandomValues(new Uint8Array(CEK_BYTES))
    const id = await deriveKeyId(cek, { info: 'key-id-v1', lengthBytes: 32 })
    expect(id.length).toBe(32)
    await expect(
      deriveKeyId(new Uint8Array(8), { info: 'key-id-v1' }),
    ).rejects.toBeInstanceOf(PasskeyKitError)
  })
})
