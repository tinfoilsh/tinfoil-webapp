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

import { encryptionService } from '../encryption/encryption-service'
import { deriveKeyIdHex } from '../sync-enclave/key-bundle'
import {
  base64ToBytes,
  keyCurrent as enclaveKeyCurrent,
} from '../sync-enclave/sync-api'

export type CloudRemoteState = 'empty' | 'exists' | 'unknown'
export type CloudKeyValidationProbe = 'none' | 'profile' | 'project' | 'chat'

export interface CloudKeyValidationResult {
  remoteState: CloudRemoteState
  canWrite: boolean
  probe: CloudKeyValidationProbe
  message?: string
}

/**
 * Probe the enclave for the user's current key. A registered key id
 * implies the user already has cloud data (the controlplane created
 * the row when the first piece of sealed data was written, and the
 * enclave refuses register-key with EXISTING_DATA_UNDER_OTHER_KEY
 * unless created_via=start_fresh). The legacy chat/project/profile
 * fan-out is no longer needed because the enclave consolidates the
 * answer.
 */
export async function inspectRemoteEncryptedState(): Promise<CloudRemoteState> {
  try {
    const resp = await enclaveKeyCurrent()
    return resp.key_id ? 'exists' : 'empty'
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
 *  - No remote key registered                  → empty   / canWrite=true
 *  - Local KeyID matches enclave KeyID         → exists  / canWrite=true
 *  - Local KeyID differs from enclave KeyID    → exists  / canWrite=false
 *                                                + "doesn't match" message
 *  - Enclave probe fails (network, 5xx)        → unknown / canWrite=false
 */
export async function validateCurrentPrimaryKey(): Promise<CloudKeyValidationResult> {
  const currentKey = encryptionService.getKey()
  if (!currentKey) {
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

  if (!resp.key_id) {
    return {
      remoteState: 'empty',
      canWrite: true,
      probe: 'none',
    }
  }

  let localKeyId: string
  try {
    localKeyId = await deriveKeyIdHex(base64ToBytes(currentKey))
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
