import { logError } from '@/utils/error-handling'
import { authTokenManager } from '../auth'
import type { PasskeyCredentialEntry } from './passkey-key-storage'

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL || 'https://api.tinfoil.sh'

/**
 * One-way recovery fetch for users who registered a passkey on the
 * pre-enclave webapp. The legacy server stores a client-owned JSONB
 * array of `PasskeyCredentialEntry` objects at /api/passkey-credentials/.
 * New clients consult this endpoint only when the enclave reports no
 * `user_keys` row, so the recovery wizard can still find a passkey to
 * authenticate against and unwrap the user's CEK. After unlock the
 * recovered CEK is promoted to a real `user_keys` row via the
 * enclave's register-key wire (see `promoteRecoveredCekToEnclave`).
 *
 * Writes to /api/passkey-credentials/ are intentionally NOT exposed
 * here — the legacy table is read-only for the new client.
 */
export async function fetchLegacyPasskeyCredentials(): Promise<
  PasskeyCredentialEntry[]
> {
  if (!(await authTokenManager.isAuthenticated())) {
    return []
  }
  try {
    const resp = await fetch(`${API_BASE_URL}/api/passkey-credentials/`, {
      headers: await authTokenManager.getAuthHeaders(),
    })
    if (resp.status === 404 || resp.status === 401) return []
    if (!resp.ok) {
      throw new Error(`legacy passkey credentials fetch failed: ${resp.status}`)
    }
    const body = (await resp.json()) as unknown
    if (!Array.isArray(body)) return []
    return body.filter(isPasskeyCredentialEntry)
  } catch (err) {
    logError('failed to load legacy passkey credentials', err, {
      component: 'LegacyPasskeyCredentials',
      action: 'fetchLegacyPasskeyCredentials',
    })
    // Re-throw so callers can tell "no credentials exist" (404/401 or
    // an empty array) apart from "could not find out"; swallowing the
    // failure as [] would misroute recovery into first-time setup and
    // let deletePasskeyCredential report a false success.
    throw err
  }
}

function isPasskeyCredentialEntry(
  value: unknown,
): value is PasskeyCredentialEntry {
  if (!value || typeof value !== 'object') return false
  const obj = value as Record<string, unknown>
  return (
    typeof obj.id === 'string' &&
    typeof obj.encrypted_keys === 'string' &&
    typeof obj.iv === 'string' &&
    typeof obj.created_at === 'string' &&
    typeof obj.version === 'number' &&
    typeof obj.sync_version === 'number'
  )
}
