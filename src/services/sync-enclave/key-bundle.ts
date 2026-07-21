/**
 * Wrap / unwrap the user's content encryption key (CEK) under a
 * passkey-PRF-derived KEK, in the shape the sync enclave expects.
 *
 * The enclave wire format (BundleBody in sync-api.ts) carries one
 * wrapped CEK per registered passkey
 * credential. There is no list of "alternative" keys: the enclave is
 * the single source of truth, and legacy alternatives are left to
 * Phase 4 opportunistic migration.
 */

import {
  bytesToHex,
  deriveKeyId,
  hexToBytes,
  unwrapCek,
  wrapCek,
} from '@tinfoilsh/passkey-kit'

/**
 * Local-only descriptor for a wrapped CEK + the bookkeeping needed
 * to unwrap it later. This is NOT the on-wire shape — see
 * `sync-api.KeyRegisterBundleInput` and `AddBundleRequest` for the
 * fields the enclave actually persists.
 */
export interface BundleBody {
  credentialId: string
  /** 12-byte AES-GCM IV, hex-encoded. */
  kekIvHex: string
  /** Wrapped CEK ciphertext, hex-encoded. */
  wrappedKeyHex: string
  /** Salt used by HKDF over the PRF output. Kept locally for debug. */
  saltHex: string
  /** Free-form descriptor (e.g. PRF info string). */
  info?: string
}

const BUNDLE_INFO = 'tinfoil-chat-kek-v1'
const KEY_ID_INFO = 'tinfoil-key-id-v1'

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
  const wrapped = await wrapCek({
    credentialId: opts.credentialId,
    kek: opts.kek,
    cek: opts.cek,
  })
  return {
    credentialId: wrapped.credentialId,
    kekIvHex: wrapped.kekIvHex,
    wrappedKeyHex: wrapped.wrappedKeyHex,
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
  return unwrapCek(kek, { kekIvHex: ivHex, wrappedKeyHex: ctHex })
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
  return bytesToHex(await deriveKeyId(cek, { info: KEY_ID_INFO }))
}
