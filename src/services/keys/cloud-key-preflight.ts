// Checks the browser CEK against the key identity reported by the harness.

import {
  base64ToBytes,
  keyCurrent as enclaveKeyCurrent,
  type KeyCurrentResponse,
} from '../harness/keys'
import { deriveTinfoilKeyIdHex } from '../keys/tinfoil-key-id'
import { requirePrimaryKeyB64 } from './cek-encoding'

export type CloudRemoteState = 'empty' | 'exists' | 'unknown'

// A known remote state carries the key the harness reported, so callers
// act on the same answer the validation used.
export type CloudKeyValidationResult =
  | { remoteState: 'unknown'; canWrite: false; message: string }
  | {
      remoteState: 'empty' | 'exists'
      canWrite: boolean
      message?: string
      current: KeyCurrentResponse
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
 *  - Legacy data but no registered key         → exists  / canWrite=true
 *  - Local KeyID matches enclave KeyID         → exists  / canWrite=true
 *  - Local KeyID differs from enclave KeyID    → exists  / canWrite=false
 *                                                + "doesn't match" message
 *  - Enclave probe fails (network, 5xx)        → unknown / canWrite=false
 *
 * Legacy (un-keyed) data never blocks the local key: which rows the
 * key can actually unseal is only provable by decrypting, and the
 * migration sweep is self-guarding — the enclave rewraps only rows it
 * successfully decrypts, and anything else stays legacy with a
 * cooldown stamp. Blocking here on a decrypt probe produced false
 * negatives for mixed-key v1 accounts (rows sealed under several
 * historical keys) and silently prevented any migration at all.
 */
export async function validateCurrentPrimaryKey(): Promise<CloudKeyValidationResult> {
  let primaryKeyB64: string
  try {
    primaryKeyB64 = requirePrimaryKeyB64()
  } catch {
    return unknownResult('No encryption key is currently loaded.')
  }

  let current: KeyCurrentResponse
  try {
    current = await enclaveKeyCurrent()
  } catch {
    return unknownResult(
      "We couldn't verify whether encrypted cloud data already exists.",
    )
  }

  if (!current.key_id) {
    return {
      remoteState: current.has_data ? 'exists' : 'empty',
      canWrite: true,
      current,
    }
  }

  let localKeyId: string
  try {
    localKeyId = await deriveTinfoilKeyIdHex(base64ToBytes(primaryKeyB64))
  } catch {
    return blockedResult(current)
  }

  if (localKeyId === current.key_id) {
    return { remoteState: 'exists', canWrite: true, current }
  }

  return blockedResult(current)
}

function unknownResult(message: string): CloudKeyValidationResult {
  return { remoteState: 'unknown', canWrite: false, message }
}

function blockedResult(current: KeyCurrentResponse): CloudKeyValidationResult {
  return {
    remoteState: 'exists',
    canWrite: false,
    current,
    message:
      "This key doesn't match your existing cloud data. Try using your existing key instead.",
  }
}
