/**
 * Passkey Key Storage — enclave-backed.
 *
 * The legacy implementation talked to `/api/passkey-credentials/` and
 * persisted a JSONB array of credentials directly. After Phase 2 the
 * enclave is the source of truth: passkey bundles live under
 * `user_key_bundles` rows scoped to a single `user_keys.key_id`. We
 * preserve this module's public exports verbatim so the
 * `usePasskeyBackup` hook and recovery flows keep importing the same
 * names, but the internals route through the enclave's
 * `key-current` / `register-key` / `add-bundle` / `remove-bundle`
 * wire.
 *
 * `KeyBundle.alternatives` is preserved end-to-end. The enclave treats
 * the bundle ciphertext as an opaque blob, so any legacy decryption
 * history the caller hands in survives unchanged. Alternatives are
 * dropped from the local model only after the client-side migration
 * loop has re-sealed every legacy row under the current primary CEK.
 *
 * The encrypt/decrypt primitives (`encryptKeyBundle`,
 * `decryptKeyBundle`) are pure client-side AES-256-GCM. Optimistic
 * concurrency is enforced by the enclave: register-key uses
 * `if_match='*'` for first-time writes and returns
 * EXISTING_DATA_UNDER_OTHER_KEY when a key already exists;
 * add-bundle is idempotent per credential_id. The legacy
 * `sync_version` / `bundle_version` counters are synthesized from the
 * enclave's `bundle_version` so callers that read them keep working.
 */

import { base64ToUint8Array, uint8ArrayToBase64 } from '@/utils/binary-codec'
import { logError, logInfo } from '@/utils/error-handling'
import type { CloudKeyAuthorizationMode } from '../cloud/cloud-key-authorization'
import { encryptionService } from '../encryption/encryption-service'
import { deriveKeyIdHex } from '../sync-enclave/key-bundle'
import {
  bytesToBase64,
  addBundle as enclaveAddBundle,
  keyCurrent as enclaveKeyCurrent,
  registerKey as enclaveRegisterKey,
  removeBundle as enclaveRemoveBundle,
  newIdempotencyKey,
} from '../sync-enclave/sync-api'
import { SyncEnclaveError } from '../sync-enclave/sync-enclave-client'

const AES_GCM_IV_BYTES = 12

export interface KeyBundle {
  primary: string
  /**
   * Decryption-only history retained for legacy v0/v1 rows. New
   * bundles persist whatever the caller hands in (the enclave is a
   * blob store at the bundle layer). Removed in Layer C of the
   * sync-enclave refactor once the client-side migration loop has
   * re-sealed every legacy row under `primary`.
   */
  alternatives: string[]
  authorizationMode?: CloudKeyAuthorizationMode
}

export interface PasskeyCredentialEntry {
  id: string
  encrypted_keys: string
  iv: string
  created_at: string
  version: number
  sync_version: number
  bundle_version?: number
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

// --- Crypto primitives -----------------------------------------------------

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
  const parsed = JSON.parse(json) as Partial<KeyBundle>
  if (
    typeof parsed.primary !== 'string' ||
    !Array.isArray(parsed.alternatives) ||
    (parsed.authorizationMode !== undefined &&
      parsed.authorizationMode !== 'validated' &&
      parsed.authorizationMode !== 'explicit_start_fresh')
  ) {
    throw new Error('Invalid key bundle structure')
  }
  return {
    primary: parsed.primary,
    alternatives: parsed.alternatives,
    authorizationMode: parsed.authorizationMode,
  }
}

// --- Wire reshape ----------------------------------------------------------

function reshapeBundleToEntry(bundle: {
  credential_id: string
  kek_iv: string
  encrypted_keys: string
  bundle_version?: number
  created_at?: string
}): PasskeyCredentialEntry {
  const bundleVersion = bundle.bundle_version ?? 1
  return {
    id: bundle.credential_id,
    iv: bundle.kek_iv,
    encrypted_keys: bundle.encrypted_keys,
    created_at: bundle.created_at ?? new Date(0).toISOString(),
    version: CURRENT_CREDENTIAL_VERSION,
    sync_version: bundleVersion,
    bundle_version: bundleVersion,
  }
}

// --- Public API ------------------------------------------------------------

export async function loadPasskeyCredentials(): Promise<
  PasskeyCredentialEntry[]
> {
  try {
    const resp = await enclaveKeyCurrent()
    if (!resp.key_id) return []
    return Object.values(resp.bundles).map(reshapeBundleToEntry)
  } catch (err) {
    if (err instanceof SyncEnclaveError && err.status === 404) {
      return []
    }
    throw err
  }
}

/**
 * Legacy bulk-replace. The enclave wire doesn't expose a put-all
 * endpoint — bundles are added/removed individually — so this helper
 * is now a no-op kept only for source compatibility. Callers must
 * use `storeEncryptedKeys` and `deletePasskeyCredential`.
 */
export async function savePasskeyCredentials(
  _entries: PasskeyCredentialEntry[],
): Promise<boolean> {
  logInfo('savePasskeyCredentials is a no-op under the enclave wire', {
    component: 'PasskeyKeyStorage',
    action: 'savePasskeyCredentials',
  })
  return true
}

export async function deletePasskeyCredential(
  credentialId: string,
): Promise<boolean> {
  try {
    const resp = await enclaveKeyCurrent()
    if (!resp.key_id) return true
    if (!resp.bundles[credentialId]) return true
    await enclaveRemoveBundle({
      keyId: resp.key_id,
      credentialId,
    })
    return true
  } catch (error) {
    logError('Failed to delete passkey credential', error, {
      component: 'PasskeyKeyStorage',
      action: 'deletePasskeyCredential',
    })
    return false
  }
}

export async function hasPasskeyCredentials(): Promise<boolean> {
  try {
    const entries = await loadPasskeyCredentials()
    return entries.length > 0
  } catch {
    return false
  }
}

export async function getPasskeyCredentialState(): Promise<PasskeyCredentialState> {
  try {
    const entries = await loadPasskeyCredentials()
    return entries.length > 0 ? 'exists' : 'empty'
  } catch {
    return 'unknown'
  }
}

/**
 * Wrap the user's KeyBundle under a passkey-derived KEK and ship the
 * bundle to the enclave. Behavior mirrors the legacy contract the
 * hook expects:
 *
 *  - No remote key yet → register-key with initial_bundle.
 *  - Remote key exists under the SAME primary CEK → add-bundle for
 *    this credential.
 *  - Remote key exists under a DIFFERENT CEK → throw
 *    PasskeyCredentialConflictError so the hook routes the user to
 *    the recovery wizard instead of clobbering.
 *
 * The version-counter knobs in `StoreEncryptedKeysOptions` are
 * accepted for source compat; the enclave owns concurrency so there
 * is no client-side rev loop. The returned counters mirror what the
 * enclave reports for the freshly written bundle.
 */
export async function storeEncryptedKeys(
  credentialId: string,
  kek: CryptoKey,
  keys: KeyBundle,
  options: StoreEncryptedKeysOptions = {},
): Promise<{ syncVersion: number; bundleVersion: number } | null> {
  try {
    const encrypted = await encryptKeyBundle(kek, keys)
    const current = await enclaveKeyCurrent()
    const primaryBytes = encryptionService.getAlternativeKeyBytes(keys.primary)
    if (!primaryBytes) {
      throw new Error('passkey-key-storage: primary key is not decodable')
    }
    const localKeyId = await deriveKeyIdHex(primaryBytes)

    if (!current.key_id) {
      try {
        await enclaveRegisterKey({
          keyB64: bytesToBase64(primaryBytes),
          ifMatch: '*',
          createdVia:
            keys.authorizationMode === 'explicit_start_fresh'
              ? 'start_fresh'
              : 'passkey',
          idempotencyKey: newIdempotencyKey(),
          initialBundle: {
            credentialId,
            kekIvHex: b64ToHexLocal(encrypted.iv),
            encryptedKeysHex: b64ToHexLocal(encrypted.data),
          },
        })
      } catch (err) {
        if (
          err instanceof SyncEnclaveError &&
          err.code === 'EXISTING_DATA_UNDER_OTHER_KEY'
        ) {
          throw new PasskeyCredentialConflictError(
            'Remote key already exists under a different CEK; recover first.',
            { remoteSyncVersion: null, remoteBundleVersion: 0 },
          )
        }
        throw err
      }
      const created = await enclaveKeyCurrent()
      const bundleVersion = created.bundles[credentialId]?.bundle_version ?? 1
      logInfo('Registered initial key + bundle with enclave', {
        component: 'PasskeyKeyStorage',
        action: 'storeEncryptedKeys',
        metadata: { credentialId, bundleVersion },
      })
      return { syncVersion: bundleVersion, bundleVersion }
    }

    if (current.key_id !== localKeyId) {
      throw new PasskeyCredentialConflictError(
        "The remote key does not match this device's CEK. Recover the existing key first.",
        {
          remoteSyncVersion: null,
          remoteBundleVersion:
            current.bundles[credentialId]?.bundle_version ?? 0,
        },
      )
    }

    await enclaveAddBundle({
      keyId: current.key_id,
      credentialId,
      kekIvHex: b64ToHexLocal(encrypted.iv),
      encryptedKeysHex: b64ToHexLocal(encrypted.data),
    })

    const refreshed = await enclaveKeyCurrent()
    const bundleVersion =
      refreshed.bundles[credentialId]?.bundle_version ??
      (options.knownBundleVersion ?? 0) + 1
    logInfo('Added passkey bundle for current enclave key', {
      component: 'PasskeyKeyStorage',
      action: 'storeEncryptedKeys',
      metadata: { credentialId, bundleVersion },
    })
    return { syncVersion: bundleVersion, bundleVersion }
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

export async function retrieveEncryptedKeys(
  credentialId: string,
  kek: CryptoKey,
): Promise<KeyBundle | null> {
  try {
    const resp = await enclaveKeyCurrent()
    if (!resp.key_id) return null
    const bundle = resp.bundles[credentialId]
    if (!bundle) return null
    return await decryptKeyBundle(kek, {
      iv: bundle.kek_iv,
      data: bundle.encrypted_keys,
    })
  } catch (err) {
    logError('Failed to retrieve encrypted keys', err, {
      component: 'PasskeyKeyStorage',
      action: 'retrieveEncryptedKeys',
    })
    return null
  }
}

// --- Helpers ---------------------------------------------------------------

function b64ToHexLocal(s: string): string {
  const bytes = base64ToUint8Array(s)
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0')
  }
  return out
}
