/**
 * PRF Support Detection — delegates to @tinfoilsh/passkey-kit.
 *
 * This is an optimistic check — actual PRF support is only confirmed when a
 * credential is created with prf.enabled: true in the response. If creation
 * fails, callers should fall back to the manual key flow.
 */

import { passkeyKit } from './kit'

/**
 * Returns true if the browser/platform likely supports WebAuthn PRF.
 * Result is cached after the first call.
 */
export function isPrfSupported(): Promise<boolean> {
  return passkeyKit.isPrfSupported()
}

/**
 * Clear the cached result. Useful for testing.
 */
export function resetPrfSupportCache(): void {
  passkeyKit.resetPrfSupportCache()
}
