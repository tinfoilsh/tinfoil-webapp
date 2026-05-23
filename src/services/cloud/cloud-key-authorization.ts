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
import { validateCurrentPrimaryKey } from './cloud-key-preflight'

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
  return validation.canWrite
}

/**
 * Persist the local mode hint after a successful enclave ceremony.
 * Returns false (without throwing) if the enclave currently disagrees
 * — the caller's local CEK does not match the registered KeyID and
 * no amount of localStorage writes will let it pass `canWriteToCloud`.
 */
export async function authorizeCurrentPrimaryKey(
  mode: CloudKeyAuthorizationMode,
): Promise<boolean> {
  const userId = getActiveUserId()
  if (!userId) return false
  const validation = await validateCurrentPrimaryKey()
  if (!validation.canWrite) return false
  return saveModeHint(userId, mode)
}

export async function authorizeCurrentPrimaryKeyOrThrow(
  mode: CloudKeyAuthorizationMode,
): Promise<void> {
  const authorized = await authorizeCurrentPrimaryKey(mode)
  if (!authorized) {
    throw new Error('Failed to authorize the current encryption key')
  }
}

export function clearCloudKeyAuthorization(userId?: string | null): void {
  if (typeof window === 'undefined') return
  const resolvedUserId = userId ?? getActiveUserId()
  if (!resolvedUserId) return
  localStorage.removeItem(storageKey(resolvedUserId))
}
