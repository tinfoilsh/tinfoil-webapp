/**
 * High-level passkey + sync-enclave glue used by the
 * `usePasskeyBackup` hook.
 *
 * The enclave wire (see `internal/server/types.go`) exposes only
 * `register-key` and `add-bundle` for key management. There is no
 * "list bundles" endpoint, so this layer's contract is:
 *
 *   - registerNewKeyWithPasskey: create a passkey, generate a fresh
 *     CEK, wrap it under the passkey-PRF KEK, register the key +
 *     initial bundle with the enclave. Treats a 409 from the enclave
 *     as "remote key already exists, fall through to unlock".
 *
 *   - unlockWithPasskey: authenticate a passkey, derive the KEK,
 *     unwrap a bundle that the caller already has on hand (e.g. one
 *     passed in via a previously-cached PRF probe, or one received
 *     by the consumer through an out-of-band channel).
 *
 *   - addBundleForCurrentKey: enroll a brand-new passkey for an
 *     existing key (multi-device flow).
 *
 * Each returns either a success record carrying the raw CEK +
 * key_id + credential_id, or a typed failure so the hook can drive
 * its state machine.
 *
 * The CEK is held only in memory and zeroed by callers when the
 * session ends. localStorage is never deleted by these helpers; the
 * hook is responsible for cleanup.
 */

import {
  authenticatePrfPasskey,
  createPrfPasskey,
  deriveKeyEncryptionKey,
  type PrfPasskeyResult,
} from '@/services/passkey/passkey-service'
import { logError, logInfo } from '@/utils/error-handling'

import {
  cekBytesToHex,
  cekHexToBytes,
  deriveKeyIdHex,
  unwrapCekFromBundle,
  wrapCekForCredential,
  type BundleBody,
} from './key-bundle'
import {
  SyncEnclaveError,
  b64ToHex,
  addBundle as enclaveAddBundle,
  keyCurrent as enclaveKeyCurrent,
  registerKey as enclaveRegisterKey,
  hexToB64,
  type KeyCurrentResponse,
} from './sync-api'

export type PasskeyFlowFailure =
  | 'user_cancelled'
  | 'prf_unsupported'
  | 'no_remote_bundle'
  | 'no_remote_key'
  | 'bundle_decrypt_failed'
  | 'register_failed'
  | 'enclave_unavailable'
  | 'remote_key_exists'
  | 'key_id_mismatch'

export interface PasskeyFlowSuccess {
  ok: true
  cekHex: string
  keyIdHex: string
  credentialId: string
}

export interface PasskeyFlowError {
  ok: false
  reason: PasskeyFlowFailure
  cause?: unknown
}

export type PasskeyFlowResult = PasskeyFlowSuccess | PasskeyFlowError

export interface PasskeyUserInfo {
  userId: string
  userName: string
  displayName: string
}

type CreatedVia = 'passkey' | 'manual' | 'recovery' | 'start_fresh'

function randomIdempotencyKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0')
  }
  return out
}

function failureFromPasskeyError(err: unknown): PasskeyFlowFailure {
  if (!err || typeof err !== 'object') return 'user_cancelled'
  const name = (err as { name?: string }).name
  if (name === 'PrfNotSupportedError') return 'prf_unsupported'
  if (name === 'PasskeyTimeoutError') return 'prf_unsupported'
  return 'user_cancelled'
}

function failureFromEnclaveError(err: unknown): PasskeyFlowFailure {
  if (err instanceof SyncEnclaveError) {
    if (err.code === 'EXISTING_DATA_UNDER_OTHER_KEY' || err.status === 409) {
      return 'remote_key_exists'
    }
    if (err.status && err.status >= 500) return 'enclave_unavailable'
    return 'register_failed'
  }
  return 'enclave_unavailable'
}

/* -------------------------------------------------------------------------- */
/*  Brand-new user / register key with passkey                                */
/* -------------------------------------------------------------------------- */

export async function registerNewKeyWithPasskey(opts: {
  user: PasskeyUserInfo
  startFresh?: boolean
  createdVia?: CreatedVia
}): Promise<PasskeyFlowResult> {
  let passkey: PrfPasskeyResult | null
  try {
    passkey = await createPrfPasskey(
      opts.user.userId,
      opts.user.userName,
      opts.user.displayName,
    )
  } catch (err) {
    return { ok: false, reason: failureFromPasskeyError(err), cause: err }
  }
  if (!passkey) return { ok: false, reason: 'user_cancelled' }

  const cek = crypto.getRandomValues(new Uint8Array(32))
  const cekHex = cekBytesToHex(cek)
  const keyIdHex = await deriveKeyIdHex(cek)

  const kek = await deriveKeyEncryptionKey(passkey.prfOutput)
  const bundle = await wrapCekForCredential({
    credentialId: passkey.credentialId,
    kek,
    cek,
  })

  try {
    await enclaveRegisterKey({
      keyB64: hexToB64(cekHex),
      ifMatch: opts.startFresh ? '*' : '*',
      createdVia: opts.createdVia ?? 'passkey',
      idempotencyKey: randomIdempotencyKey(),
      initialBundle: {
        credentialId: bundle.credentialId,
        kekIvHex: bundle.kekIvHex,
        encryptedKeysHex: bundle.wrappedKeyHex,
      },
    })
  } catch (err) {
    logError(
      'enclave registerKey failed for new-user flow',
      err instanceof Error ? err : new Error(String(err)),
      { component: 'passkey-key-flow', action: 'registerNewKeyWithPasskey' },
    )
    return { ok: false, reason: failureFromEnclaveError(err), cause: err }
  }

  logInfo('registered new sync enclave key', {
    component: 'passkey-key-flow',
    action: 'registerNewKeyWithPasskey',
    metadata: { keyIdHex, credentialId: passkey.credentialId },
  })
  return {
    ok: true,
    cekHex,
    keyIdHex,
    credentialId: passkey.credentialId,
  }
}

/* -------------------------------------------------------------------------- */
/*  Returning user / unlock with a remote bundle                              */
/* -------------------------------------------------------------------------- */

/**
 * Recover the user's CEK by re-authenticating their passkey and
 * unwrapping a bundle the caller already has on hand.
 *
 * The caller supplies the candidate bundle(s) — typically obtained
 * out-of-band when the consumer (passkey hook) loaded them from
 * `passkey-key-storage` during the migration window, or when a
 * second device received them via `add-bundle`.
 */
export async function unlockWithPasskey(opts: {
  /** Bundles the caller wants to try, keyed by credential_id. */
  candidates: BundleBody[]
  /** Optional hint for which credential id to authenticate first. */
  prefer?: string
}): Promise<PasskeyFlowResult> {
  if (opts.candidates.length === 0) {
    return { ok: false, reason: 'no_remote_bundle' }
  }
  const credIds = opts.candidates.map((c) => c.credentialId)
  const ordered = opts.prefer
    ? [opts.prefer, ...credIds.filter((c) => c !== opts.prefer)]
    : credIds

  let passkey: PrfPasskeyResult | null
  try {
    passkey = await authenticatePrfPasskey(ordered)
  } catch (err) {
    return { ok: false, reason: failureFromPasskeyError(err), cause: err }
  }
  if (!passkey) return { ok: false, reason: 'user_cancelled' }

  const remote = opts.candidates.find(
    (c) => c.credentialId === passkey!.credentialId,
  )
  if (!remote) return { ok: false, reason: 'no_remote_bundle' }

  let cek: Uint8Array
  try {
    const kek = await deriveKeyEncryptionKey(passkey.prfOutput)
    cek = await unwrapCekFromBundle(kek, remote)
  } catch (err) {
    logError(
      'failed to decrypt sync enclave bundle',
      err instanceof Error ? err : new Error(String(err)),
      { component: 'passkey-key-flow', action: 'unlockWithPasskey' },
    )
    return { ok: false, reason: 'bundle_decrypt_failed', cause: err }
  }

  const keyIdHex = await deriveKeyIdHex(cek)
  return {
    ok: true,
    cekHex: cekBytesToHex(cek),
    keyIdHex,
    credentialId: passkey.credentialId,
  }
}

/* -------------------------------------------------------------------------- */
/*  Add another device's bundle                                               */
/* -------------------------------------------------------------------------- */

export async function addBundleForCurrentKey(opts: {
  cekHex: string
  keyIdHex: string
  user: PasskeyUserInfo
}): Promise<PasskeyFlowResult> {
  let passkey: PrfPasskeyResult | null
  try {
    passkey = await createPrfPasskey(
      opts.user.userId,
      opts.user.userName,
      opts.user.displayName,
    )
  } catch (err) {
    return { ok: false, reason: failureFromPasskeyError(err), cause: err }
  }
  if (!passkey) return { ok: false, reason: 'user_cancelled' }

  const kek = await deriveKeyEncryptionKey(passkey.prfOutput)
  const bundle = await wrapCekForCredential({
    credentialId: passkey.credentialId,
    kek,
    cek: cekHexToBytes(opts.cekHex),
  })

  try {
    await enclaveAddBundle({
      keyId: opts.keyIdHex,
      credentialId: bundle.credentialId,
      kekIvHex: bundle.kekIvHex,
      encryptedKeysHex: bundle.wrappedKeyHex,
    })
  } catch (err) {
    return { ok: false, reason: failureFromEnclaveError(err), cause: err }
  }
  return {
    ok: true,
    cekHex: opts.cekHex,
    keyIdHex: opts.keyIdHex,
    credentialId: passkey.credentialId,
  }
}

/* -------------------------------------------------------------------------- */
/*  Server state probe + end-to-end unlock                                    */
/* -------------------------------------------------------------------------- */

/**
 * Re-shape the enclave's `/v1/key/current` response into a list of
 * BundleBody candidates suitable for `unlockWithPasskey`. The wire
 * carries kek_iv / encrypted_keys as base64; BundleBody expects hex.
 */
export function bundlesFromKeyCurrent(resp: KeyCurrentResponse): BundleBody[] {
  return Object.values(resp.bundles).map((b) => ({
    credentialId: b.credential_id,
    kekIvHex: b64ToHex(b.kek_iv),
    wrappedKeyHex: b64ToHex(b.encrypted_keys),
    saltHex: '',
    info: 'tinfoil-chat-kek-v1',
  }))
}

/**
 * Probe the server for the current key id + bundles. Returns
 * `{ status: 'empty' }` when the user has no key registered yet, or
 * `{ status: 'exists', keyIdHex, candidates }` otherwise.
 */
export async function fetchServerKeyState(): Promise<
  | { status: 'empty' }
  | {
      status: 'exists'
      keyIdHex: string
      candidates: BundleBody[]
      createdVia?: 'passkey' | 'manual' | 'recovery' | 'start_fresh'
    }
> {
  const resp = await enclaveKeyCurrent()
  if (!resp.key_id) {
    return { status: 'empty' }
  }
  return {
    status: 'exists',
    keyIdHex: resp.key_id,
    candidates: bundlesFromKeyCurrent(resp),
    createdVia: resp.created_via,
  }
}

/**
 * End-to-end "returning user" unlock against the enclave. Wraps the
 * key-current probe + unlockWithPasskey + KeyID binding check into a
 * single call the hook can invoke without juggling intermediate state.
 */
export async function unlockFromServer(opts?: {
  prefer?: string
}): Promise<PasskeyFlowResult> {
  let state: Awaited<ReturnType<typeof fetchServerKeyState>>
  try {
    state = await fetchServerKeyState()
  } catch (err) {
    return { ok: false, reason: failureFromEnclaveError(err), cause: err }
  }
  if (state.status === 'empty') {
    return { ok: false, reason: 'no_remote_key' }
  }
  const result = await unlockWithPasskey({
    candidates: state.candidates,
    prefer: opts?.prefer,
  })
  if (!result.ok) return result

  // §8.6 binding check — the bundle plaintext carries the key_id the
  // ciphertext was wrapped against. The enclave's reported key_id MUST
  // match the derived id, or the bundle is talking about a different
  // key.
  if (result.keyIdHex !== state.keyIdHex) {
    return {
      ok: false,
      reason: 'key_id_mismatch',
      cause: new Error(
        `keyIdHex ${result.keyIdHex} != enclave ${state.keyIdHex}`,
      ),
    }
  }
  return result
}
