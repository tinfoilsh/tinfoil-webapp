/**
 * Cloud key authorization — gate that decides whether the local CEK
 * is allowed to write to the cloud.
 *
 * Phase 2 of the sync-enclave refactor: the legacy implementation
 * kept a `{fingerprint, mode}` record in localStorage that callers
 * had to explicitly stamp via `authorizeCurrentPrimaryKey('validated')`
 * or `'explicit_start_fresh'` after a passkey ceremony. The enclave
 * now owns key authority — if the local CEK derives the enclave's
 * registered KeyID, writes are allowed; otherwise they are rejected
 * with EXISTING_DATA_UNDER_OTHER_KEY.
 *
 * The 'mode' bit is still useful as a local hint so the recovery UI
 * can show the user how they got here ("start fresh" vs "validated
 * existing key"). We persist a tiny annotation in localStorage but
 * the authoritative "can write" answer comes from the enclave.
 *
 * Exported surface preserved: callers (`usePasskeyBackup`,
 * `cloud-sync`, recovery flows) continue to call the same five
 * helpers. Internals route through `cloud-key-preflight.ts`.
 */

import {
  AUTH_ACTIVE_USER_ID,
  SECRET_CLOUD_KEY_AUTHORIZATION_PREFIX,
} from '@/constants/storage-keys'
import { isCloudSyncEnabled } from '@/utils/cloud-sync-settings'
import { logError } from '@/utils/error-handling'
import { deriveKeyIdHex } from '../sync-enclave/key-bundle'
import {
  base64ToBytes,
  keyCurrent,
  newIdempotencyKey,
  registerKey,
  type KeyCurrentResponse,
} from '../sync-enclave/sync-api'
import { IF_MATCH_SENTINELS } from '../sync-enclave/wire-contract'
import { persistedPrimaryKeyB64, requirePrimaryKeyB64 } from './cek-encoding'
import {
  CloudKeySetupError,
  validateCurrentPrimaryKey,
} from './cloud-key-preflight'
import { reportKeyHealthy } from './sync-health'

export type CloudKeyAuthorizationMode = 'validated' | 'explicit_start_fresh'

function isCloudKeyAuthorizationMode(
  value: unknown,
): value is CloudKeyAuthorizationMode {
  return value === 'validated' || value === 'explicit_start_fresh'
}

function getActiveUserId(): string | null {
  if (typeof window === 'undefined') return null
  return localStorage.getItem(AUTH_ACTIVE_USER_ID)
}

function storageKey(userId: string): string {
  return `${SECRET_CLOUD_KEY_AUTHORIZATION_PREFIX}${userId}`
}

function loadModeHint(userId: string): CloudKeyAuthorizationMode | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = localStorage.getItem(storageKey(userId))
    if (!raw) return null
    const parsed = JSON.parse(raw) as { mode?: unknown }
    return isCloudKeyAuthorizationMode(parsed?.mode) ? parsed.mode : null
  } catch {
    return null
  }
}

function saveModeHint(
  userId: string,
  mode: CloudKeyAuthorizationMode,
): boolean {
  if (typeof window === 'undefined') return false
  try {
    localStorage.setItem(storageKey(userId), JSON.stringify({ mode }))
    return true
  } catch {
    return false
  }
}

/**
 * Returns the cached mode hint for the active user if (and only if)
 * the enclave currently agrees the local CEK is authoritative. A
 * cache hit on its own is never sufficient: the enclave-side check
 * runs every time so a stolen / rotated local CEK can never spoof
 * authorization.
 */
export async function getCurrentCloudKeyAuthorizationMode(): Promise<CloudKeyAuthorizationMode | null> {
  const userId = getActiveUserId()
  if (!userId) return null
  const validation = await validateCurrentPrimaryKey()
  if (!validation.canWrite) return null
  return loadModeHint(userId) ?? 'validated'
}

export async function canWriteToCloud(): Promise<boolean> {
  const validation = await validateCurrentPrimaryKey()
  if (!validation.canWrite) return false
  // The enclave just confirmed the local key is authoritative, so any
  // surfaced key problem is stale — clear the sync-health gate.
  reportKeyHealthy()
  if (validation.remoteState === 'empty' && isCloudSyncEnabled()) {
    return registerKeyForEmptyRemote()
  }
  return true
}

let emptyRemoteRegistration: Promise<boolean> | null = null

/**
 * Bind the loaded primary CEK as the enclave's current key when the
 * remote is completely empty. The controlplane rejects every push as
 * a stale key until a user_keys row exists, and nothing else
 * registers a manually generated/imported key on a brand-new
 * account, so the write gate performs the registration itself. The
 * AnyKey sentinel keeps this race-safe across devices: registration
 * only succeeds while no key is registered, and a loss just defers
 * the push until the next validation pass sees the winner's key.
 */
function registerKeyForEmptyRemote(): Promise<boolean> {
  // Only bind a key the user has actually committed. During an
  // activation ceremony the new key is staged in memory only; a
  // concurrent background write must not register it before the
  // ceremony finishes (a transient failure would roll the client
  // back while the server stays bound to the discarded key).
  const persistedKeyB64 = persistedPrimaryKeyB64()
  if (!persistedKeyB64) return Promise.resolve(false)
  if (!emptyRemoteRegistration) {
    emptyRemoteRegistration = (async () => {
      try {
        await registerKey({
          keyB64: persistedKeyB64,
          ifMatch: IF_MATCH_SENTINELS.AnyKey,
          createdVia: 'manual',
          idempotencyKey: newIdempotencyKey(),
        })
        return true
      } catch (err) {
        logError('Failed to register key for empty remote', err, {
          component: 'CloudKeyAuthorization',
          action: 'registerKeyForEmptyRemote',
        })
        return false
      } finally {
        emptyRemoteRegistration = null
      }
    })()
  }
  return emptyRemoteRegistration
}

/**
 * Persist the local mode hint after a successful enclave ceremony.
 * Returns false (without throwing) if the enclave currently disagrees
 * — the caller's local CEK does not match the registered KeyID and
 * no amount of localStorage writes will let it pass `canWriteToCloud`.
 *
 * The mode hint itself is non-authoritative (the enclave is the
 * source of truth for "can write"), so a persistence failure must
 * not block the caller: it would force a recovery ceremony even
 * though the enclave already accepted the key.
 */
export async function authorizeCurrentPrimaryKey(
  mode: CloudKeyAuthorizationMode,
): Promise<boolean> {
  const userId = getActiveUserId()
  if (!userId) return false
  const validation = await validateCurrentPrimaryKey()
  if (!validation.canWrite) return false
  saveModeHint(userId, mode)
  return true
}

export async function authorizeCurrentPrimaryKeyOrThrow(
  mode: CloudKeyAuthorizationMode,
): Promise<void> {
  const authorized = await authorizeCurrentPrimaryKey(mode)
  if (!authorized) {
    throw new Error('Failed to authorize the current encryption key')
  }
}

/**
 * Make the current local CEK the enclave's authoritative key for an
 * explicit "start fresh". When existing cloud data sits under a
 * different key, the steady-state write guard
 * (EXISTING_DATA_UNDER_OTHER_KEY) blocks the new key — the only way
 * past it is register-key with created_via=start_fresh, which
 * atomically drops the old rows and rebinds the user to this CEK.
 *
 * No-op only when the enclave's registered key already IS this CEK
 * (matching KeyID) — a prior ceremony (e.g. the passkey start-fresh
 * path, which registers before this runs) must not be wiped again.
 * Every other state registers, including an empty remote and
 * unregistered legacy data: start-fresh still needs the enclave-side
 * key row, or every subsequent push is rejected as a stale key.
 * Throws a CloudKeySetupError when the enclave can't be reached, so
 * the caller surfaces "try again" instead of wiping blindly or
 * mislabeling the key as invalid.
 */
export async function registerStartFreshKeyIfNeeded(): Promise<void> {
  const keyB64 = requirePrimaryKeyB64()
  let current: KeyCurrentResponse
  try {
    current = await keyCurrent()
  } catch {
    throw new CloudKeySetupError(
      "We couldn't verify your cloud data. Please try again in a moment.",
      'unknown',
    )
  }
  if (current.key_id) {
    try {
      const localKeyId = await deriveKeyIdHex(base64ToBytes(keyB64))
      if (localKeyId === current.key_id) return
    } catch {
      // Underivable local key bytes: fall through and let the
      // enclave's register-key validation reject them.
    }
  }
  await registerKey({
    keyB64,
    ifMatch: current.etag || IF_MATCH_SENTINELS.AnyKey,
    createdVia: 'start_fresh',
    idempotencyKey: newIdempotencyKey(),
  })
}

export function clearCloudKeyAuthorization(userId?: string | null): void {
  if (typeof window === 'undefined') return
  const resolvedUserId = userId ?? getActiveUserId()
  if (!resolvedUserId) return
  localStorage.removeItem(storageKey(resolvedUserId))
}
