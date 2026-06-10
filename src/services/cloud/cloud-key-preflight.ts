/**
 * Cloud key preflight — checks whether the local CEK is consistent
 * with what the sync enclave reports as the user's current key.
 *
 * Phase 2 of the sync-enclave refactor: this module previously did
 * client-side decrypt probes against legacy /api/* endpoints to
 * detect a key mismatch. The enclave now owns key identity — the
 * authoritative answer is "does the local CEK derive the same KeyID
 * the enclave is reporting?".
 *
 * The exported surface (`inspectRemoteEncryptedState`,
 * `validateCurrentPrimaryKey`, and their result types) is preserved
 * so the `usePasskeyBackup` hook and recovery modal continue to call
 * the same API. The internals route through `enclaveKeyCurrent`.
 */

import { deriveKeyIdHex } from '../sync-enclave/key-bundle'
import {
  base64ToBytes,
  keyCurrent as enclaveKeyCurrent,
} from '../sync-enclave/sync-api'
import { requirePrimaryKeyB64 } from './cek-encoding'
import {
  legacyKeyProbeAllowsBinding,
  probeLegacyDataWithLocalKeys,
} from './legacy-key-probe'

export type CloudRemoteState = 'empty' | 'exists' | 'unknown'
export type CloudKeyValidationProbe = 'none' | 'profile' | 'project' | 'chat'

export interface CloudKeyValidationResult {
  remoteState: CloudRemoteState
  canWrite: boolean
  probe: CloudKeyValidationProbe
  message?: string
}

/**
 * Raised when activating a CEK is rejected by the preflight check.
 * Carries the enclave's `remoteState` so callers can distinguish a
 * genuine key mismatch (`exists`) from a verification outage
 * (`unknown`, e.g. attestation/network failure) and surface an
 * accurate message instead of always blaming the key.
 */
export class CloudKeySetupError extends Error {
  readonly remoteState: CloudRemoteState

  constructor(message: string, remoteState: CloudRemoteState) {
    super(message)
    this.name = 'CloudKeySetupError'
    this.remoteState = remoteState
  }
}

/**
 * Probe the enclave for the user's current key. A registered key id
 * implies the user already has cloud data. A legacy (v0/v1) user can
 * have un-migrated data with no key registered yet — the enclave
 * reports that via `has_data`, so treat it as existing remote state
 * too. Without this check such a user would be misrouted into
 * first-time "enable backups" setup instead of recovery, and the
 * fresh key would be refused (or strand their chats).
 */
export async function inspectRemoteEncryptedState(): Promise<CloudRemoteState> {
  try {
    const resp = await enclaveKeyCurrent()
    return resp.key_id || resp.has_data ? 'exists' : 'empty'
  } catch {
    return 'unknown'
  }
}

/**
 * Validate the local CEK against the enclave's current KeyID.
 *
 * Behavior matches the legacy probe at the API boundary:
 *
 *  - No local key loaded                       → unknown / canWrite=false
 *  - No remote key/data registered             → empty   / canWrite=true
 *  - Legacy data but no registered key         → exists  / probe local keys
 *  - Local KeyID matches enclave KeyID         → exists  / canWrite=true
 *  - Local KeyID differs from enclave KeyID    → exists  / canWrite=false
 *                                                + "doesn't match" message
 *  - Enclave probe fails (network, 5xx)        → unknown / canWrite=false
 */
export async function validateCurrentPrimaryKey(): Promise<CloudKeyValidationResult> {
  let primaryKeyB64: string
  try {
    primaryKeyB64 = requirePrimaryKeyB64()
  } catch {
    return unknownResult('none', 'No encryption key is currently loaded.')
  }

  let resp: Awaited<ReturnType<typeof enclaveKeyCurrent>>
  try {
    resp = await enclaveKeyCurrent()
  } catch {
    return unknownResult(
      'none',
      "We couldn't verify whether encrypted cloud data already exists.",
    )
  }

  if (!resp.key_id && !resp.has_data) {
    return {
      remoteState: 'empty',
      canWrite: true,
      probe: 'none',
    }
  }

  if (!resp.key_id && resp.has_data) {
    const probe = await probeLegacyDataWithLocalKeys({
      action: 'validateCurrentPrimaryKey',
    })
    if (probe.outcome === 'transient_failure') {
      return unknownResult(
        'none',
        "We couldn't verify whether this key unlocks your encrypted cloud data.",
      )
    }
    if (!legacyKeyProbeAllowsBinding(probe)) {
      return blockedResult('none')
    }
    return {
      remoteState: 'exists',
      canWrite: true,
      probe: 'none',
    }
  }

  let localKeyId: string
  try {
    localKeyId = await deriveKeyIdHex(base64ToBytes(primaryKeyB64))
  } catch {
    return blockedResult('none')
  }

  if (localKeyId === resp.key_id) {
    return {
      remoteState: 'exists',
      canWrite: true,
      probe: 'none',
    }
  }

  return blockedResult('none')
}

function unknownResult(
  probe: CloudKeyValidationProbe,
  message: string,
): CloudKeyValidationResult {
  return { remoteState: 'unknown', canWrite: false, probe, message }
}

function blockedResult(
  probe: CloudKeyValidationProbe,
): CloudKeyValidationResult {
  return {
    remoteState: 'exists',
    canWrite: false,
    probe,
    message:
      "This key doesn't match your existing cloud data. Try using your existing key instead.",
  }
}
