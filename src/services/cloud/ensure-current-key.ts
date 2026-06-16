/**
 * Single source of truth for adopting the local primary CEK as the
 * controlplane's registered current key.
 *
 * Adoption is a hard precondition of every cloud write: the
 * controlplane rejects a push with STALE_KEY until a `user_keys` row
 * exists. Historically only the out-of-band migration kick adopted a
 * legacy v1→v2 user's key, so a missed kick wedged the account in a
 * STALE_KEY storm with no self-heal. Both the write gate
 * (`canWriteToCloud`) and the migration kick route adoption through
 * here, so the write path can establish the precondition it depends
 * on instead of optimistically storming the controlplane.
 */

import { logError, logInfo, logWarning } from '@/utils/error-handling'
import { loadPasskeyCredentials } from '../passkey/passkey-key-storage'
import {
  deriveKeyEncryptionKey,
  getCachedPrfResult,
} from '../passkey/passkey-service'
import { wrapCekForCredential } from '../sync-enclave/key-bundle'
import { passkeyEvents } from '../sync-enclave/passkey-events'
import {
  newIdempotencyKey,
  registerKey,
  type KeyRegisterBundleInput,
} from '../sync-enclave/sync-api'
import { IF_MATCH_SENTINELS } from '../sync-enclave/wire-contract'
import {
  persistedPrimaryKeyB64,
  requirePrimaryKeyB64,
  requirePrimaryKeyBytes,
} from './cek-encoding'

let inflightAdoption: { keyB64: string; promise: Promise<boolean> } | null =
  null

/**
 * Drop any in-flight adoption registration. Called on logout / auth
 * change so a registration started for the previous user can never be
 * handed back to the next session. The per-key dedupe guard already
 * prevents reuse across different keys, but a registration that never
 * settles (network hang) would otherwise pin a stale promise.
 */
export function resetInflightAdoption(): void {
  inflightAdoption = null
}

/**
 * Register the local primary CEK as the controlplane's current key for
 * a user who has legacy data but no registered key. Without this a
 * v1→v2 user who never registered their key — they have no passkey, or
 * only an un-promoted legacy passkey — could never migrate: nothing
 * registers their CEK, so every rewrap is gated out.
 *
 * Registered with created_via='recovery', which the controlplane
 * accepts non-destructively over legacy (key_id NULL) rows. When this
 * device holds a cached passkey PRF for a credential still on the
 * user's account, the CEK is wrapped under it and registered with an
 * initial bundle so the adopted key is passkey-recoverable from day
 * one; otherwise it is registered bundleless and a legacy passkey
 * wrapping this same CEK stays promotable afterwards (its bundle is
 * added on the next recovery), so adopting never strands a backup.
 * register-key's if_match='*' fails safely on a concurrent register.
 * Returns true when the key was adopted.
 *
 * Only the committed primary key is ever registered, and only when it
 * matches the active in-memory CEK. During a key-activation ceremony
 * the new key is staged in memory only; registering a staged
 * (uncommitted) key — or binding the committed key while writes encrypt
 * under the staged one — would point the server at a key the client may
 * roll back or that the upload won't use, causing a key mismatch and
 * blocked writes. Defer until the staged key commits or the ceremony
 * rolls back, so the registered key and the write key always agree.
 */
export async function adoptLocalKeyForMigration(): Promise<boolean> {
  const keyB64 = persistedPrimaryKeyB64()
  if (!keyB64) return false
  let activeKeyB64: string
  try {
    activeKeyB64 = requirePrimaryKeyB64()
  } catch {
    return false
  }
  if (activeKeyB64 !== keyB64) return false
  // Dedupe concurrent adoptions per key. The upload coalescer fires the
  // write gate for many chats at once; without this they would each
  // race a register-key, and every loser of the if_match='*' CAS would
  // defer its push. Sharing one in-flight registration lets the whole
  // batch proceed the moment the single winner lands. A different key
  // (e.g. after the user changes it) gets its own registration.
  if (inflightAdoption?.keyB64 === keyB64) {
    return inflightAdoption.promise
  }
  const entry: { keyB64: string; promise: Promise<boolean> } = {
    keyB64,
    promise: Promise.resolve(false),
  }
  entry.promise = (async () => {
    try {
      return await registerAdoptedKey(keyB64)
    } finally {
      if (inflightAdoption === entry) {
        inflightAdoption = null
      }
    }
  })()
  inflightAdoption = entry
  return entry.promise
}

async function registerAdoptedKey(keyB64: string): Promise<boolean> {
  const initialBundle = await initialBundleFromCachedPrf()
  try {
    await registerKey({
      keyB64,
      ifMatch: IF_MATCH_SENTINELS.AnyKey,
      createdVia: 'recovery',
      idempotencyKey: newIdempotencyKey(),
      ...(initialBundle ? { initialBundle } : {}),
    })
  } catch (err) {
    logError('Failed to adopt local key for migration', err, {
      component: 'CloudSync',
      action: 'adoptLocalKeyForMigration',
    })
    return false
  }
  logInfo('Adopted local key as current to enable migration', {
    component: 'CloudSync',
    action: 'adoptLocalKeyForMigration',
    metadata: { withInitialBundle: initialBundle != null },
  })
  passkeyEvents.emit({ type: 'bundle-state-maybe-changed' })
  return true
}

/**
 * Best-effort initial bundle for key adoption: wrap the CEK being
 * registered under the KEK derived from this device's cached passkey
 * PRF. Adoption must never be blocked by bundle problems, so every
 * failure path returns null and the caller registers bundleless.
 *
 * The cached credential is only trusted when it still appears in the
 * user's stored credentials — a stale cache (passkey deleted or
 * re-created) must not attach an unopenable bundle, which would make
 * the account look passkey-recoverable when it is not.
 */
async function initialBundleFromCachedPrf(): Promise<KeyRegisterBundleInput | null> {
  try {
    const cached = getCachedPrfResult()
    if (!cached) return null
    const entries = await loadPasskeyCredentials()
    if (!entries.some((e) => e.id === cached.credentialId)) return null
    const kek = await deriveKeyEncryptionKey(cached.prfOutput)
    const bundle = await wrapCekForCredential({
      credentialId: cached.credentialId,
      kek,
      cek: requirePrimaryKeyBytes(),
    })
    return {
      credentialId: bundle.credentialId,
      kekIvHex: bundle.kekIvHex,
      encryptedKeysHex: bundle.wrappedKeyHex,
    }
  } catch (err) {
    logWarning('Could not build initial bundle for key adoption', {
      component: 'CloudSync',
      action: 'initialBundleFromCachedPrf',
      metadata: { error: err instanceof Error ? err.message : String(err) },
    })
    return null
  }
}
