/**
 * Passkey Service — WebAuthn PRF Create/Authenticate + HKDF Key Derivation
 *
 * Uses the WebAuthn PRF extension to derive deterministic 32-byte secrets from
 * a passkey's built-in pseudo-random function. These secrets are then processed
 * through HKDF-SHA256 to produce an AES-256-GCM Key Encryption Key (KEK).
 *
 * References:
 * - W3C WebAuthn Level 3, §10.1.4 (PRF extension): https://w3c.github.io/webauthn/#prf-extension
 * - RFC 5869 (HKDF): https://tools.ietf.org/html/rfc5869
 */

import { SECRET_PASSKEY_PRF_OUTPUT } from '@/constants/storage-keys'
import {
  base64ToUint8Array,
  base64UrlToUint8Array,
  bufferSourceToArrayBuffer,
  uint8ArrayToBase64,
  uint8ArrayToBase64Url,
} from '@/utils/binary-codec'
import { logError, logInfo } from '@/utils/error-handling'

import { setLocalPasskeyCredentialId } from './local-passkey-credential'

export class PrfNotSupportedError extends Error {
  constructor() {
    super(
      "Your passkey provider doesn't support the security features required by Tinfoil. Try using iCloud Keychain, Chrome's built-in passkey manager, or the Passwords app in your device settings.",
    )
    this.name = 'PrfNotSupportedError'
  }
}

export class PasskeyTimeoutError extends Error {
  constructor() {
    super(
      "Your passkey provider took too long to respond. This can happen with some browser extension password managers. Try using iCloud Keychain, Chrome's built-in passkey manager, or the Passwords app in your device settings.",
    )
    this.name = 'PasskeyTimeoutError'
  }
}

// Timeout passed to the WebAuthn API (some browsers ignore this).
const WEBAUTHN_TIMEOUT_MS = 30_000

// Internal hard timeout to guard against providers (e.g. some password-manager
// browser extensions) that never resolve the credentials.create/get promise.
// Kept tight so users aren't left staring at an indefinite spinner; the
// WebAuthn flow itself should complete well within this window once the
// provider actually prompts.
const STUCK_WEBAUTHN_TIMEOUT_MS = 10_000

async function withStuckTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new PasskeyTimeoutError()),
          STUCK_WEBAUTHN_TIMEOUT_MS,
        )
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

// Salt passed to PRF eval.first — the client internally computes:
// SHA-256("WebAuthn PRF" || 0x00 || PRF_EVAL_FIRST)
const PRF_EVAL_FIRST = new TextEncoder().encode('tinfoil-chat-key-encryption')

// HKDF info string for domain separation when deriving the KEK
const HKDF_INFO = new TextEncoder().encode('tinfoil-chat-kek-v1')

const RP_NAME = 'Tinfoil Chat'

export interface PrfPasskeyResult {
  credentialId: string
  prfOutput: ArrayBuffer
}

interface PrfCacheEntry {
  credentialId: string
  prfOutput: string // base64-encoded
}

function cachePrfResult(result: PrfPasskeyResult): void {
  try {
    const entry: PrfCacheEntry = {
      credentialId: result.credentialId,
      prfOutput: uint8ArrayToBase64(new Uint8Array(result.prfOutput)),
    }
    localStorage.setItem(SECRET_PASSKEY_PRF_OUTPUT, JSON.stringify(entry))
  } catch {
    // best-effort
  }
}

// Cross-device hybrid (QR-paired phone, etc.) reports
// `authenticatorAttachment === 'cross-platform'` on the resulting
// credential. Caching the cred id in that case would make this
// device look like it has its own bundle when in reality the user
// just borrowed another device's passkey for a one-shot unlock —
// hiding the "Set Up Passkey on This Device" prompt forever.
// Per WebAuthn L3 §5.2.1, we only treat `authenticatorAttachment`
// of `'platform'` as "this device truly owns this credential".
function rememberCredentialIfLocal(credential: PublicKeyCredential): void {
  if (credential.authenticatorAttachment === 'platform') {
    const credentialId = uint8ArrayToBase64Url(new Uint8Array(credential.rawId))
    setLocalPasskeyCredentialId(credentialId)
  }
}

/**
 * Get the cached PRF result from localStorage if available.
 * The PRF output is deterministic for a given passkey, so we can reuse it
 * to avoid re-prompting biometrics on key updates.
 */
export function getCachedPrfResult(): PrfPasskeyResult | null {
  try {
    const raw = localStorage.getItem(SECRET_PASSKEY_PRF_OUTPUT)
    if (!raw) return null
    const entry = JSON.parse(raw) as PrfCacheEntry
    return {
      credentialId: entry.credentialId,
      prfOutput: base64ToUint8Array(entry.prfOutput).buffer as ArrayBuffer,
    }
  } catch {
    return null
  }
}

/**
 * Clear the cached PRF result (e.g., on sign-out).
 */
export function clearCachedPrfResult(): void {
  try {
    localStorage.removeItem(SECRET_PASSKEY_PRF_OUTPUT)
  } catch {
    // best-effort
  }
}

const RP_ID =
  typeof window !== 'undefined' && window.location.hostname === 'localhost'
    ? 'localhost'
    : 'tinfoil.sh'

/**
 * Create a new PRF-capable passkey for the given user.
 *
 * Returns the credential ID and PRF output, or null if PRF is not supported
 * by the authenticator or the user cancels.
 */
export async function createPrfPasskey(
  userId: string,
  userEmail: string,
  displayName: string,
): Promise<PrfPasskeyResult | null> {
  const userIdBytes = new TextEncoder().encode(userId)

  try {
    const credential = (await withStuckTimeout(
      navigator.credentials.create({
        publicKey: {
          challenge: crypto.getRandomValues(new Uint8Array(32)),
          rp: { id: RP_ID, name: RP_NAME },
          user: {
            id: userIdBytes,
            name: userEmail,
            displayName: displayName || userEmail,
          },
          pubKeyCredParams: [
            { type: 'public-key', alg: -7 }, // ES256
            { type: 'public-key', alg: -257 }, // RS256 (broader compat)
          ],
          authenticatorSelection: {
            residentKey: 'preferred',
            userVerification: 'required',
          },
          timeout: WEBAUTHN_TIMEOUT_MS,
          extensions: {
            prf: { eval: { first: PRF_EVAL_FIRST } },
          },
        },
      }),
    )) as PublicKeyCredential | null

    if (!credential) {
      return null
    }

    const extensionResults = credential.getClientExtensionResults()
    const prfResults = extensionResults.prf

    if (!prfResults?.enabled) {
      logInfo('Authenticator does not support PRF', {
        component: 'PasskeyService',
        action: 'createPrfPasskey',
      })
      throw new PrfNotSupportedError()
    }

    const credentialId = uint8ArrayToBase64Url(new Uint8Array(credential.rawId))

    // Some authenticators return PRF results during creation, others don't.
    // "Not all authenticators support evaluating the PRFs during credential
    // creation so outputs may, or may not, be provided."
    // — https://w3c.github.io/webauthn/#prf-extension (eval description)
    if (prfResults.results?.first) {
      const result = {
        credentialId,
        prfOutput: bufferSourceToArrayBuffer(prfResults.results.first),
      }
      cachePrfResult(result)
      rememberCredentialIfLocal(credential)
      return result
    }

    // PRF enabled but no results during create — do an immediate get()
    logInfo(
      'PRF enabled but no results during creation, doing immediate auth',
      {
        component: 'PasskeyService',
        action: 'createPrfPasskey',
      },
    )
    // Pass throwOnCancel so a user-cancelled assertion surfaces as a
    // DOMException we can handle below — otherwise a `null` return would
    // be indistinguishable from "provider returned no PRF output" and we'd
    // show the misleading "PRF not supported" error for a plain cancel.
    const postCreateAuth = await authenticatePrfPasskey([credentialId], {
      throwOnCancel: true,
    })
    if (!postCreateAuth) {
      // The provider claimed PRF support during creation but didn't deliver
      // a PRF output on the immediately-following assertion. Treat this as
      // a lack of real PRF support rather than a silent failure.
      throw new PrfNotSupportedError()
    }
    return postCreateAuth
  } catch (error) {
    if (error instanceof PrfNotSupportedError) throw error
    if (error instanceof PasskeyTimeoutError) throw error

    // DOMException with name "NotAllowedError" means the user cancelled
    if (error instanceof DOMException && error.name === 'NotAllowedError') {
      logInfo('User cancelled passkey creation', {
        component: 'PasskeyService',
        action: 'createPrfPasskey',
      })
      return null
    }

    logError('Failed to create PRF passkey', error, {
      component: 'PasskeyService',
      action: 'createPrfPasskey',
    })
    return null
  }
}

/**
 * Authenticate with an existing PRF passkey to derive the PRF output.
 *
 * @param credentialIds - base64url-encoded credential IDs to allow. Pass all
 *   known PRF credential IDs so the browser can select the right one.
 * @returns The matched credential ID and PRF output, or null on failure/cancel.
 */
export async function authenticatePrfPasskey(
  credentialIds: string[],
  options: { throwOnCancel?: boolean } = {},
): Promise<PrfPasskeyResult | null> {
  const { throwOnCancel = false } = options
  const allowCredentials: PublicKeyCredentialDescriptor[] = credentialIds.map(
    (id) => ({
      id: base64UrlToUint8Array(id),
      type: 'public-key',
    }),
  )

  try {
    const assertion = (await withStuckTimeout(
      navigator.credentials.get({
        publicKey: {
          challenge: crypto.getRandomValues(new Uint8Array(32)),
          rpId: RP_ID,
          allowCredentials,
          userVerification: 'required',
          timeout: WEBAUTHN_TIMEOUT_MS,
          extensions: {
            prf: { eval: { first: PRF_EVAL_FIRST } },
          },
        },
      }),
    )) as PublicKeyCredential | null

    if (!assertion) {
      return null
    }

    const extensionResults = assertion.getClientExtensionResults()
    const prfOutput = extensionResults.prf?.results?.first

    if (!prfOutput) {
      logError('PRF output missing from assertion', undefined, {
        component: 'PasskeyService',
        action: 'authenticatePrfPasskey',
      })
      return null
    }

    const result = {
      credentialId: uint8ArrayToBase64Url(new Uint8Array(assertion.rawId)),
      prfOutput: bufferSourceToArrayBuffer(prfOutput),
    }
    cachePrfResult(result)
    rememberCredentialIfLocal(assertion)
    return result
  } catch (error) {
    if (error instanceof PasskeyTimeoutError) throw error

    if (error instanceof DOMException && error.name === 'NotAllowedError') {
      logInfo('User cancelled passkey authentication', {
        component: 'PasskeyService',
        action: 'authenticatePrfPasskey',
      })
      if (throwOnCancel) throw error
      return null
    }

    logError('Failed to authenticate with PRF passkey', error, {
      component: 'PasskeyService',
      action: 'authenticatePrfPasskey',
    })
    return null
  }
}

/**
 * Derive an AES-256-GCM Key Encryption Key (KEK) from PRF output using HKDF.
 *
 * Raw PRF output is treated as Input Keying Material (IKM), not used directly as a key.
 * HKDF with a purpose-binding info string produces the final non-extractable CryptoKey.
 */
export async function deriveKeyEncryptionKey(
  prfOutput: ArrayBuffer,
): Promise<CryptoKey> {
  // Import PRF output as HKDF master key — non-extractable, derive-only
  const masterKey = await crypto.subtle.importKey(
    'raw',
    prfOutput,
    'HKDF',
    false, // non-extractable
    ['deriveKey'],
  )

  // Derive AES-256-GCM KEK with purpose-binding info string
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(), // empty salt is fine for high-entropy IKM (RFC 5869 §3.1)
      info: HKDF_INFO,
    },
    masterKey,
    { name: 'AES-GCM', length: 256 },
    false, // non-extractable
    ['encrypt', 'decrypt'],
  )
}
