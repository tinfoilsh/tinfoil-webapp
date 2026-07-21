/**
 * Passkey Service — thin app-side facade over @tinfoilsh/passkey-kit.
 *
 * The WebAuthn PRF ceremonies, HKDF key derivation, and local caching all
 * live in the SDK; this module preserves the historical export surface so
 * hooks and flows keep importing the same names.
 */

import type { PrfPasskeyResult } from '@tinfoilsh/passkey-kit'
import { passkeyKit } from './kit'

export {
  PasskeyTimeoutError,
  PrfNotSupportedError,
} from '@tinfoilsh/passkey-kit'
export type { PrfPasskeyResult } from '@tinfoilsh/passkey-kit'

/**
 * Get the cached PRF result from local storage if available.
 * The PRF output is deterministic for a given passkey, so we can reuse it
 * to avoid re-prompting biometrics on key updates.
 */
export function getCachedPrfResult(): PrfPasskeyResult | null {
  return passkeyKit.getCachedPrfResult()
}

/**
 * Clear the cached PRF result (e.g., on sign-out).
 */
export function clearCachedPrfResult(): void {
  passkeyKit.clearCachedPrfResult()
}

/**
 * Create a new PRF-capable passkey for the given user.
 *
 * Returns the credential ID and PRF output, or null if PRF is not supported
 * by the authenticator or the user cancels.
 */
export function createPrfPasskey(
  userId: string,
  userEmail: string,
  displayName: string,
): Promise<PrfPasskeyResult | null> {
  return passkeyKit.createPasskey({
    id: userId,
    name: userEmail,
    displayName: displayName || userEmail,
  })
}

/**
 * Authenticate with an existing PRF passkey to derive the PRF output.
 *
 * @param credentialIds - base64url-encoded credential IDs to allow. Pass all
 *   known PRF credential IDs so the browser can select the right one.
 * @returns The matched credential ID and PRF output, or null on failure/cancel.
 */
export function authenticatePrfPasskey(
  credentialIds: string[],
  options: { throwOnCancel?: boolean } = {},
): Promise<PrfPasskeyResult | null> {
  return passkeyKit.authenticate(credentialIds, options)
}

/**
 * Derive an AES-256-GCM Key Encryption Key (KEK) from PRF output using HKDF.
 */
export function deriveKeyEncryptionKey(
  prfOutput: ArrayBuffer,
): Promise<CryptoKey> {
  return passkeyKit.deriveKek(prfOutput)
}
