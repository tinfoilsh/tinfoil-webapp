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

import {
  AUTH_ACTIVE_USER_ID,
  LEGACY_ENCRYPTION_KEY,
  LEGACY_ENCRYPTION_KEY_HISTORY,
  SECRET_CLOUD_KEY_AUTHORIZATION_PREFIX,
  USER_ENCRYPTION_KEY,
  USER_ENCRYPTION_KEY_HISTORY,
} from '@/constants/storage-keys'
import { logError, logInfo, logWarning } from '@/utils/error-handling'
import { encryptionService } from '../encryption/encryption-service'
import { passkeyKeyManager } from '../passkey/kit'
import {
  loadPasskeyCredentials,
  tinfoilWrappedKeyBundleToEnclave,
  wrapTinfoilKeyBundle,
  type KeyBundle,
} from '../passkey/passkey-key-storage'
import { passkeyEvents } from '../sync-enclave/passkey-events'
import {
  addBundle,
  base64ToBytes,
  bytesToBase64,
  keyCurrent,
  newIdempotencyKey,
  registerKey,
  type KeyCurrentResponse,
  type KeyRegisterBundleInput,
} from '../sync-enclave/sync-api'
import { deriveTinfoilKeyIdHex } from '../sync-enclave/tinfoil-key-id'
import { IF_MATCH_SENTINELS } from '../sync-enclave/wire-contract'
import { requirePrimaryKeyB64 } from './cek-encoding'
import type { CloudKeyAuthorizationMode } from './cloud-key-authorization'

/** Bounds best-effort legacy passkey discovery during key adoption. */
export const ADOPTION_INITIAL_BUNDLE_TIMEOUT_MS = 3_000

let inflightAdoption: {
  fingerprint: string
  promise: Promise<boolean>
} | null = null

interface PersistedAdoptionSnapshot {
  keyB64: string
  keyBundle: KeyBundle
  fingerprint: string
}

function parsePersistedAlternatives(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === 'string')
      : []
  } catch {
    return []
  }
}

function parsePersistedAuthorizationMode(
  raw: string | null,
): CloudKeyAuthorizationMode {
  try {
    const parsed = raw ? (JSON.parse(raw) as { mode?: unknown }) : null
    return parsed?.mode === 'explicit_start_fresh'
      ? 'explicit_start_fresh'
      : 'validated'
  } catch {
    return 'validated'
  }
}

function readPersistedAdoptionSnapshot(): PersistedAdoptionSnapshot | null {
  if (typeof localStorage === 'undefined') return null
  const userPrimary = localStorage.getItem(USER_ENCRYPTION_KEY)
  const legacyPrimary = localStorage.getItem(LEGACY_ENCRYPTION_KEY)
  const userHistory = localStorage.getItem(USER_ENCRYPTION_KEY_HISTORY)
  const legacyHistory = localStorage.getItem(LEGACY_ENCRYPTION_KEY_HISTORY)
  const activeUserId = localStorage.getItem(AUTH_ACTIVE_USER_ID)
  const authorization = activeUserId
    ? localStorage.getItem(
        `${SECRET_CLOUD_KEY_AUTHORIZATION_PREFIX}${activeUserId}`,
      )
    : null
  const primary = userPrimary ?? legacyPrimary
  if (!primary) return null
  const primaryBytes = encryptionService.getAlternativeKeyBytes(primary)
  if (!primaryBytes) return null
  const keyB64 = bytesToBase64(primaryBytes)
  const alternatives = parsePersistedAlternatives(userHistory ?? legacyHistory)
  const authorizationMode = parsePersistedAuthorizationMode(authorization)
  return {
    keyB64,
    keyBundle: {
      primary,
      alternatives,
      authorizationMode,
    },
    fingerprint: JSON.stringify({
      activeUserId,
      primary,
      alternatives,
      authorizationMode,
      committedKeyB64: keyB64,
    }),
  }
}

function persistedSnapshotStillCurrent(
  snapshot: PersistedAdoptionSnapshot,
): boolean {
  const current = readPersistedAdoptionSnapshot()
  if (!current || current.fingerprint !== snapshot.fingerprint) return false
  try {
    return requirePrimaryKeyB64() === snapshot.keyB64
  } catch {
    return false
  }
}

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
  const snapshot = readPersistedAdoptionSnapshot()
  if (!snapshot) return false
  let activeKeyB64: string
  try {
    activeKeyB64 = requirePrimaryKeyB64()
  } catch {
    return false
  }
  if (activeKeyB64 !== snapshot.keyB64) return false
  // Dedupe concurrent adoptions per committed snapshot. The upload coalescer fires the
  // write gate for many chats at once; without this they would each
  // race a register-key, and every loser of the if_match='*' CAS would
  // defer its push. Sharing one in-flight registration lets the whole
  // batch proceed the moment the single winner lands. A changed snapshot
  // queues behind the prior attempt so stale and current registrations
  // cannot race each other.
  if (inflightAdoption?.fingerprint === snapshot.fingerprint) {
    return inflightAdoption.promise
  }
  const priorAdoption = inflightAdoption?.promise
  const entry: { fingerprint: string; promise: Promise<boolean> } = {
    fingerprint: snapshot.fingerprint,
    promise: Promise.resolve(false),
  }
  entry.promise = (async () => {
    try {
      if (priorAdoption) await priorAdoption
      if (!persistedSnapshotStillCurrent(snapshot)) return false
      return await registerAdoptedKey(snapshot)
    } finally {
      if (inflightAdoption === entry) {
        inflightAdoption = null
      }
    }
  })()
  inflightAdoption = entry
  return entry.promise
}

async function registerAdoptedKey(
  snapshot: PersistedAdoptionSnapshot,
): Promise<boolean> {
  const initialBundle = await initialBundleFromCachedPrf(snapshot)
  if (!persistedSnapshotStillCurrent(snapshot)) return false
  try {
    const localKeyId = await deriveTinfoilKeyIdHex(
      base64ToBytes(snapshot.keyB64),
    )
    if (!persistedSnapshotStillCurrent(snapshot)) return false
    const current = await keyCurrent()
    if (!persistedSnapshotStillCurrent(snapshot)) return false
    const converged = await reconcileAdoptedKey(
      snapshot,
      localKeyId,
      current,
      initialBundle,
    )
    if (!converged || !persistedSnapshotStillCurrent(snapshot)) return false
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

function bundleMatches(
  current: KeyCurrentResponse,
  expected: KeyRegisterBundleInput,
): boolean {
  const bundle = current.bundles[expected.credentialId]
  return (
    bundle?.kek_iv === expected.kekIvHex &&
    bundle.encrypted_keys === expected.encryptedKeysHex
  )
}

async function verifyAdoptedKeyConvergence(
  snapshot: PersistedAdoptionSnapshot,
  localKeyId: string,
  initialBundle: KeyRegisterBundleInput | null,
): Promise<boolean> {
  const current = await keyCurrent()
  return (
    persistedSnapshotStillCurrent(snapshot) &&
    current.key_id === localKeyId &&
    (!initialBundle || bundleMatches(current, initialBundle))
  )
}

async function reconcileAdoptedKey(
  snapshot: PersistedAdoptionSnapshot,
  localKeyId: string,
  current: KeyCurrentResponse,
  initialBundle: KeyRegisterBundleInput | null,
): Promise<boolean> {
  if (!current.key_id) {
    try {
      await registerKey({
        keyB64: snapshot.keyB64,
        ifMatch: IF_MATCH_SENTINELS.AnyKey,
        createdVia: 'recovery',
        idempotencyKey: newIdempotencyKey(),
        ...(initialBundle ? { initialBundle } : {}),
      })
    } catch {
      const winner = await keyCurrent()
      if (!persistedSnapshotStillCurrent(snapshot)) return false
      return reconcileExistingAdoptedKey(
        snapshot,
        localKeyId,
        winner,
        initialBundle,
      )
    }
    return verifyAdoptedKeyConvergence(snapshot, localKeyId, initialBundle)
  }
  return reconcileExistingAdoptedKey(
    snapshot,
    localKeyId,
    current,
    initialBundle,
  )
}

async function reconcileExistingAdoptedKey(
  snapshot: PersistedAdoptionSnapshot,
  localKeyId: string,
  current: KeyCurrentResponse,
  initialBundle: KeyRegisterBundleInput | null,
): Promise<boolean> {
  if (current.key_id !== localKeyId) {
    return false
  }

  if (initialBundle && !bundleMatches(current, initialBundle)) {
    await addBundle({
      keyId: localKeyId,
      keyB64: snapshot.keyB64,
      credentialId: initialBundle.credentialId,
      kekIvHex: initialBundle.kekIvHex,
      encryptedKeysHex: initialBundle.encryptedKeysHex,
      idempotencyKey: newIdempotencyKey(),
    })
    return verifyAdoptedKeyConvergence(snapshot, localKeyId, initialBundle)
  }
  return persistedSnapshotStillCurrent(snapshot)
}

/**
 * Best-effort initial bundle for key adoption: wrap the current primary CEK
 * using this device's cached passkey PRF. Credential discovery is bounded
 * so legacy auth or fetch hangs cannot
 * starve the adoption queue. Every failure path returns null and the caller
 * registers bundleless.
 *
 * The cached credential is only trusted when it still appears in the
 * user's stored credentials — a stale cache (passkey deleted or
 * re-created) must not attach an unopenable bundle, which would make
 * the account look passkey-recoverable when it is not.
 */
async function initialBundleFromCachedPrf(
  snapshot: PersistedAdoptionSnapshot,
): Promise<KeyRegisterBundleInput | null> {
  const controller = new AbortController()
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  try {
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        controller.abort()
        reject(new Error('Passkey bundle discovery timed out'))
      }, ADOPTION_INITIAL_BUNDLE_TIMEOUT_MS)
    })
    const entries = await Promise.race([
      loadPasskeyCredentials({ signal: controller.signal }),
      timeout,
    ])
    const primaryBytes = encryptionService.getAlternativeKeyBytes(
      snapshot.keyBundle.primary,
    )
    if (!primaryBytes) return null
    const wrappedKey = await passkeyKeyManager.rewrapKeyFromCache({
      key: primaryBytes,
    })
    if (!wrappedKey) return null
    if (!entries.some((entry) => entry.id === wrappedKey.credentialId))
      return null
    const wrappedKeys = await wrapTinfoilKeyBundle(
      wrappedKey,
      snapshot.keyBundle,
    )
    if (!wrappedKeys) return null
    return tinfoilWrappedKeyBundleToEnclave(wrappedKeys)
  } catch (err) {
    logWarning('Could not build initial bundle for key adoption', {
      component: 'CloudSync',
      action: 'initialBundleFromCachedPrf',
      metadata: { error: err instanceof Error ? err.message : String(err) },
    })
    return null
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId)
    controller.abort()
  }
}
