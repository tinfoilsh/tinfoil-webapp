/**
 * PRF support detection.
 *
 * Checks whether the current browser/platform supports the WebAuthn PRF
 * extension. This is an optimistic check — actual PRF support is only
 * confirmed when a credential is created with prf.enabled: true in the
 * response. If creation fails, callers should fall back to a manual flow.
 *
 * Detection strategy:
 * 1. Check window.PublicKeyCredential exists (basic WebAuthn support)
 * 2. Check isUserVerifyingPlatformAuthenticatorAvailable() (biometric/PIN authenticator present)
 * 3. Optionally check getClientCapabilities() for explicit PRF support signal (new API, not universal)
 */
export async function detectPrfSupport(): Promise<boolean> {
  if (typeof window === 'undefined') {
    return false
  }

  if (!window.PublicKeyCredential) {
    return false
  }

  // Check that a platform authenticator is available (Face ID, Touch ID, Windows Hello, etc.)
  try {
    const available =
      await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()
    if (!available) {
      return false
    }
  } catch {
    return false
  }

  // If getClientCapabilities is available, use it for a more precise check.
  // This API is newer and may not be present in all browsers.
  try {
    if (typeof PublicKeyCredential.getClientCapabilities === 'function') {
      const caps = await PublicKeyCredential.getClientCapabilities()
      if (caps && typeof caps === 'object') {
        // The shape of this API varies across browser versions.
        // Chrome returns a map-like object; check for extension-prf or prf key.
        const hasPrf =
          (caps as Record<string, boolean>)['extension-prf'] === true ||
          (caps as Record<string, boolean>)['prf'] === true
        if (hasPrf) {
          return true
        }
        // If getClientCapabilities is available but doesn't report PRF,
        // that's a strong negative signal on platforms that implement it.
        // However, since this API is still evolving, we don't treat absence
        // as definitive — fall through to the optimistic path.
      }
    }
  } catch {
    // getClientCapabilities not available or threw — fall through
  }

  // Optimistic: platform authenticator is available, WebAuthn is supported.
  // Actual PRF support will be confirmed during credential creation.
  return true
}
