/**
 * Typed errors thrown by the SDK. Callers should branch on `instanceof`
 * (never on message strings) to drive recovery flows.
 */

/** Base class for every error the SDK throws on its own behalf. */
export class PasskeyKitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PasskeyKitError'
  }
}

const PROVIDER_SUGGESTION =
  "Try using iCloud Keychain, Chrome's built-in passkey manager, or the Passwords app in your device settings."

/**
 * The authenticator created a credential but does not support the WebAuthn
 * PRF extension, so no key material can be derived from it.
 */
export class PrfNotSupportedError extends PasskeyKitError {
  constructor(
    message = `Your passkey provider doesn't support the security features required by this app. ${PROVIDER_SUGGESTION}`,
  ) {
    super(message)
    this.name = 'PrfNotSupportedError'
  }
}

/**
 * The passkey provider never resolved the WebAuthn promise within the
 * SDK's hard timeout (some password-manager browser extensions hang).
 */
export class PasskeyTimeoutError extends PasskeyKitError {
  constructor(
    message = `Your passkey provider took too long to respond. This can happen with some browser extension password managers. ${PROVIDER_SUGGESTION}`,
  ) {
    super(message)
    this.name = 'PasskeyTimeoutError'
  }
}
