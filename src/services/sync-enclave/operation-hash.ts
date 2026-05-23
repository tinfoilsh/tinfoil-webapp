/**
 * Operation-hash construction for the sync enclave.
 *
 * Matches syncplan.md §7.0 byte-for-byte with the Go reference
 * implementation at confidential-sync-enclave/internal/crypto/ophash.go.
 *
 *   K_op = HKDF-SHA-256(IKM=CEK, salt="", info="tinfoil-op-hash-v1", L=32)
 *   X-Operation-Hash = hex(HMAC-SHA-256(K_op, canonical))
 *
 * The canonical input is a length-prefixed concatenation of
 * (METHOD, PATH, KEY_ID_HEX, IF_MATCH, IDEMPOTENCY_KEY, BODY) with
 * lengths encoded as big-endian uint32. See AppendCanonical below.
 *
 * The controlplane stores X-Operation-Hash for idempotency and sits
 * inside the threat boundary; a plain SHA-256(plaintext) would let the
 * controlplane brute-force the low-entropy plaintexts that profile
 * blobs and short chat prompts produce. HMAC under a CEK-derived
 * subkey closes that hole because the controlplane never sees K_op.
 */

const HKDF_INFO = new TextEncoder().encode('tinfoil-op-hash-v1')
const HKDF_INFO_BYTES = Object.freeze(Array.from(HKDF_INFO))
const OP_HASH_KEY_BYTES = 32
const CEK_BYTES = 32

export interface OperationCanonicalInput {
  /** Uppercase HTTP method, e.g. "PUT" / "POST" / "DELETE". */
  method: string
  /** Request path (no scheme/host), including any query string. */
  path: string
  /** 32-char lowercase hex key id. */
  keyIdHex: string
  /**
   * Decimal etag string, or the literal If-Match header value
   * ("0" for create, "*" or a hex key id for register-key).
   */
  ifMatch: string
  /** Client-chosen idempotency key (UUID/ULID). */
  idempotencyKey: string
  /** Raw request body bytes; empty for bodyless requests. */
  body: Uint8Array
}

/**
 * Derives the operation-hash subkey K_op from the user's CEK. The
 * returned CryptoKey is HMAC-only and non-extractable; callers cannot
 * accidentally use it for anything else.
 *
 * Throws on incorrectly-sized CEKs to fail closed.
 */
export async function deriveOpHashKey(cek: Uint8Array): Promise<CryptoKey> {
  if (cek.length !== CEK_BYTES) {
    throw new Error(
      `operation-hash: CEK must be ${CEK_BYTES} bytes, got ${cek.length}`,
    )
  }

  const ikm = await crypto.subtle.importKey(
    'raw',
    cek as unknown as BufferSource,
    'HKDF',
    false,
    ['deriveBits'],
  )
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0) as unknown as BufferSource,
      info: HKDF_INFO as unknown as BufferSource,
    },
    ikm,
    OP_HASH_KEY_BYTES * 8,
  )
  return crypto.subtle.importKey(
    'raw',
    bits,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
}

/**
 * Serializes the canonical tuple per §7.0. Each field is preceded by
 * its byte length as a big-endian uint32. This MUST match the Go
 * AppendCanonical encoding exactly.
 */
export function buildCanonical(input: OperationCanonicalInput): Uint8Array {
  const enc = new TextEncoder()
  const parts: Uint8Array[] = [
    enc.encode(input.method),
    enc.encode(input.path),
    enc.encode(input.keyIdHex),
    enc.encode(input.ifMatch),
    enc.encode(input.idempotencyKey),
    input.body,
  ]
  let totalLen = 0
  for (const p of parts) totalLen += 4 + p.length
  const out = new Uint8Array(totalLen)
  const view = new DataView(out.buffer)
  let off = 0
  for (const p of parts) {
    view.setUint32(off, p.length, false /* bigEndian */)
    off += 4
    out.set(p, off)
    off += p.length
  }
  return out
}

/**
 * Computes the hex-encoded HMAC for the canonical tuple under the
 * given subkey. Use {@link deriveOpHashKey} once per session and reuse
 * the returned CryptoKey across operations.
 */
export async function computeOperationHash(
  opKey: CryptoKey,
  input: OperationCanonicalInput,
): Promise<string> {
  const canonical = buildCanonical(input)
  const sig = await crypto.subtle.sign(
    'HMAC',
    opKey,
    canonical as unknown as BufferSource,
  )
  return uint8ArrayToHex(new Uint8Array(sig))
}

/**
 * Convenience: derive + sign in one call. Prefer the two-step variant
 * when the same CEK is used for many operations so HKDF is only run
 * once per session.
 */
export async function operationHashForCek(
  cek: Uint8Array,
  input: OperationCanonicalInput,
): Promise<string> {
  const opKey = await deriveOpHashKey(cek)
  return computeOperationHash(opKey, input)
}

function uint8ArrayToHex(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i].toString(16).padStart(2, '0')
  }
  return s
}

// Re-exported so consumers don't need to grab the helper from elsewhere.
export const __test = { HKDF_INFO_BYTES, OP_HASH_KEY_BYTES, CEK_BYTES }
