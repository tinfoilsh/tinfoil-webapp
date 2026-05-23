import {
  cekBytesToHex,
  cekHexToBytes,
  deriveKeyIdHex,
  unwrapCekFromBundle,
  wrapCekForCredential,
  wrapPrimaryCekForCredential,
} from '@/services/sync-enclave/key-bundle'
import { describe, expect, it } from 'vitest'

async function importKek(seed: number): Promise<CryptoKey> {
  const raw = new Uint8Array(32).fill(seed)
  return crypto.subtle.importKey(
    'raw',
    raw as unknown as BufferSource,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt'],
  )
}

describe('key-bundle', () => {
  it('wraps and unwraps a CEK round-trip', async () => {
    const kek = await importKek(0x11)
    const cek = crypto.getRandomValues(new Uint8Array(32))
    const bundle = await wrapCekForCredential({
      credentialId: 'cred-1',
      kek,
      cek,
    })
    expect(bundle.credentialId).toBe('cred-1')
    expect(bundle.kekIvHex).toMatch(/^[0-9a-f]{24}$/)
    // AES-GCM emits ciphertext = plaintext_len + 16 byte tag
    expect(bundle.wrappedKeyHex).toMatch(/^[0-9a-f]{96}$/)
    const recovered = await unwrapCekFromBundle(kek, bundle)
    expect(Array.from(recovered)).toEqual(Array.from(cek))
  })

  it('also unwraps the snake_case shape returned by the enclave', async () => {
    const kek = await importKek(0x22)
    const cek = crypto.getRandomValues(new Uint8Array(32))
    const camel = await wrapCekForCredential({
      credentialId: 'cred-1',
      kek,
      cek,
    })
    const snake = {
      credential_id: camel.credentialId,
      kek_iv: camel.kekIvHex,
      wrapped_key: camel.wrappedKeyHex,
      salt: camel.saltHex,
      info: camel.info ?? '',
    }
    const recovered = await unwrapCekFromBundle(kek, snake)
    expect(Array.from(recovered)).toEqual(Array.from(cek))
  })

  it('rejects CEKs of the wrong size', async () => {
    const kek = await importKek(0x33)
    await expect(
      wrapCekForCredential({
        credentialId: 'cred-1',
        kek,
        cek: new Uint8Array(31),
      }),
    ).rejects.toThrow(/32 bytes/)
  })

  it('detects tampered ciphertext (AES-GCM tag mismatch)', async () => {
    const kek = await importKek(0x44)
    const cek = crypto.getRandomValues(new Uint8Array(32))
    const bundle = await wrapCekForCredential({
      credentialId: 'cred-1',
      kek,
      cek,
    })
    const tampered = {
      ...bundle,
      wrappedKeyHex:
        bundle.wrappedKeyHex.slice(0, -2) +
        // Flip the last byte of the auth tag.
        (parseInt(bundle.wrappedKeyHex.slice(-2), 16) ^ 0x01)
          .toString(16)
          .padStart(2, '0'),
    }
    await expect(unwrapCekFromBundle(kek, tampered)).rejects.toThrow()
  })

  it('wrapPrimaryCekForCredential is the hex-string shim for wrap', async () => {
    const kek = await importKek(0x55)
    const cek = crypto.getRandomValues(new Uint8Array(32))
    const hex = cekBytesToHex(cek)
    const bundle = await wrapPrimaryCekForCredential({
      credentialId: 'cred-1',
      kek,
      primaryHex: hex,
    })
    const recovered = await unwrapCekFromBundle(kek, bundle)
    expect(cekBytesToHex(recovered)).toBe(hex)
  })

  it('hex helpers are inverses', () => {
    const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef])
    expect(cekHexToBytes(cekBytesToHex(bytes))).toEqual(bytes)
    expect(() => cekHexToBytes('abc')).toThrow(/odd-length/)
    expect(() => cekHexToBytes('0g')).toThrow(/invalid hex/)
  })

  it('deriveKeyIdHex matches the enclave reference vector', async () => {
    // CEK = 0x00, 0x01, ..., 0x1f. Pinned against the Go enclave's
    // crypto.DeriveKeyID with info="tinfoil-key-id-v1", empty salt.
    const cek = new Uint8Array(32)
    for (let i = 0; i < cek.length; i++) cek[i] = i
    const kid = await deriveKeyIdHex(cek)
    expect(kid).toBe('960e28ca37b723e7abc19995dbef143f')
  })

  it('deriveKeyIdHex rejects mis-sized CEKs', async () => {
    await expect(deriveKeyIdHex(new Uint8Array(31))).rejects.toThrow(/32 bytes/)
  })
})
