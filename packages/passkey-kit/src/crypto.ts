/**
 * Pure WebCrypto primitives: PRF output → KEK derivation (HKDF-SHA-256)
 * and CEK wrap/unwrap under that KEK (AES-256-GCM).
 *
 * References:
 * - W3C WebAuthn Level 3, §10.1.4 (PRF extension): https://w3c.github.io/webauthn/#prf-extension
 * - RFC 5869 (HKDF): https://tools.ietf.org/html/rfc5869
 */

import { bytesToHex, hexToBytes, toBytes } from './codec'
import { PasskeyKitError } from './errors'
import type { WrappedCek } from './types'

export const CEK_BYTES = 32
const AES_GCM_IV_BYTES = 12
const DEFAULT_KEY_ID_BYTES = 16

/**
 * Derive an AES-256-GCM Key Encryption Key (KEK) from PRF output using HKDF.
 *
 * Raw PRF output is treated as Input Keying Material (IKM), not used
 * directly as a key. HKDF with a purpose-binding info string produces the
 * final non-extractable CryptoKey. An empty HKDF salt is used, which is
 * fine for high-entropy IKM (RFC 5869 §3.1).
 */
export async function deriveKeyEncryptionKey(
  prfOutput: ArrayBuffer | Uint8Array,
  hkdfInfo: string | Uint8Array,
): Promise<CryptoKey> {
  const masterKey = await crypto.subtle.importKey(
    'raw',
    prfOutput as BufferSource,
    'HKDF',
    false, // non-extractable
    ['deriveKey'],
  )

  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(),
      info: toBytes(hkdfInfo) as BufferSource,
    },
    masterKey,
    { name: 'AES-GCM', length: 256 },
    false, // non-extractable
    ['encrypt', 'decrypt'],
  )
}

/**
 * Wrap a raw 32-byte CEK under a passkey-derived KEK using AES-256-GCM
 * with a fresh random IV. The returned hex fields are safe to persist
 * server-side; only the matching passkey can recover the CEK.
 */
export async function wrapCek(opts: {
  credentialId: string
  kek: CryptoKey
  cek: Uint8Array
}): Promise<WrappedCek> {
  if (opts.cek.length !== CEK_BYTES) {
    throw new PasskeyKitError(
      `passkey-kit: CEK must be ${CEK_BYTES} bytes, got ${opts.cek.length}`,
    )
  }
  const iv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES))
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    opts.kek,
    opts.cek as BufferSource,
  )
  return {
    credentialId: opts.credentialId,
    kekIvHex: bytesToHex(iv),
    wrappedKeyHex: bytesToHex(new Uint8Array(ciphertext)),
  }
}

/**
 * Inverse of {@link wrapCek}: recover the raw CEK bytes given the same KEK.
 * Throws on tamper (GCM auth failure) or any shape mismatch.
 */
export async function unwrapCek(
  kek: CryptoKey,
  wrapped: Pick<WrappedCek, 'kekIvHex' | 'wrappedKeyHex'>,
): Promise<Uint8Array> {
  if (!wrapped.kekIvHex || !wrapped.wrappedKeyHex) {
    throw new PasskeyKitError('passkey-kit: missing iv or wrapped key')
  }
  const iv = hexToBytes(wrapped.kekIvHex)
  if (iv.length !== AES_GCM_IV_BYTES) {
    throw new PasskeyKitError('passkey-kit: iv length mismatch')
  }
  const ciphertext = hexToBytes(wrapped.wrappedKeyHex)
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    kek,
    ciphertext as BufferSource,
  )
  const cek = new Uint8Array(plaintext)
  if (cek.length !== CEK_BYTES) {
    throw new PasskeyKitError(
      `passkey-kit: unwrapped CEK has wrong length ${cek.length}`,
    )
  }
  return cek
}

/**
 * Derive a stable public identifier for a CEK via HKDF-SHA-256 with an
 * empty salt and a caller-supplied info string. The result identifies the
 * key without revealing it (one-way derivation).
 */
export async function deriveKeyId(
  cek: Uint8Array,
  opts: { info: string | Uint8Array; lengthBytes?: number },
): Promise<Uint8Array> {
  if (cek.length !== CEK_BYTES) {
    throw new PasskeyKitError(
      `passkey-kit: CEK must be ${CEK_BYTES} bytes, got ${cek.length}`,
    )
  }
  const lengthBytes = opts.lengthBytes ?? DEFAULT_KEY_ID_BYTES
  const ikm = await crypto.subtle.importKey(
    'raw',
    cek as BufferSource,
    'HKDF',
    false,
    ['deriveBits'],
  )
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0) as BufferSource,
      info: toBytes(opts.info) as BufferSource,
    },
    ikm,
    lengthBytes * 8,
  )
  return new Uint8Array(bits)
}
