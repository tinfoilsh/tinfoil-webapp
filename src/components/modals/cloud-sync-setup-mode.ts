import {
  CloudKeySetupError,
  inspectRemoteEncryptedState,
} from '@/services/cloud/cloud-key-preflight'

export type CloudKeySetupMode = 'recoverExisting' | 'explicitStartFresh'

/**
 * Why a key activation failed. `key_mismatch` means the enclave
 * confirmed different cloud data exists under another key;
 * `verification_unavailable` means we couldn't reach/verify the
 * enclave (attestation or network outage) so the key may well be
 * correct; `invalid_key` covers malformed input or unexpected errors.
 */
export type CloudKeySetupFailureReason =
  | 'key_mismatch'
  | 'verification_unavailable'
  | 'invalid_key'

export type CloudKeySetupResult =
  | { ok: true }
  | { ok: false; reason: CloudKeySetupFailureReason }

export function classifyCloudKeySetupError(
  error: unknown,
): CloudKeySetupFailureReason {
  if (error instanceof CloudKeySetupError) {
    if (error.remoteState === 'unknown') return 'verification_unavailable'
    if (error.remoteState === 'exists') return 'key_mismatch'
  }
  return 'invalid_key'
}

export function describeCloudKeySetupFailure(
  reason: CloudKeySetupFailureReason,
): { title: string; description: string } {
  switch (reason) {
    case 'key_mismatch':
      return {
        title: 'Key does not match',
        description:
          "This key doesn't match your existing cloud data. Try using your existing key instead.",
      }
    case 'verification_unavailable':
      return {
        title: 'Could not verify right now',
        description:
          "We couldn't reach the secure enclave to verify your cloud data. Check your connection and try again in a moment.",
      }
    case 'invalid_key':
      return {
        title: 'Invalid key',
        description: 'The encryption key you entered is invalid.',
      }
  }
}

interface DetermineGeneratedKeySetupModeOptions {
  manualRecoveryNeeded: boolean
}

export async function determineGeneratedKeySetupMode({
  manualRecoveryNeeded,
}: DetermineGeneratedKeySetupModeOptions): Promise<CloudKeySetupMode> {
  if (manualRecoveryNeeded) {
    return 'explicitStartFresh'
  }

  try {
    const remoteState = await inspectRemoteEncryptedState()
    return remoteState === 'exists' ? 'explicitStartFresh' : 'recoverExisting'
  } catch {
    return 'recoverExisting'
  }
}
