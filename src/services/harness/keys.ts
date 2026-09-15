import { base64ToUint8Array, uint8ArrayToBase64 } from '@/utils/binary-codec'
import { harnessAPI } from './runtime'
import { HarnessError as SyncEnclaveError } from './sse'
export { SyncEnclaveError }
export interface OKResponse {
  ok: boolean
}
const bytesToB64 = uint8ArrayToBase64
const b64ToBytes = base64ToUint8Array
const keyClient = {
  post: <T>(
    path: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ) => harnessAPI().post<T>(path, body, signal, false),
}
export interface KeyRegisterBundleInput {
  credentialId: string
  /** AES-GCM IV, hex. */
  kekIvHex: string
  /** Wrapped CEK, hex. */
  encryptedKeysHex: string
}

export interface KeyRegisterRequest {
  /** Base64 raw 32-byte CEK. */
  keyB64: string
  /** Equivalent of If-Match for the user_keys row; "" for first register. */
  ifMatch: string
  /**
   * Origin label persisted on `user_keys.created_via`. The enclave
   * accepts only the four values listed here (see
   * `internal/server/ops.go::RegisterKey`).
   */
  createdVia: 'passkey' | 'manual' | 'recovery' | 'start_fresh'
  idempotencyKey: string
  /** Optional initial passkey bundle to register alongside the key. */
  initialBundle?: KeyRegisterBundleInput
}

export interface KeyRegisterResponse {
  ok: true
  key_id: string
}

export interface AddBundleRequest {
  keyId: string
  keyB64: string
  credentialId: string
  kekIvHex: string
  encryptedKeysHex: string
  /** Client-generated idempotency key, e.g. `newIdempotencyKey()`. */
  idempotencyKey: string
}

export interface RemoveBundleRequest {
  keyId: string
  keyB64: string
  credentialId: string
  /** Client-generated idempotency key, e.g. `newIdempotencyKey()`. */
  idempotencyKey: string
}

/**
 * Bundle entry shape returned by /v1/key/current. Mirrors the
 * controlplane `user_key_bundles` row layout (kek_iv + encrypted_keys
 * are hex strings on the wire).
 */
export interface KeyCurrentBundle {
  credential_id: string
  kek_iv: string
  encrypted_keys: string
  bundle_version?: number
  created_at?: string
  updated_at?: string
}

export interface KeyCurrentResponse {
  /** Hex-encoded current KeyID, or null if the user has no key yet. */
  key_id: string | null
  /**
   * Opaque etag the controlplane uses to gate concurrent register-key
   * mutations. Pass this back as `if_match` when rotating or running
   * the start-fresh wipe. Empty string when the user has no key yet.
   */
  etag?: string
  /** Map of credential_id → bundle body. Empty when key_id is null. */
  bundles: Record<string, KeyCurrentBundle>
  created_via?: 'passkey' | 'manual' | 'recovery' | 'start_fresh'
  created_at?: string
  /**
   * Whether the user owns encrypted blobs not sealed under the reported
   * key. When `key_id` is null this means legacy (key_id IS NULL) data
   * exists, so the client should route to recovery rather than offering
   * first-time setup. Absent on older enclaves (treated as false).
   */
  has_data?: boolean
}

export async function registerKey(
  req: KeyRegisterRequest,
): Promise<KeyRegisterResponse> {
  const client = keyClient
  const body: Record<string, unknown> = {
    key: req.keyB64,
    if_match: req.ifMatch,
    created_via: req.createdVia,
    idempotency_key: req.idempotencyKey,
  }
  if (req.initialBundle) {
    body.initial_bundle = {
      credential_id: req.initialBundle.credentialId,
      kek_iv: req.initialBundle.kekIvHex,
      encrypted_keys: req.initialBundle.encryptedKeysHex,
    }
  }
  return client.post<KeyRegisterResponse>('/v1/keys/register', body)
}

export async function addBundle(req: AddBundleRequest): Promise<OKResponse> {
  const client = keyClient
  return client.post<OKResponse>('/v1/keys/add-bundle', {
    key_id: req.keyId,
    key: req.keyB64,
    credential_id: req.credentialId,
    kek_iv: req.kekIvHex,
    encrypted_keys: req.encryptedKeysHex,
    idempotency_key: req.idempotencyKey,
  })
}

/**
 * Revoke a passkey bundle from the current key. Maps to
 * DELETE /api/keys/:keyId/bundles/:credentialId on the controlplane.
 */
export async function removeBundle(
  req: RemoveBundleRequest,
): Promise<OKResponse> {
  const client = keyClient
  return client.post<OKResponse>('/v1/keys/remove-bundle', {
    key_id: req.keyId,
    key: req.keyB64,
    credential_id: req.credentialId,
    idempotency_key: req.idempotencyKey,
  })
}

/**
 * Fetch the current key id and the full set of passkey bundles
 * registered for the authenticated user. Returns `{ key_id: null,
 * bundles: {} }` when the user has no key yet (HTTP 404 from the
 * enclave is mapped to this empty shape so callers can treat it as a
 * normal "first-time user" state without special-casing exceptions).
 */
export async function keyCurrent(
  signal?: AbortSignal,
): Promise<KeyCurrentResponse> {
  signal?.throwIfAborted()
  const client = keyClient
  try {
    const resp = signal
      ? await client.post<KeyCurrentResponse>('/v1/keys/current', {}, signal)
      : await client.post<KeyCurrentResponse>('/v1/keys/current', {})
    // The server is a Go service; a nil bundle map marshals to JSON
    // null. Normalize so callers can Object.values/index the map
    // without crashing on edge shapes (e.g. a key registered via
    // migrate-all bootstrap before any bundle exists).
    return { ...resp, key_id: resp.key_id ?? null, bundles: resp.bundles ?? {} }
  } catch (err) {
    if (err instanceof SyncEnclaveError && err.status === 404) {
      return { key_id: null, bundles: {}, has_data: false }
    }
    throw err
  }
}

export function hexToB64(hex: string): string {
  if (hex.length === 0) throw new Error('sync-api: empty hex')
  if (hex.length % 2 !== 0) throw new Error('sync-api: odd-length hex')
  // `parseInt` accepts non-hex characters (returning NaN) and
  // assigning NaN to a Uint8Array cell silently coerces to 0. Without
  // this guard a CEK string containing any non-hex char would be
  // converted to a zero-byte buffer and used to encrypt user data
  // under what is effectively a known constant key.
  if (!/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error('sync-api: invalid hex')
  }
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16)
  }
  return bytesToB64(bytes)
}

export function bytesToBase64(b: Uint8Array): string {
  return bytesToB64(b)
}

export function base64ToBytes(s: string): Uint8Array {
  return b64ToBytes(s)
}

/**
 * Mint a fresh idempotency key for one logical enclave write. The key
 * MUST be reused across every HTTP retry of the same logical write
 * (§9.6 R1) and refreshed when the caller has a new logical write to
 * perform. Format is 32 lowercase hex characters — a UUID-equivalent
 * 128 bits drawn from `crypto.getRandomValues`.
 */
export function newIdempotencyKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0')
  }
  return out
}
