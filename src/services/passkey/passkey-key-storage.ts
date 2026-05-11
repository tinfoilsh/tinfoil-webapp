/**
 * Passkey Key Storage
 *
 * Encrypts/decrypts the user's encryption key bundle (primary + alternatives)
 * using a passkey-derived KEK, and stores/retrieves the encrypted blobs via
 * the backend API.
 *
 * The backend is a dumb JSONB store — all crypto happens client-side.
 */

import { PASSKEY } from '@/config'
import { base64ToUint8Array, uint8ArrayToBase64 } from '@/utils/binary-codec'
import { logError, logInfo } from '@/utils/error-handling'
import { authTokenManager } from '../auth'
import type { CloudKeyAuthorizationMode } from '../cloud/cloud-key-authorization'

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL || 'https://api.tinfoil.sh'

const AES_GCM_IV_BYTES = 12

export interface KeyBundle {
  primary: string
  alternatives: string[]
  authorizationMode?: CloudKeyAuthorizationMode
}

export interface PasskeyCredentialEntry {
  id: string
  encrypted_keys: string // base64
  iv: string // base64
  created_at: string
  version: number // schema version (1 = AES-256-GCM + HKDF-SHA256 KEK)
  sync_version: number // monotonic counter, incremented each time the key bundle is re-encrypted
  bundle_version?: number // logical key-bundle version shared across credential updates
}

const CURRENT_CREDENTIAL_VERSION = 1

export type PasskeyCredentialState = 'exists' | 'empty' | 'unknown'

export interface StoreEncryptedKeysOptions {
  expectedSyncVersion?: number | null
  knownBundleVersion?: number | null
  incrementBundleVersion?: boolean
  enforceRemoteBundleVersion?: boolean
}

export class PasskeyCredentialConflictError extends Error {
  readonly remoteSyncVersion: number | null
  readonly remoteBundleVersion: number

  constructor(
    message: string,
    details: {
      remoteSyncVersion?: number | null
      remoteBundleVersion?: number
    } = {},
  ) {
    super(message)
    this.name = 'PasskeyCredentialConflictError'
    this.remoteSyncVersion = details.remoteSyncVersion ?? null
    this.remoteBundleVersion = details.remoteBundleVersion ?? 0
  }
}

// --- Encrypt / Decrypt ---

/**
 * Encrypt a key bundle with an AES-256-GCM KEK.
 * Returns base64-encoded IV and ciphertext.
 */
export async function encryptKeyBundle(
  kek: CryptoKey,
  keys: KeyBundle,
): Promise<{ iv: string; data: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES))
  const plaintext = new TextEncoder().encode(JSON.stringify(keys))

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    kek,
    plaintext,
  )

  return {
    iv: uint8ArrayToBase64(iv),
    data: uint8ArrayToBase64(new Uint8Array(ciphertext)),
  }
}

/**
 * Decrypt a key bundle from base64-encoded IV and ciphertext.
 */
export async function decryptKeyBundle(
  kek: CryptoKey,
  encrypted: { iv: string; data: string },
): Promise<KeyBundle> {
  const iv = base64ToUint8Array(encrypted.iv)
  const ciphertext = base64ToUint8Array(encrypted.data)

  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    kek,
    ciphertext as BufferSource,
  )

  const json = new TextDecoder().decode(plaintext)
  const parsed = JSON.parse(json) as KeyBundle

  if (
    typeof parsed.primary !== 'string' ||
    !Array.isArray(parsed.alternatives) ||
    (parsed.authorizationMode !== undefined &&
      parsed.authorizationMode !== 'validated' &&
      parsed.authorizationMode !== 'explicit_start_fresh')
  ) {
    throw new Error('Invalid key bundle structure')
  }

  return parsed
}

// --- Backend API ---

function isValidCredentialEntry(
  entry: unknown,
): entry is PasskeyCredentialEntry {
  if (typeof entry !== 'object' || entry === null) return false
  const e = entry as Record<string, unknown>
  return (
    typeof e.id === 'string' &&
    typeof e.encrypted_keys === 'string' &&
    typeof e.iv === 'string' &&
    typeof e.created_at === 'string' &&
    typeof e.version === 'number' &&
    typeof e.sync_version === 'number' &&
    (e.bundle_version === undefined || typeof e.bundle_version === 'number')
  )
}

function getCredentialBundleVersion(
  entry: Pick<PasskeyCredentialEntry, 'bundle_version'>,
): number {
  return entry.bundle_version ?? 0
}

function getHighestBundleVersion(entries: PasskeyCredentialEntry[]): number {
  return entries.reduce(
    (highest, entry) => Math.max(highest, getCredentialBundleVersion(entry)),
    0,
  )
}

function hasStoredCredentialEntry(
  entry: PasskeyCredentialEntry,
  expected: PasskeyCredentialEntry,
): boolean {
  return (
    entry.sync_version === expected.sync_version &&
    getCredentialBundleVersion(entry) ===
      getCredentialBundleVersion(expected) &&
    entry.iv === expected.iv &&
    entry.encrypted_keys === expected.encrypted_keys
  )
}

/**
 * Load all passkey credential entries for the authenticated user.
 */
export async function loadPasskeyCredentials(): Promise<
  PasskeyCredentialEntry[]
> {
  const headers = await authTokenManager.getAuthHeaders()
  const response = await fetch(`${API_BASE_URL}/api/passkey-credentials/`, {
    method: 'GET',
    headers,
  })

  if (!response.ok) {
    if (response.status === 404) {
      return []
    }
    throw new Error(
      `Failed to load passkey credentials: ${response.statusText}`,
    )
  }

  const data = await response.json()
  if (!Array.isArray(data)) {
    throw new Error('Invalid passkey credentials response: expected array')
  }

  return data.filter(isValidCredentialEntry)
}

/**
 * Save the full array of passkey credential entries for the authenticated user.
 * The backend overwrites the entire JSONB column — the client owns the structure.
 */
export async function savePasskeyCredentials(
  entries: PasskeyCredentialEntry[],
): Promise<boolean> {
  try {
    const headers = await authTokenManager.getAuthHeaders()
    const response = await fetch(`${API_BASE_URL}/api/passkey-credentials/`, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(entries),
    })

    if (!response.ok) {
      throw new Error(
        `Failed to save passkey credentials: ${response.statusText}`,
      )
    }

    return true
  } catch (error) {
    logError('Failed to save passkey credentials', error, {
      component: 'PasskeyKeyStorage',
      action: 'savePasskeyCredentials',
    })
    return false
  }
}

export async function deletePasskeyCredential(
  credentialId: string,
): Promise<boolean> {
  try {
    const entries = await loadPasskeyCredentials()
    const updated = entries.filter((entry) => entry.id !== credentialId)
    if (updated.length === entries.length) return true
    return await savePasskeyCredentials(updated)
  } catch (error) {
    logError('Failed to delete passkey credential', error, {
      component: 'PasskeyKeyStorage',
      action: 'deletePasskeyCredential',
    })
    return false
  }
}

/**
 * Check if any passkey credentials exist for the authenticated user.
 */
export async function hasPasskeyCredentials(): Promise<boolean> {
  try {
    const entries = await loadPasskeyCredentials()
    return entries.length > 0
  } catch (error) {
    logError('Failed to check passkey credentials', error, {
      component: 'PasskeyKeyStorage',
      action: 'hasPasskeyCredentials',
    })
    return false
  }
}

export async function getPasskeyCredentialState(): Promise<PasskeyCredentialState> {
  try {
    const entries = await loadPasskeyCredentials()
    return entries.length > 0 ? 'exists' : 'empty'
  } catch (error) {
    logError('Failed to check passkey credentials', error, {
      component: 'PasskeyKeyStorage',
      action: 'getPasskeyCredentialState',
    })
    return 'unknown'
  }
}

// --- High-level operations ---

/**
 * Encrypt the key bundle and upsert a credential entry, then save to backend.
 * If a credential with the same ID already exists, it is replaced (preserving
 * the original `created_at` value).
 */
export async function storeEncryptedKeys(
  credentialId: string,
  kek: CryptoKey,
  keys: KeyBundle,
  options: StoreEncryptedKeysOptions = {},
): Promise<{ syncVersion: number; bundleVersion: number } | null> {
  try {
    const encrypted = await encryptKeyBundle(kek, keys)

    for (
      let attempt = 0;
      attempt < PASSKEY.CREDENTIAL_SAVE_MAX_ATTEMPTS;
      attempt++
    ) {
      const existing = await loadPasskeyCredentials()
      const previous = existing.find((e) => e.id === credentialId)
      const remoteBundleVersion = getHighestBundleVersion(existing)

      if (
        options.expectedSyncVersion !== undefined &&
        options.expectedSyncVersion !== null &&
        (!previous || previous.sync_version > options.expectedSyncVersion)
      ) {
        throw new PasskeyCredentialConflictError(
          'A newer passkey backup already exists for this credential. Recover the latest backup before updating it.',
          {
            remoteSyncVersion: previous?.sync_version ?? null,
            remoteBundleVersion,
          },
        )
      }

      if (options.enforceRemoteBundleVersion) {
        if (
          options.knownBundleVersion === undefined ||
          options.knownBundleVersion === null
        ) {
          if (remoteBundleVersion > 0) {
            throw new PasskeyCredentialConflictError(
              'This device needs the latest passkey backup before it can save changes.',
              {
                remoteSyncVersion: previous?.sync_version ?? null,
                remoteBundleVersion,
              },
            )
          }
        } else if (remoteBundleVersion > options.knownBundleVersion) {
          throw new PasskeyCredentialConflictError(
            'A newer passkey backup already exists on another device. Recover the latest backup before updating it.',
            {
              remoteSyncVersion: previous?.sync_version ?? null,
              remoteBundleVersion,
            },
          )
        }
      }

      const newSyncVersion = previous ? previous.sync_version + 1 : 1
      const baseBundleVersion = Math.max(
        remoteBundleVersion,
        options.knownBundleVersion ?? 0,
      )
      const newBundleVersion = options.incrementBundleVersion
        ? Math.max(baseBundleVersion + 1, 1)
        : Math.max(baseBundleVersion, 1)

      const entry: PasskeyCredentialEntry = {
        id: credentialId,
        encrypted_keys: encrypted.data,
        iv: encrypted.iv,
        created_at: previous?.created_at ?? new Date().toISOString(),
        version: CURRENT_CREDENTIAL_VERSION,
        sync_version: newSyncVersion,
        bundle_version: newBundleVersion,
      }

      const updated = existing.filter((e) => e.id !== credentialId)
      updated.push(entry)

      const saved = await savePasskeyCredentials(updated)
      if (!saved) {
        continue
      }

      const verifiedEntries = await loadPasskeyCredentials()
      const verifiedEntry = verifiedEntries.find((e) => e.id === credentialId)
      if (verifiedEntry && hasStoredCredentialEntry(verifiedEntry, entry)) {
        logInfo('Stored encrypted keys for passkey credential', {
          component: 'PasskeyKeyStorage',
          action: 'storeEncryptedKeys',
          metadata: {
            credentialId,
            totalEntries: updated.length,
            bundleVersion: newBundleVersion,
          },
        })
        return {
          syncVersion: newSyncVersion,
          bundleVersion: newBundleVersion,
        }
      }
    }

    throw new Error('Failed to confirm the latest passkey backup update')
  } catch (error) {
    if (error instanceof PasskeyCredentialConflictError) {
      throw error
    }
    logError('Failed to store encrypted keys', error, {
      component: 'PasskeyKeyStorage',
      action: 'storeEncryptedKeys',
    })
    return null
  }
}

/**
 * Decrypt the key bundle for a specific credential entry.
 */
export async function retrieveEncryptedKeys(
  credentialId: string,
  kek: CryptoKey,
): Promise<KeyBundle | null> {
  try {
    const entries = await loadPasskeyCredentials()
    const entry = entries.find((e) => e.id === credentialId)
    if (!entry) {
      return null
    }

    return await decryptKeyBundle(kek, {
      iv: entry.iv,
      data: entry.encrypted_keys,
    })
  } catch (error) {
    logError('Failed to retrieve encrypted keys', error, {
      component: 'PasskeyKeyStorage',
      action: 'retrieveEncryptedKeys',
    })
    return null
  }
}
