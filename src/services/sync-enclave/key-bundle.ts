/**
 * Wrap / unwrap the user's content encryption key (CEK) under a
 * passkey-PRF-derived KEK, in the shape the sync enclave expects.
 *
 * The enclave wire format (see syncplan.md §6, BundleBody in
 * sync-api.ts) carries one wrapped CEK per registered passkey
 * credential. There is no list of "alternative" keys: the enclave is
 * the single source of truth, and legacy alternatives are left to
 * Phase 4 opportunistic migration.
 */

import type { BundleBody } from './sync-api'

const AES_GCM_IV_BYTES = 12
const CEK_BYTES = 32
const KEY_ID_BYTES = 16
const BUNDLE_INFO = 'tinfoil-chat-kek-v1'
const KEY_ID_INFO = 'tinfoil-key-id-v1'

function bytesToHex(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0')
  }
  return out
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error('key-bundle: odd-length hex input')
  }
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16)
  }
  return out
}

/**
 * Wrap a raw 32-byte CEK under a passkey-PRF-derived KEK using
 * AES-256-GCM. Returns the hex-encoded fields the enclave expects in
 * a BundleBody.
 *
 * Callers MUST already have run the PRF flow and derived the KEK via
 * `deriveKeyEncryptionKey()`. Salt is included for forward-compat with
 * future KEK derivations that may rebind it; today the KEK derivation
 * uses an empty HKDF salt and we pass an empty string through.
 */
export async function wrapCekForCredential(opts: {
  credentialId: string
  kek: CryptoKey
  cek: Uint8Array
  saltHex?: string
}): Promise<BundleBody> {
  if (opts.cek.length !== CEK_BYTES) {
    throw new Error(
      `key-bundle: CEK must be ${CEK_BYTES} bytes, got ${opts.cek.length}`,
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
    saltHex: opts.saltHex ?? '',
    info: BUNDLE_INFO,
  }
}

/**
 * Inverse of {@link wrapCekForCredential}: given the same KEK and a
 * BundleBody pulled from the enclave, recover the raw CEK bytes.
 * Throws on any tamper or shape mismatch.
 */
export async function unwrapCekFromBundle(
  kek: CryptoKey,
  bundle: BundleBody | RemoteBundle,
): Promise<Uint8Array> {
  const ivHex = 'kekIvHex' in bundle ? bundle.kekIvHex : bundle.kek_iv
  const ctHex =
    'wrappedKeyHex' in bundle ? bundle.wrappedKeyHex : bundle.wrapped_key
  if (!ivHex || !ctHex) {
    throw new Error('key-bundle: missing iv or wrapped_key')
  }
  const iv = hexToBytes(ivHex)
  if (iv.length !== AES_GCM_IV_BYTES) {
    throw new Error('key-bundle: iv length mismatch')
  }
  const ciphertext = hexToBytes(ctHex)
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    kek,
    ciphertext as BufferSource,
  )
  const cek = new Uint8Array(plaintext)
  if (cek.length !== CEK_BYTES) {
    throw new Error(`key-bundle: unwrapped CEK has wrong length ${cek.length}`)
  }
  return cek
}

/**
 * Snake-case mirror of BundleBody as returned by
 * `GET /api/keys/current`. Kept here so the unwrap helper accepts
 * either shape and consumers can pass the response through verbatim.
 */
export interface RemoteBundle {
  credential_id: string
  kek_iv: string
  wrapped_key: string
  salt: string
  info: string
  created_at?: string
}

/**
 * Backward-compat shim: same input as legacy
 * passkey-key-storage.encryptKeyBundle({ primary, alternatives }), but
 * only the `primary` field is published. Alternatives stay local
 * (see Phase 4). Lets the migration shim call one function without
 * worrying about the new shape.
 */
export async function wrapPrimaryCekForCredential(opts: {
  credentialId: string
  kek: CryptoKey
  primaryHex: string
  saltHex?: string
}): Promise<BundleBody> {
  return wrapCekForCredential({
    credentialId: opts.credentialId,
    kek: opts.kek,
    cek: hexToBytes(opts.primaryHex),
    saltHex: opts.saltHex,
  })
}

/**
 * Convert a hex-encoded CEK to a raw Uint8Array. Exposed so call sites
 * (and `useSyncEnclaveSession`) can keep handling CEKs as hex strings
 * end-to-end without re-implementing hex parsing each time.
 */
export function cekHexToBytes(hex: string): Uint8Array {
  return hexToBytes(hex)
}

export function cekBytesToHex(bytes: Uint8Array): string {
  return bytesToHex(bytes)
}

/**
 * Derive the user's 16-byte key_id from their raw CEK via HKDF-SHA-256
 * with `info = "tinfoil-key-id-v1"` and an empty salt — matches the
 * enclave's `crypto.DeriveKeyID` byte-for-byte.
 */
export async function deriveKeyIdHex(cek: Uint8Array): Promise<string> {
  if (cek.length !== CEK_BYTES) {
    throw new Error(
      `key-bundle: CEK must be ${CEK_BYTES} bytes, got ${cek.length}`,
    )
  }
  const ikm = await crypto.subtle.importKey(
    'raw',
    cek as unknown as BufferSource,
    'HKDF',
    false,
    ['deriveBits'],
  )
  const enc = new TextEncoder()
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0) as unknown as BufferSource,
      info: enc.encode(KEY_ID_INFO) as unknown as BufferSource,
    },
    ikm,
    KEY_ID_BYTES * 8,
  )
  return bytesToHex(new Uint8Array(bits))
}
