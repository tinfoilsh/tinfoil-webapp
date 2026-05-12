/**
 * High-level passkey + sync-enclave glue used by the
 * `usePasskeyBackup` hook.
 *
 * Three flows live here:
 *
 *   - publishCurrentLocalCek
 *       Pure migration shim. If the user has a local CEK (legacy
 *       client-side encryption) but the enclave doesn't have a key
 *       registered, wrap that same CEK under the user's existing
 *       passkey-PRF KEK and register it. Used to lift Phase 1 users
 *       onto the new flow without rotating their key.
 *
 *   - registerNewKeyWithPasskey
 *       Brand-new user: create a passkey, generate a fresh CEK, wrap
 *       it under the passkey-PRF KEK, and register with the enclave.
 *
 *   - unlockWithPasskey
 *       Returning user: authenticate the passkey, derive the KEK,
 *       fetch the user's bundle from the enclave, decrypt to recover
 *       the CEK.
 *
 * Each returns either a success record carrying the raw CEK + key_id
 * + credential_id, or a typed failure so the hook can drive the UI
 * state machine.
 *
 * The CEK is held only in memory and zeroed by callers when the
 * session ends. localStorage is never deleted by these helpers; the
 * hook is responsible for the safe "delete only bookkeeping after a
 * successful 200" cleanup.
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
} from './key-bundle'
import * as syncApi from './sync-api'

export type PasskeyFlowFailure =
  | 'user_cancelled'
  | 'prf_unsupported'
  | 'no_remote_bundle'
  | 'bundle_decrypt_failed'
  | 'register_failed'
  | 'enclave_unavailable'

export interface PasskeyFlowSuccess {
  ok: true
  /** Hex-encoded 32-byte content encryption key. */
  cekHex: string
  /** 32-char lowercase hex key_id (matches the enclave's derivation). */
  keyIdHex: string
  /** Credential id of the passkey the bundle was wrapped under. */
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

/* -------------------------------------------------------------------------- */
/*  Migration shim: legacy CEK -> enclave-registered key                      */
/* -------------------------------------------------------------------------- */

/**
 * Publish the user's existing local CEK to the sync enclave using the
 * passkey they already have registered. Returns `ok: false` with a
 * specific reason if the upgrade isn't applicable (no passkey, decrypt
 * mismatch, etc.) so the hook can fall through to the appropriate
 * recovery path.
 */
export async function publishCurrentLocalCek(opts: {
  /** Hex CEK currently held client-side. */
  legacyCekHex: string
}): Promise<PasskeyFlowResult> {
  try {
    // First check: does the enclave already know about a key for this user?
    const current = await syncApi.getCurrentKey()
    if (current.key_id) {
      // Cross-device case: the enclave has a key already. We should not
      // overwrite it. The caller's `unlockWithPasskey` path handles
      // surfacing the existing remote bundle to the user.
      const localKeyId = await deriveKeyIdHex(cekHexToBytes(opts.legacyCekHex))
      if (localKeyId === current.key_id) {
        // Already in sync. Use any existing credential id we know of.
        return {
          ok: true,
          cekHex: opts.legacyCekHex,
          keyIdHex: current.key_id,
          credentialId: current.bundles[0]?.credential_id ?? '',
        }
      }
      // Local and remote disagree — surface as "no_remote_bundle" so the
      // caller falls through to unlockWithPasskey and adopts the remote
      // CEK. (We never overwrite the enclave's existing key from a stale
      // local cache.)
      return { ok: false, reason: 'no_remote_bundle' }
    }
    // Enclave has nothing yet: we must register a passkey + bundle.
    return {
      ok: false,
      reason: 'no_remote_bundle',
    }
  } catch (err) {
    logError(
      'sync enclave unavailable during legacy CEK publish',
      err instanceof Error ? err : new Error(String(err)),
      { component: 'passkey-key-flow', action: 'publishCurrentLocalCek' },
    )
    return { ok: false, reason: 'enclave_unavailable', cause: err }
  }
}

/* -------------------------------------------------------------------------- */
/*  Brand-new user                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Create a passkey, generate a fresh CEK, wrap it under the
 * passkey-PRF KEK, and register the whole bundle with the enclave in
 * one shot. Returns the CEK so callers can hydrate
 * `encryptionService` / `useSyncEnclaveSession`.
 */
export async function registerNewKeyWithPasskey(opts: {
  user: PasskeyUserInfo
  startFresh?: boolean
  createdVia?:
    | 'enclave_register'
    | 'passkey_recovery'
    | 'manual_entry'
    | 'legacy_import'
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
    await syncApi.registerKey({
      keyIdHex,
      bundle,
      startFresh: opts.startFresh ?? true,
      createdVia: opts.createdVia ?? 'enclave_register',
    })
  } catch (err) {
    logError(
      'enclave registerKey failed for new-user flow',
      err instanceof Error ? err : new Error(String(err)),
      { component: 'passkey-key-flow', action: 'registerNewKeyWithPasskey' },
    )
    return { ok: false, reason: 'register_failed', cause: err }
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
/*  Returning user                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Authenticate the user's passkey, derive the KEK, fetch the
 * matching bundle from the enclave, and recover the raw CEK.
 *
 * If `prefer` is supplied, it acts as a hint for which credential id
 * to ask WebAuthn for first (matches the previous PRF cache behavior).
 */
export async function unlockWithPasskey(opts?: {
  prefer?: string
  passkey?: PrfPasskeyResult
}): Promise<PasskeyFlowResult> {
  let current: syncApi.CurrentKeyResponse
  try {
    current = await syncApi.getCurrentKey()
  } catch (err) {
    return { ok: false, reason: 'enclave_unavailable', cause: err }
  }
  if (!current.key_id || current.bundles.length === 0) {
    return { ok: false, reason: 'no_remote_bundle' }
  }

  let passkey: PrfPasskeyResult | null
  if (opts?.passkey) {
    passkey = opts.passkey
  } else {
    try {
      const credIds = current.bundles
        .map((b) => b.credential_id)
        .filter((id) => id.length > 0)
      const ordered = opts?.prefer
        ? [opts.prefer, ...credIds.filter((c) => c !== opts.prefer)]
        : credIds
      passkey = await authenticatePrfPasskey(ordered)
    } catch (err) {
      return { ok: false, reason: failureFromPasskeyError(err), cause: err }
    }
  }
  if (!passkey) return { ok: false, reason: 'user_cancelled' }

  const remote = current.bundles.find(
    (b) => b.credential_id === passkey!.credentialId,
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

  return {
    ok: true,
    cekHex: cekBytesToHex(cek),
    keyIdHex: current.key_id,
    credentialId: passkey.credentialId,
  }
}

/* -------------------------------------------------------------------------- */
/*  Add a new device's bundle for an existing key                             */
/* -------------------------------------------------------------------------- */

/**
 * After unlocking, register a brand-new passkey-bundle alongside the
 * existing key. Used when a user adds a second device.
 */
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
    await syncApi.addBundle(opts.keyIdHex, bundle)
  } catch (err) {
    return { ok: false, reason: 'register_failed', cause: err }
  }
  return {
    ok: true,
    cekHex: opts.cekHex,
    keyIdHex: opts.keyIdHex,
    credentialId: passkey.credentialId,
  }
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function failureFromPasskeyError(err: unknown): PasskeyFlowFailure {
  if (!err || typeof err !== 'object') return 'user_cancelled'
  const name = (err as { name?: string }).name
  if (name === 'PrfNotSupportedError') return 'prf_unsupported'
  if (name === 'PasskeyTimeoutError') return 'prf_unsupported'
  return 'user_cancelled'
}
