/**
 * Passkey Key Storage — enclave-backed.
 *
 * The enclave is the source of truth: passkey bundles live under
 * `user_key_bundles` rows scoped to a single `user_keys.key_id`.
 * Storage and recovery operations route through the enclave's
 * `key-current` / `register-key` / `add-bundle` / `remove-bundle`
 * wire.
 *
 * Enclave bundles use the raw wrapped-CEK wire shape shared with iOS.
 *
 * Optimistic concurrency is enforced by the enclave: register-key uses
 * `if_match='*'` for first-time writes and the harness returns
 * KEY_MISMATCH when a key already exists;
 * add-bundle is idempotent per credential_id. The legacy
 * `sync_version` / `bundle_version` counters are synthesized from the
 * enclave's `bundle_version` so callers that read them keep working.
 */

import { base64ToUint8Array } from '@/utils/binary-codec'
import { logError, logInfo } from '@/utils/error-handling'
import type { PRFResult, WrappedKey } from '@tinfoilsh/passkey-kit'
import { encryptionService } from '../encryption/encryption-service'
import {
  bytesToBase64,
  addBundle as enclaveAddBundle,
  keyCurrent as enclaveKeyCurrent,
  registerKey as enclaveRegisterKey,
  removeBundle as enclaveRemoveBundle,
  hexToB64,
  newIdempotencyKey,
} from '../harness/keys'
import { HarnessError } from '../harness/sse'
import { requirePrimaryKeyB64 } from '../keys/cek-encoding'
import type { CloudKeyAuthorizationMode } from '../keys/cloud-key-authorization'
import { deriveTinfoilKeyIdHex } from '../keys/tinfoil-key-id'
import { HARNESS_KEY_CODES, IF_MATCH_SENTINELS } from '../keys/wire-contract'
import {
  evaluateTinfoilCredential,
  passkeyKeyManager,
  tinfoilWrappedKeyFromEnclaveBundle,
} from './kit'

const AES_GCM_IV_BYTES = 12

/** AES-GCM ciphertext bytes for one wrapped 32-byte key and its 16-byte tag. */
export const TINFOIL_RAW_WRAPPED_KEY_CIPHERTEXT_BYTES = 48

export interface KeyBundle {
  primary: string
  /**
   * Decryption-only history retained for legacy v0/v1 rows. Registered
   * bundles wrap only the current primary CEK; authorizing the key sends
   * these to keysMigrateAll, which reseals the rows older keys sealed.
   */
  alternatives: string[]
  authorizationMode?: CloudKeyAuthorizationMode
}

export interface TinfoilWrappedKeyBundle {
  primary: WrappedKey
  alternatives: WrappedKey[]
}

export interface PasskeyCredentialEntry {
  id: string
  encrypted_keys: string
  iv: string
  created_at: string
  sync_version: number
  bundle_version?: number
}

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
  knownBundleVersion?: number | null
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

function validateKeyBundle(keys: KeyBundle): {
  primary: Uint8Array
  alternatives: Uint8Array[]
} {
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

export function tinfoilWrappedKeyBundleToEnclave(
  wrappedKeys: TinfoilWrappedKeyBundle,
): {
  credentialId: string
  kekIvHex: string
  encryptedKeysHex: string
} {
  return {
    credentialId: wrappedKeys.primary.credentialId,
    kekIvHex: wrappedKeys.primary.kekIvHex,
    encryptedKeysHex: wrappedKeys.primary.wrappedKeyHex,
  }
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
  // (matching BundleBody), but PasskeyCredentialEntry is the
  // base64-flavoured shape that use-passkey-backup consumes. Convert
  // at this boundary.
  return {
    id: bundle.credential_id,
    iv: hexToB64(bundle.kek_iv),
    encrypted_keys: hexToB64(bundle.encrypted_keys),
    created_at: bundle.created_at ?? new Date(0).toISOString(),
    sync_version: bundleVersion,
    bundle_version: bundleVersion,
  }
}

// --- Public API ------------------------------------------------------------

export async function loadPasskeyCredentials(
  options: {
    signal?: AbortSignal
  } = {},
): Promise<PasskeyCredentialEntry[]> {
  const resp = await enclaveKeyCurrent(options.signal)
  if (!resp.key_id) return []
  return Object.values(resp.bundles).map(reshapeBundleToEntry)
}

export async function deletePasskeyCredential(
  credentialId: string,
): Promise<boolean> {
  try {
    const resp = await enclaveKeyCurrent()
    if (!resp.key_id || !resp.bundles[credentialId]) return true
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
 * Persist the user's passkey-wrapped primary CEK in the enclave.
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
 * The enclave owns concurrency so there is no client-side rev loop.
 * The returned counters mirror what the enclave reports for the
 * freshly written bundle.
 */
export async function storeEncryptedKeys(
  wrappedKeys: TinfoilWrappedKeyBundle,
  keys: KeyBundle,
  options: StoreEncryptedKeysOptions = {},
): Promise<{ syncVersion: number; bundleVersion: number } | null> {
  try {
    const credentialId = wrappedKeys.primary.credentialId
    const primaryBytes = validateKeyBundle(keys).primary
    const enclaveBundle = tinfoilWrappedKeyBundleToEnclave(wrappedKeys)
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
          err instanceof HarnessError &&
          err.code === HARNESS_KEY_CODES.KeyMismatch
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
  prfResult?: PRFResult
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  )
}

type RecoveryCandidate = {
  entry: PasskeyCredentialEntry
  wrappedKey: WrappedKey
}

function parseRecoveryCandidate(
  entry: PasskeyCredentialEntry,
): RecoveryCandidate | null {
  try {
    const iv = base64ToUint8Array(entry.iv)
    const encrypted = base64ToUint8Array(entry.encrypted_keys)
    if (iv.length !== AES_GCM_IV_BYTES) return null

    if (encrypted.length === TINFOIL_RAW_WRAPPED_KEY_CIPHERTEXT_BYTES) {
      return {
        entry,
        wrappedKey: tinfoilWrappedKeyFromEnclaveBundle({
          credentialId: entry.id,
          kekIvHex: bytesToHex(iv),
          wrappedKeyHex: bytesToHex(encrypted),
        }),
      }
    }
    return null
  } catch {
    return null
  }
}

async function recoverGenericCandidateFromManagerCache(
  candidates: RecoveryCandidate[],
): Promise<{
  candidate: RecoveryCandidate
  keyBundle: KeyBundle
} | null> {
  const recovered = await passkeyKeyManager.recoverKeyFromCache({
    wrappedKeys: candidates.map((candidate) => candidate.wrappedKey),
  })
  if (!recovered) return null
  const candidate = candidates.find(
    (item) => item.entry.id === recovered.credentialId,
  )
  if (!candidate) return null
  return {
    candidate,
    keyBundle: {
      primary: encryptionService.encodeKeyFromBytes(recovered.key),
      alternatives: [],
    },
  }
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

  if (options.cachedOnly) {
    const generic = await recoverGenericCandidateFromManagerCache(candidates)
    if (!generic) return null
    return {
      keyBundle: generic.keyBundle,
      credentialId: generic.candidate.entry.id,
      syncVersion: generic.candidate.entry.sync_version ?? null,
      bundleVersion: generic.candidate.entry.bundle_version ?? 0,
    }
  }

  const evaluated = await evaluateTinfoilCredential(
    candidates.map((candidate) => candidate.entry.id),
  )
  if (!evaluated) return null
  const credentialId = evaluated.credentialId
  const prfResult = evaluated.prfResult
  const candidate = candidates.find((item) => item.entry.id === credentialId)
  if (!candidate) return null

  let keyBundle: KeyBundle | null
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
  if (!keyBundle) return null
  return {
    keyBundle,
    credentialId,
    syncVersion: candidate.entry.sync_version ?? null,
    bundleVersion: candidate.entry.bundle_version ?? 0,
    prfResult,
  }
}

export async function addWrappedKeyForCurrentKey(input: {
  wrappedKeys: TinfoilWrappedKeyBundle
  cek: Uint8Array
  keyIdHex: string
}): Promise<void> {
  const envelope = tinfoilWrappedKeyBundleToEnclave(input.wrappedKeys)
  await enclaveAddBundle({
    keyId: input.keyIdHex,
    keyB64: bytesToBase64(input.cek),
    credentialId: envelope.credentialId,
    kekIvHex: envelope.kekIvHex,
    encryptedKeysHex: envelope.encryptedKeysHex,
    idempotencyKey: newIdempotencyKey(),
  })
}
