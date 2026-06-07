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
import { requirePrimaryKeyB64 } from '../cloud/cek-encoding'
import type { CloudKeyAuthorizationMode } from '../cloud/cloud-key-authorization'
import { encryptionService } from '../encryption/encryption-service'
import {
  deriveKeyIdHex,
  unwrapCekFromBundle,
  wrapCekForCredential,
} from '../sync-enclave/key-bundle'
import {
  bytesToBase64,
  addBundle as enclaveAddBundle,
  keyCurrent as enclaveKeyCurrent,
  registerKey as enclaveRegisterKey,
  removeBundle as enclaveRemoveBundle,
  hexToB64,
  newIdempotencyKey,
} from '../sync-enclave/sync-api'
import { SyncEnclaveError } from '../sync-enclave/sync-enclave-client'
import { IF_MATCH_SENTINELS, WIRE_CODES } from '../sync-enclave/wire-contract'
import { fetchLegacyPasskeyCredentials } from './legacy-passkey-credentials'

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
  /**
   * Set on entries that came from the legacy
   * `/api/passkey-credentials/` JSONB rather than the enclave's
   * `user_key_bundles` table. Used by the recovery flow to know
   * whether the unwrapped CEK needs to be promoted into a real
   * `user_keys` row after unlock. Not persisted; populated only on
   * the in-memory list returned by `loadPasskeyCredentials`.
   */
  source?: 'enclave' | 'legacy'
}

const CURRENT_CREDENTIAL_VERSION = 1

export type PasskeyCredentialState = 'exists' | 'empty' | 'unknown'

/**
 * Per-device classification of the user's passkey bundle state.
 *
 *  - `this-device`: a bundle for the credential id that this device
 *    last enrolled / authenticated against is registered server-side.
 *  - `other-device-only`: at least one bundle exists but none of them
 *    match this device's local credential id, so the user must
 *    enroll a passkey on this device to back up their key here.
 *  - `empty`: no bundles registered for the current key at all.
 *  - `unknown`: enclave was unreachable; caller should leave state alone.
 */
export type PasskeyDeviceState =
  | 'this-device'
  | 'other-device-only'
  | 'empty'
  | 'unknown'

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
  // The enclave wire carries kek_iv / encrypted_keys as hex
  // (matching BundleBody), but PasskeyCredentialEntry is the legacy
  // base64-flavoured shape that decryptKeyBundle / use-passkey-backup
  // consume. Convert at this boundary so the entry contract stays
  // uniform with the values coming back from
  // fetchLegacyPasskeyCredentials.
  return {
    id: bundle.credential_id,
    iv: hexToB64(bundle.kek_iv),
    encrypted_keys: hexToB64(bundle.encrypted_keys),
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
    if (resp.key_id) {
      const entries = Object.values(resp.bundles).map((bundle) => ({
        ...reshapeBundleToEntry(bundle),
        source: 'enclave' as const,
      }))
      if (entries.length > 0) return entries
      // A registered key with zero bundles is an orphan: the enclave's
      // migrate-all bootstrap stamps a current key before any passkey
      // bundle is written, so a key_id can exist with no way to unlock
      // it. Fall back to the legacy passkey so the user can still
      // recover instead of being forced into manual key entry.
      return await loadLegacyFallback()
    }
    return await loadLegacyFallback()
  } catch (err) {
    if (err instanceof SyncEnclaveError && err.status === 404) {
      return loadLegacyFallback()
    }
    throw err
  }
}

async function loadLegacyFallback(): Promise<PasskeyCredentialEntry[]> {
  const legacy = await fetchLegacyPasskeyCredentials()
  if (legacy.length === 0) return []
  logInfo('falling back to legacy passkey credentials for recovery', {
    component: 'PasskeyKeyStorage',
    action: 'loadLegacyFallback',
    metadata: { count: legacy.length },
  })
  return legacy.map((entry) => ({ ...entry, source: 'legacy' as const }))
}

/**
 * Candidate set for the recovery wizard. Unlike loadPasskeyCredentials
 * — which prefers enclave bundles and hides legacy credentials once any
 * bundle exists — this returns the UNION of the enclave bundles and the
 * user's legacy credentials (deduped by id, enclave winning conflicts).
 * That lets a device whose own pre-enclave passkey predates the v2 key
 * registry still be offered for recovery after another platform has
 * registered the key, so it can unlock the shared CEK and enroll itself.
 */
export async function loadRecoveryCandidates(): Promise<
  PasskeyCredentialEntry[]
> {
  let enclaveEntries: PasskeyCredentialEntry[] = []
  try {
    const resp = await enclaveKeyCurrent()
    if (resp.key_id) {
      enclaveEntries = Object.values(resp.bundles).map((bundle) => ({
        ...reshapeBundleToEntry(bundle),
        source: 'enclave' as const,
      }))
    }
  } catch (err) {
    if (!(err instanceof SyncEnclaveError) || err.status !== 404) throw err
  }
  const legacyEntries = await loadLegacyFallback()
  const byId = new Map<string, PasskeyCredentialEntry>()
  for (const entry of legacyEntries) byId.set(entry.id, entry)
  for (const entry of enclaveEntries) byId.set(entry.id, entry)
  return [...byId.values()]
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
      keyB64: requirePrimaryKeyB64(),
      credentialId,
      idempotencyKey: newIdempotencyKey(),
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
 * Classify the user's passkey bundle state from the perspective of
 * the current device. The data model already supports many bundles
 * per user (one per WebAuthn credential id), so the right question
 * is not "does any bundle exist?" but "does *this* device have its
 * own bundle?". A user with an Apple passkey on a Mac and Windows
 * Hello on a PC should see "active" on each device and a
 * "set up passkey on this device" prompt when signing in on a new
 * machine.
 */
export async function getPasskeyDeviceState(
  localCredentialId: string | null,
): Promise<PasskeyDeviceState> {
  try {
    const entries = await loadPasskeyCredentials()
    if (entries.length === 0) return 'empty'
    if (
      localCredentialId &&
      entries.some((entry) => entry.id === localCredentialId)
    ) {
      return 'this-device'
    }
    return 'other-device-only'
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
    const current = await enclaveKeyCurrent()
    const primaryBytes = encryptionService.getAlternativeKeyBytes(keys.primary)
    if (!primaryBytes) {
      throw new Error('passkey-key-storage: primary key is not decodable')
    }
    const localKeyId = await deriveKeyIdHex(primaryBytes)
    // Bundle the raw CEK bytes — same wire shape iOS and every other
    // v2 client uses. The legacy `{primary, alternatives, ...}` JSON
    // envelope is no longer written by anyone.
    const wrapped = await wrapCekForCredential({
      credentialId,
      kek,
      cek: primaryBytes,
    })

    if (!current.key_id) {
      try {
        await enclaveRegisterKey({
          keyB64: bytesToBase64(primaryBytes),
          ifMatch: IF_MATCH_SENTINELS.AnyKey,
          createdVia:
            keys.authorizationMode === 'explicit_start_fresh'
              ? 'start_fresh'
              : 'passkey',
          idempotencyKey: newIdempotencyKey(),
          initialBundle: {
            credentialId,
            kekIvHex: wrapped.kekIvHex,
            encryptedKeysHex: wrapped.wrappedKeyHex,
          },
        })
      } catch (err) {
        if (
          err instanceof SyncEnclaveError &&
          err.code === WIRE_CODES.ExistingDataUnderOtherKey
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
      if (keys.authorizationMode === 'explicit_start_fresh') {
        // The user has chosen to wipe everything and bind a brand-new
        // CEK. Route through register-key with created_via=start_fresh
        // so the controlplane atomically drops every blob row, returns
        // the v2 attachment ids it removed, and lets the enclave drain
        // those from buckets — all without the cross-key conflict
        // guard firing.
        await enclaveRegisterKey({
          keyB64: bytesToBase64(primaryBytes),
          ifMatch: current.etag || IF_MATCH_SENTINELS.AnyKey,
          createdVia: 'start_fresh',
          idempotencyKey: newIdempotencyKey(),
          initialBundle: {
            credentialId,
            kekIvHex: wrapped.kekIvHex,
            encryptedKeysHex: wrapped.wrappedKeyHex,
          },
        })
        const created = await enclaveKeyCurrent()
        const bundleVersion = created.bundles[credentialId]?.bundle_version ?? 1
        logInfo('start_fresh wipe + key register completed', {
          component: 'PasskeyKeyStorage',
          action: 'storeEncryptedKeys',
          metadata: { credentialId, bundleVersion },
        })
        return { syncVersion: bundleVersion, bundleVersion }
      }
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
      keyB64: bytesToBase64(primaryBytes),
      credentialId,
      kekIvHex: wrapped.kekIvHex,
      encryptedKeysHex: wrapped.wrappedKeyHex,
      idempotencyKey: newIdempotencyKey(),
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
    const lookup = await tryRetrieveFromEnclave(credentialId, kek)
    if (lookup.bundle) return lookup.bundle
    if (!lookup.enclaveKeyExists) {
      // No registered key yet (or an orphan key with no bundles) — safe
      // to revive any legacy bundle for this credential.
      return await tryRetrieveFromLegacy(credentialId, kek)
    }
    // A key exists but this credential has no enclave bundle. Revive the
    // legacy bundle only when it wraps the SAME current CEK — i.e. a v1
    // user with the same passkey on another platform that hasn't been
    // enrolled yet. A legacy bundle deriving a different key_id is a
    // rotated-away CEK and must never be adopted as primary.
    return await tryRetrieveFromLegacyIfCurrent(
      credentialId,
      kek,
      lookup.currentKeyId,
    )
  } catch (err) {
    logError('Failed to retrieve encrypted keys', err, {
      component: 'PasskeyKeyStorage',
      action: 'retrieveEncryptedKeys',
    })
    return null
  }
}

interface EnclaveBundleLookup {
  bundle: KeyBundle | null
  enclaveKeyExists: boolean
  currentKeyId: string | null
}

async function tryRetrieveFromEnclave(
  credentialId: string,
  kek: CryptoKey,
): Promise<EnclaveBundleLookup> {
  try {
    const resp = await enclaveKeyCurrent()
    if (!resp.key_id) {
      return { bundle: null, enclaveKeyExists: false, currentKeyId: null }
    }
    const bundle = resp.bundles[credentialId]
    if (!bundle) {
      // Treat a key with no bundles at all as "no enclave key" so the
      // legacy passkey fallback runs (orphan key from the migrate-all
      // bootstrap). When other bundles exist but none for this
      // credential, the caller verifies the legacy bundle still wraps
      // the current key before reviving it.
      const hasAnyBundle = Object.keys(resp.bundles).length > 0
      return {
        bundle: null,
        enclaveKeyExists: hasAnyBundle,
        currentKeyId: resp.key_id,
      }
    }
    // Try the v2 raw-CEK shape first — what iOS and the modern
    // webapp flow write. If that succeeds we synthesize the legacy
    // {primary, alternatives:[]} envelope the hook still consumes.
    try {
      const cekBytes = await unwrapCekFromBundle(kek, {
        kekIvHex: bundle.kek_iv,
        wrappedKeyHex: bundle.encrypted_keys,
      } as Parameters<typeof unwrapCekFromBundle>[1])
      return {
        bundle: {
          primary: encryptionService.encodeKeyFromBytes(cekBytes),
          alternatives: [],
        },
        enclaveKeyExists: true,
        currentKeyId: resp.key_id,
      }
    } catch {
      // Pre-v2 webapp wrapped a JSON envelope. Keep the legacy decode
      // as a fallback so users who registered on the old wire still
      // unlock without re-enrolling.
      const decrypted = await decryptKeyBundle(kek, {
        iv: hexToB64(bundle.kek_iv),
        data: hexToB64(bundle.encrypted_keys),
      })
      return {
        bundle: decrypted,
        enclaveKeyExists: true,
        currentKeyId: resp.key_id,
      }
    }
  } catch (err) {
    if (err instanceof SyncEnclaveError && err.status === 404) {
      return { bundle: null, enclaveKeyExists: false, currentKeyId: null }
    }
    throw err
  }
}

async function tryRetrieveFromLegacy(
  credentialId: string,
  kek: CryptoKey,
): Promise<KeyBundle | null> {
  const legacy = await fetchLegacyPasskeyCredentials()
  const entry = legacy.find((e) => e.id === credentialId)
  if (!entry) return null
  return await decryptKeyBundle(kek, {
    iv: entry.iv,
    data: entry.encrypted_keys,
  })
}

/**
 * Revive a legacy bundle for a credential that has no enclave bundle,
 * but only when the CEK it unwraps matches the enclave's current
 * key_id. This is the multi-platform case: a v1 user with the same
 * passkey on another device, where the legacy bundle wraps the very
 * CEK already registered. A mismatch means the legacy bundle is a
 * rotated-away key and must not be adopted.
 */
async function tryRetrieveFromLegacyIfCurrent(
  credentialId: string,
  kek: CryptoKey,
  currentKeyId: string | null,
): Promise<KeyBundle | null> {
  if (!currentKeyId) return null
  const bundle = await tryRetrieveFromLegacy(credentialId, kek)
  if (!bundle) return null
  const primaryBytes = encryptionService.getAlternativeKeyBytes(bundle.primary)
  if (!primaryBytes) return null
  const legacyKeyId = await deriveKeyIdHex(primaryBytes)
  if (legacyKeyId !== currentKeyId) {
    logInfo('skipping legacy passkey bundle for a rotated-away key', {
      component: 'PasskeyKeyStorage',
      action: 'retrieveEncryptedKeys',
    })
    return null
  }
  return bundle
}
