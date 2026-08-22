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
 * The legacy decoder primitives (`encryptKeyBundle`,
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
import {
  decodeWrappedKeyRecord,
  encodeWrappedKeyRecord,
  type PRFResult,
  type WrappedKey,
} from '@tinfoilsh/passkey-kit'
import { requirePrimaryKeyB64 } from '../cloud/cek-encoding'
import type { CloudKeyAuthorizationMode } from '../cloud/cloud-key-authorization'
import { encryptionService } from '../encryption/encryption-service'
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
import { deriveTinfoilKeyIdHex } from '../sync-enclave/tinfoil-key-id'
import { IF_MATCH_SENTINELS, WIRE_CODES } from '../sync-enclave/wire-contract'
import {
  evaluateTinfoilCredential,
  getCachedCredentialId,
  getCachedPrfOutputForLegacyBundle,
  passkeyKeyManager,
  TINFOIL_PASSKEY_PROFILE,
  tinfoilWrappedKeyFromEnclaveBundle,
} from './kit'
import { fetchLegacyPasskeyCredentials } from './legacy-passkey-credentials'

const AES_GCM_IV_BYTES = 12
const AES_GCM_TAG_BYTES = 16

/** AES-GCM ciphertext bytes for one wrapped 32-byte key and its 16-byte tag. */
export const TINFOIL_RAW_WRAPPED_KEY_CIPHERTEXT_BYTES = 48

/** Version of the app-owned multi-key envelope stored in encrypted_keys. */
export const TINFOIL_GENERIC_KEY_ENVELOPE_VERSION = 1

const TINFOIL_GENERIC_KEY_ENVELOPE_MAX_ALTERNATIVES = 64
const TINFOIL_GENERIC_KEY_ENVELOPE_MAX_BYTES = 128 * 1024

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

export interface TinfoilWrappedKeyBundle {
  primary: WrappedKey
  alternatives: WrappedKey[]
}

interface TinfoilGenericKeyEnvelope {
  version: typeof TINFOIL_GENERIC_KEY_ENVELOPE_VERSION
  authorizationMode: CloudKeyAuthorizationMode
  primary: string
  alternatives: string[]
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
  'this-device' | 'other-device-only' | 'empty' | 'unknown'

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

function validateKeyBundle(keys: KeyBundle): {
  primary: Uint8Array
  alternatives: Uint8Array[]
} {
  if (
    keys.alternatives.length > TINFOIL_GENERIC_KEY_ENVELOPE_MAX_ALTERNATIVES
  ) {
    throw new Error('Passkey key bundle has too many alternatives')
  }
  const primary = encryptionService.getAlternativeKeyBytes(keys.primary)
  if (!primary) throw new Error('Passkey primary key is invalid')
  const seen = new Set([keys.primary])
  const alternatives = keys.alternatives.map((alternative) => {
    if (seen.has(alternative)) {
      throw new Error('Passkey key bundle contains duplicate alternatives')
    }
    seen.add(alternative)
    const bytes = encryptionService.getAlternativeKeyBytes(alternative)
    if (!bytes) throw new Error('Passkey alternative key is invalid')
    return bytes
  })
  return { primary, alternatives }
}

function decodeCanonicalWrappedKeyRecord(record: string): WrappedKey {
  const wrappedKey = decodeWrappedKeyRecord(record)
  if (encodeWrappedKeyRecord(wrappedKey) !== record) {
    throw new Error('Wrapped key record is not canonical')
  }
  return wrappedKey
}

function encodeGenericKeyEnvelope(
  wrappedKeys: TinfoilWrappedKeyBundle,
  keys: KeyBundle,
): Uint8Array {
  validateKeyBundle(keys)
  if (wrappedKeys.alternatives.length !== keys.alternatives.length) {
    throw new Error('Wrapped alternative key count does not match key bundle')
  }
  const credentialId = wrappedKeys.primary.credentialId
  if (
    wrappedKeys.alternatives.some(
      (wrappedKey) => wrappedKey.credentialId !== credentialId,
    )
  ) {
    throw new Error('Wrapped keys must use one credential')
  }
  const envelope: TinfoilGenericKeyEnvelope = {
    version: TINFOIL_GENERIC_KEY_ENVELOPE_VERSION,
    authorizationMode:
      keys.authorizationMode === 'explicit_start_fresh'
        ? 'explicit_start_fresh'
        : 'validated',
    primary: encodeWrappedKeyRecord(wrappedKeys.primary),
    alternatives: wrappedKeys.alternatives.map(encodeWrappedKeyRecord),
  }
  const bytes = new TextEncoder().encode(JSON.stringify(envelope))
  if (bytes.length > TINFOIL_GENERIC_KEY_ENVELOPE_MAX_BYTES) {
    throw new Error('Passkey key envelope is too large')
  }
  return bytes
}

export function tinfoilWrappedKeyBundleToEnclave(
  wrappedKeys: TinfoilWrappedKeyBundle,
  keys: KeyBundle,
): {
  credentialId: string
  kekIvHex: string
  encryptedKeysHex: string
} {
  return {
    credentialId: wrappedKeys.primary.credentialId,
    kekIvHex: wrappedKeys.primary.kekIvHex,
    encryptedKeysHex: bytesToHex(encodeGenericKeyEnvelope(wrappedKeys, keys)),
  }
}

function parseGenericKeyEnvelope(
  bytes: Uint8Array,
): TinfoilGenericKeyEnvelope | null {
  if (bytes.length > TINFOIL_GENERIC_KEY_ENVELOPE_MAX_BYTES) return null
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
  if (!text.trimStart().startsWith('{')) return null
  const parsed = JSON.parse(text) as Record<string, unknown>
  const fields = Object.keys(parsed).sort()
  const expectedFields = [
    'alternatives',
    'authorizationMode',
    'primary',
    'version',
  ]
  if (
    fields.length !== expectedFields.length ||
    fields.some((field, index) => field !== expectedFields[index]) ||
    parsed.version !== TINFOIL_GENERIC_KEY_ENVELOPE_VERSION ||
    (parsed.authorizationMode !== 'validated' &&
      parsed.authorizationMode !== 'explicit_start_fresh') ||
    typeof parsed.primary !== 'string' ||
    !Array.isArray(parsed.alternatives) ||
    parsed.alternatives.length >
      TINFOIL_GENERIC_KEY_ENVELOPE_MAX_ALTERNATIVES ||
    parsed.alternatives.some((record) => typeof record !== 'string')
  ) {
    throw new Error('Invalid Tinfoil generic key envelope')
  }
  decodeCanonicalWrappedKeyRecord(parsed.primary)
  for (const record of parsed.alternatives as string[]) {
    decodeCanonicalWrappedKeyRecord(record)
  }
  return parsed as unknown as TinfoilGenericKeyEnvelope
}

export async function wrapTinfoilKeyBundle(
  primary: WrappedKey,
  keys: KeyBundle,
  prfResult?: PRFResult,
): Promise<TinfoilWrappedKeyBundle | null> {
  const keyBytes = validateKeyBundle(keys)
  const alternatives: WrappedKey[] = []
  for (const alternative of keyBytes.alternatives) {
    const wrappedKey = prfResult
      ? await passkeyKeyManager.wrapKeyWithPRFResult({
          keyMaterial: alternative,
          credentialId: primary.credentialId,
          prfResult,
        })
      : await passkeyKeyManager.rewrapKeyFromCache({ key: alternative })
    if (!wrappedKey || wrappedKey.credentialId !== primary.credentialId) {
      return null
    }
    alternatives.push(wrappedKey)
  }
  return { primary, alternatives }
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
    if (!resp.key_id || !resp.bundles[credentialId]) {
      // No enclave bundle to remove. If the credential only exists in
      // the read-only legacy table the client cannot delete it, so
      // report failure instead of a false success that would leave the
      // passkey able to unlock the user's data.
      const legacy = await fetchLegacyPasskeyCredentials()
      return !legacy.some((entry) => entry.id === credentialId)
    }
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
 * Persist the user's passkey-wrapped generic key envelope in the enclave.
 * Behavior mirrors the legacy contract the
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
  wrappedKeys: TinfoilWrappedKeyBundle,
  keys: KeyBundle,
  options: StoreEncryptedKeysOptions = {},
): Promise<{ syncVersion: number; bundleVersion: number } | null> {
  try {
    const credentialId = wrappedKeys.primary.credentialId
    const primaryBytes = validateKeyBundle(keys).primary
    const enclaveBundle = tinfoilWrappedKeyBundleToEnclave(wrappedKeys, keys)
    const localKeyId = await deriveTinfoilKeyIdHex(primaryBytes)
    const current = await enclaveKeyCurrent()

    if (!current.key_id) {
      try {
        await enclaveRegisterKey({
          keyB64: bytesToBase64(primaryBytes),
          ifMatch: IF_MATCH_SENTINELS.AnyKey,
          // When the controlplane reports un-migrated legacy data
          // (key_id IS NULL rows) but no current key, this CEK is the
          // existing v1 key being adopted into v2, not a brand-new one.
          // Register it as 'recovery' so the cross-key guard allows it
          // (a fresh 'passkey' key is refused over legacy data) and the
          // legacy rows can then re-seal under it. The bundle is still
          // attached, so the key is never stranded without a passkey.
          createdVia:
            keys.authorizationMode === 'explicit_start_fresh'
              ? 'start_fresh'
              : current.has_data
                ? 'recovery'
                : 'passkey',
          idempotencyKey: newIdempotencyKey(),
          initialBundle: {
            credentialId,
            kekIvHex: enclaveBundle.kekIvHex,
            encryptedKeysHex: enclaveBundle.encryptedKeysHex,
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
            kekIvHex: enclaveBundle.kekIvHex,
            encryptedKeysHex: enclaveBundle.encryptedKeysHex,
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
      kekIvHex: enclaveBundle.kekIvHex,
      encryptedKeysHex: enclaveBundle.encryptedKeysHex,
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

export interface RecoveredPasskeyKeyBundle {
  keyBundle: KeyBundle
  credentialId: string
  syncVersion: number | null
  bundleVersion: number
  source?: 'enclave' | 'legacy'
  prfResult?: PRFResult
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  )
}

type RecoveryCandidate =
  | {
      kind: 'envelope'
      entry: PasskeyCredentialEntry
      envelope: TinfoilGenericKeyEnvelope
      wrappedKeys: TinfoilWrappedKeyBundle
    }
  | {
      kind: 'raw'
      entry: PasskeyCredentialEntry
      wrappedKey: WrappedKey
    }
  | { kind: 'legacy'; entry: PasskeyCredentialEntry }

function parseRecoveryCandidate(
  entry: PasskeyCredentialEntry,
): RecoveryCandidate | null {
  try {
    const iv = base64ToUint8Array(entry.iv)
    const encrypted = base64ToUint8Array(entry.encrypted_keys)
    if (iv.length !== AES_GCM_IV_BYTES) return null

    const envelope = parseGenericKeyEnvelope(encrypted)
    if (envelope) {
      const primary = decodeCanonicalWrappedKeyRecord(envelope.primary)
      const alternatives = envelope.alternatives.map(
        decodeCanonicalWrappedKeyRecord,
      )
      const records = [primary, ...alternatives]
      if (
        records.some((wrappedKey) => wrappedKey.credentialId !== entry.id) ||
        new Set(records.map((wrappedKey) => wrappedKey.kekIvHex)).size !==
          records.length ||
        new Set(envelope.alternatives).size !== envelope.alternatives.length ||
        envelope.alternatives.includes(envelope.primary)
      ) {
        return null
      }
      return {
        kind: 'envelope',
        entry,
        envelope,
        wrappedKeys: { primary, alternatives },
      }
    }

    if (encrypted.length === TINFOIL_RAW_WRAPPED_KEY_CIPHERTEXT_BYTES) {
      return {
        kind: 'raw',
        entry,
        wrappedKey: tinfoilWrappedKeyFromEnclaveBundle({
          credentialId: entry.id,
          kekIvHex: bytesToHex(iv),
          wrappedKeyHex: bytesToHex(encrypted),
        }),
      }
    }
    if (encrypted.length >= AES_GCM_TAG_BYTES) return { kind: 'legacy', entry }
    return null
  } catch {
    return null
  }
}

async function unwrapGenericEnvelope(
  candidate: Extract<RecoveryCandidate, { kind: 'envelope' }>,
  prfResult: PRFResult,
): Promise<KeyBundle | null> {
  try {
    const primary = await passkeyKeyManager.unwrapKeyWithPRFResult({
      wrappedKey: candidate.wrappedKeys.primary,
      prfResult,
    })
    const alternatives = await Promise.all(
      candidate.wrappedKeys.alternatives.map((wrappedKey) =>
        passkeyKeyManager.unwrapKeyWithPRFResult({ wrappedKey, prfResult }),
      ),
    )
    const keyBundle: KeyBundle = {
      primary: encryptionService.encodeKeyFromBytes(primary),
      alternatives: alternatives.map((key) =>
        encryptionService.encodeKeyFromBytes(key),
      ),
      authorizationMode: candidate.envelope.authorizationMode,
    }
    validateKeyBundle(keyBundle)
    return keyBundle
  } catch {
    return null
  }
}

async function deriveLegacyKek(prfOutput: Uint8Array): Promise<CryptoKey> {
  const input = await crypto.subtle.importKey(
    'raw',
    prfOutput as BufferSource,
    'HKDF',
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(),
      info: TINFOIL_PASSKEY_PROFILE.hkdfInfo as BufferSource,
    },
    input,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

async function recoverLegacyEntry(
  entry: PasskeyCredentialEntry,
  evaluatedPrfOutput?: Uint8Array,
): Promise<KeyBundle | null> {
  const prfOutput = evaluatedPrfOutput ?? getCachedPrfOutputForLegacyBundle()
  if (!prfOutput) return null
  try {
    return await decryptKeyBundle(await deriveLegacyKek(prfOutput), {
      iv: entry.iv,
      data: entry.encrypted_keys,
    })
  } catch {
    return null
  }
}

async function acceptLegacyBundleForCurrentKey(
  entry: PasskeyCredentialEntry,
  bundle: KeyBundle,
): Promise<boolean> {
  if (entry.source !== 'legacy') return true
  let currentKeyId: string | null = null
  try {
    currentKeyId = (await enclaveKeyCurrent()).key_id
  } catch (error) {
    if (!(error instanceof SyncEnclaveError) || error.status !== 404)
      return false
  }
  if (!currentKeyId) return true
  const primaryBytes = encryptionService.getAlternativeKeyBytes(bundle.primary)
  if (!primaryBytes) return false
  const legacyKeyId = await deriveTinfoilKeyIdHex(primaryBytes)
  if (legacyKeyId === currentKeyId) return true
  logInfo('skipping legacy passkey bundle for a rotated-away key', {
    component: 'PasskeyKeyStorage',
    action: 'recoverPasskeyKeyBundle',
    metadata: { credentialId: entry.id, legacyKeyId, currentKeyId },
  })
  return false
}

export async function recoverPasskeyKeyBundle(
  entries: PasskeyCredentialEntry[],
  options: { cachedOnly?: boolean } = {},
): Promise<RecoveredPasskeyKeyBundle | null> {
  if (entries.length === 0) return null
  const candidates = entries
    .map(parseRecoveryCandidate)
    .filter((candidate): candidate is RecoveryCandidate => candidate !== null)
  if (candidates.length === 0) return null

  let credentialId: string | null
  let prfResult: PRFResult | undefined

  if (options.cachedOnly) {
    credentialId = getCachedCredentialId()
    const output = getCachedPrfOutputForLegacyBundle()
    if (output) prfResult = { output }
  } else {
    const evaluated = await evaluateTinfoilCredential(
      candidates.map((candidate) => candidate.entry.id),
    )
    if (!evaluated) return null
    credentialId = evaluated.credentialId
    prfResult = evaluated.prfResult
  }

  if (!credentialId || !prfResult) return null
  const candidate = candidates.find((item) => item.entry.id === credentialId)
  if (!candidate) return null

  let keyBundle: KeyBundle | null
  if (candidate.kind === 'envelope') {
    keyBundle = await unwrapGenericEnvelope(candidate, prfResult)
  } else if (candidate.kind === 'raw') {
    try {
      const key = await passkeyKeyManager.unwrapKeyWithPRFResult({
        wrappedKey: candidate.wrappedKey,
        prfResult,
      })
      keyBundle = {
        primary: encryptionService.encodeKeyFromBytes(key),
        alternatives: [],
      }
    } catch {
      keyBundle = null
    }
  } else {
    keyBundle = await recoverLegacyEntry(candidate.entry, prfResult.output)
  }
  if (
    !keyBundle ||
    !(await acceptLegacyBundleForCurrentKey(candidate.entry, keyBundle))
  ) {
    return null
  }
  return {
    keyBundle,
    credentialId,
    syncVersion: candidate.entry.sync_version ?? null,
    bundleVersion: candidate.entry.bundle_version ?? 0,
    source: candidate.entry.source,
    prfResult: options.cachedOnly ? undefined : prfResult,
  }
}

export async function addWrappedKeyForCurrentKey(input: {
  wrappedKeys: TinfoilWrappedKeyBundle
  keyBundle: KeyBundle
  cek: Uint8Array
  keyIdHex: string
}): Promise<void> {
  const envelope = tinfoilWrappedKeyBundleToEnclave(
    input.wrappedKeys,
    input.keyBundle,
  )
  await enclaveAddBundle({
    keyId: input.keyIdHex,
    keyB64: bytesToBase64(input.cek),
    credentialId: envelope.credentialId,
    kekIvHex: envelope.kekIvHex,
    encryptedKeysHex: envelope.encryptedKeysHex,
    idempotencyKey: newIdempotencyKey(),
  })
}

export async function promoteRecoveredCekToEnclave(input: {
  cek: Uint8Array
  keyBundle: KeyBundle
  credentialId: string
  prfResult: PRFResult
}): Promise<boolean> {
  let wrappedKeys: TinfoilWrappedKeyBundle | null
  let keyIdHex: string
  try {
    const primary = await passkeyKeyManager.wrapKeyWithPRFResult({
      keyMaterial: input.cek,
      credentialId: input.credentialId,
      prfResult: input.prfResult,
    })
    wrappedKeys = await wrapTinfoilKeyBundle(
      primary,
      input.keyBundle,
      input.prfResult,
    )
    if (!wrappedKeys) return false
    keyIdHex = await deriveTinfoilKeyIdHex(input.cek)
  } catch (error) {
    logError('Failed to prepare recovered passkey bundle', error, {
      component: 'PasskeyKeyStorage',
      action: 'promoteRecoveredCekToEnclave',
    })
    return false
  }
  let current: Awaited<ReturnType<typeof enclaveKeyCurrent>> | null = null
  try {
    current = await enclaveKeyCurrent()
  } catch (error) {
    if (!(error instanceof SyncEnclaveError) || error.status !== 404)
      return false
  }
  if (current?.key_id) {
    if (current.key_id !== keyIdHex) return false
    if (current.bundles[input.credentialId]) return true
    try {
      await addWrappedKeyForCurrentKey({
        wrappedKeys,
        keyBundle: input.keyBundle,
        cek: input.cek,
        keyIdHex,
      })
      return true
    } catch (error) {
      logError('Failed to add recovered passkey bundle', error, {
        component: 'PasskeyKeyStorage',
        action: 'promoteRecoveredCekToEnclave',
      })
      return false
    }
  }
  try {
    const envelope = tinfoilWrappedKeyBundleToEnclave(
      wrappedKeys,
      input.keyBundle,
    )
    await enclaveRegisterKey({
      keyB64: bytesToBase64(input.cek),
      ifMatch: IF_MATCH_SENTINELS.AnyKey,
      createdVia: 'recovery',
      idempotencyKey: newIdempotencyKey(),
      initialBundle: {
        credentialId: envelope.credentialId,
        kekIvHex: envelope.kekIvHex,
        encryptedKeysHex: envelope.encryptedKeysHex,
      },
    })
    return true
  } catch (error) {
    logError('Failed to register recovered passkey bundle', error, {
      component: 'PasskeyKeyStorage',
      action: 'promoteRecoveredCekToEnclave',
    })
    return false
  }
}
