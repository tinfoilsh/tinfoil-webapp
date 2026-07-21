/**
 * WebAuthn PRF ceremonies: credential creation and assertion with the PRF
 * extension. Pure ceremony logic — persistence of the results is handled
 * by the kit through the hooks on {@link CeremonyContext}.
 */

import {
  base64UrlToBytes,
  bufferSourceToArrayBuffer,
  bytesToBase64Url,
} from './codec'
import { PasskeyTimeoutError, PrfNotSupportedError } from './errors'
import type {
  PasskeyKitErrorMessages,
  PasskeyKitLogger,
  PasskeyUser,
  PrfPasskeyResult,
} from './types'

export interface CeremonyContext {
  rpId: string
  rpName: string
  /** Salt passed to PRF eval.first — the client internally computes
   *  SHA-256("WebAuthn PRF" || 0x00 || salt). */
  prfSalt: Uint8Array
  webauthnTimeoutMs: number
  stuckTimeoutMs: number
  errorMessages?: PasskeyKitErrorMessages
  logger: PasskeyKitLogger
  /** Invoked after every successful PRF ceremony so the kit can cache state. */
  onPrfResult(result: PrfPasskeyResult, credential: PublicKeyCredential): void
}

async function withStuckTimeout<T>(
  promise: Promise<T>,
  ctx: CeremonyContext,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new PasskeyTimeoutError(ctx.errorMessages?.timeout)),
          ctx.stuckTimeoutMs,
        )
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Create a new PRF-capable passkey for the given user.
 *
 * Returns the credential ID and PRF output, or null if the user cancels.
 * Throws {@link PrfNotSupportedError} when the authenticator cannot supply
 * PRF output and {@link PasskeyTimeoutError} when the provider hangs.
 */
export async function createPrfPasskey(
  ctx: CeremonyContext,
  user: PasskeyUser,
): Promise<PrfPasskeyResult | null> {
  const userIdBytes = new TextEncoder().encode(user.id)

  try {
    const credential = (await withStuckTimeout(
      navigator.credentials.create({
        publicKey: {
          challenge: crypto.getRandomValues(new Uint8Array(32)),
          rp: { id: ctx.rpId, name: ctx.rpName },
          user: {
            id: userIdBytes,
            name: user.name,
            displayName: user.displayName || user.name,
          },
          pubKeyCredParams: [
            { type: 'public-key', alg: -7 }, // ES256
            { type: 'public-key', alg: -257 }, // RS256 (broader compat)
          ],
          authenticatorSelection: {
            residentKey: 'preferred',
            userVerification: 'required',
          },
          timeout: ctx.webauthnTimeoutMs,
          extensions: {
            prf: { eval: { first: ctx.prfSalt as BufferSource } },
          },
        },
      }),
      ctx,
    )) as PublicKeyCredential | null

    if (!credential) {
      return null
    }

    const extensionResults = credential.getClientExtensionResults()
    const prfResults = extensionResults.prf

    if (!prfResults?.enabled) {
      ctx.logger.info?.('Authenticator does not support PRF', {
        action: 'createPrfPasskey',
      })
      throw new PrfNotSupportedError(ctx.errorMessages?.prfNotSupported)
    }

    const credentialId = bytesToBase64Url(new Uint8Array(credential.rawId))

    // Some authenticators return PRF results during creation, others don't.
    // "Not all authenticators support evaluating the PRFs during credential
    // creation so outputs may, or may not, be provided."
    // — https://w3c.github.io/webauthn/#prf-extension (eval description)
    if (prfResults.results?.first) {
      const result: PrfPasskeyResult = {
        credentialId,
        prfOutput: bufferSourceToArrayBuffer(prfResults.results.first),
      }
      ctx.onPrfResult(result, credential)
      return result
    }

    // PRF enabled but no results during create — do an immediate get()
    ctx.logger.info?.(
      'PRF enabled but no results during creation, doing immediate auth',
      { action: 'createPrfPasskey' },
    )
    // Pass throwOnCancel so a user-cancelled assertion surfaces as a
    // DOMException we can handle below — otherwise a `null` return would
    // be indistinguishable from "provider returned no PRF output" and we'd
    // show the misleading "PRF not supported" error for a plain cancel.
    const postCreateAuth = await authenticatePrfPasskey(ctx, [credentialId], {
      throwOnCancel: true,
    })
    if (!postCreateAuth) {
      // The provider claimed PRF support during creation but didn't deliver
      // a PRF output on the immediately-following assertion. Treat this as
      // a lack of real PRF support rather than a silent failure.
      throw new PrfNotSupportedError(ctx.errorMessages?.prfNotSupported)
    }
    return postCreateAuth
  } catch (error) {
    if (error instanceof PrfNotSupportedError) throw error
    if (error instanceof PasskeyTimeoutError) throw error

    // DOMException with name "NotAllowedError" means the user cancelled
    if (error instanceof DOMException && error.name === 'NotAllowedError') {
      ctx.logger.info?.('User cancelled passkey creation', {
        action: 'createPrfPasskey',
      })
      return null
    }

    ctx.logger.error?.('Failed to create PRF passkey', error, {
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
  ctx: CeremonyContext,
  credentialIds: string[],
  options: { throwOnCancel?: boolean } = {},
): Promise<PrfPasskeyResult | null> {
  const { throwOnCancel = false } = options
  const allowCredentials: PublicKeyCredentialDescriptor[] = credentialIds.map(
    (id) => ({
      id: base64UrlToBytes(id) as BufferSource,
      type: 'public-key',
    }),
  )

  try {
    const assertion = (await withStuckTimeout(
      navigator.credentials.get({
        publicKey: {
          challenge: crypto.getRandomValues(new Uint8Array(32)),
          rpId: ctx.rpId,
          allowCredentials,
          userVerification: 'required',
          timeout: ctx.webauthnTimeoutMs,
          extensions: {
            prf: { eval: { first: ctx.prfSalt as BufferSource } },
          },
        },
      }),
      ctx,
    )) as PublicKeyCredential | null

    if (!assertion) {
      ctx.logger.info?.('passkey assertion returned no credential', {
        action: 'authenticatePrfPasskey',
        allowedCredentials: credentialIds.length,
      })
      return null
    }

    const extensionResults = assertion.getClientExtensionResults()
    const prfOutput = extensionResults.prf?.results?.first

    if (!prfOutput) {
      ctx.logger.error?.('PRF output missing from assertion', undefined, {
        action: 'authenticatePrfPasskey',
      })
      return null
    }

    const result: PrfPasskeyResult = {
      credentialId: bytesToBase64Url(new Uint8Array(assertion.rawId)),
      prfOutput: bufferSourceToArrayBuffer(prfOutput),
    }
    ctx.onPrfResult(result, assertion)
    return result
  } catch (error) {
    if (error instanceof PasskeyTimeoutError) throw error

    if (error instanceof DOMException && error.name === 'NotAllowedError') {
      // NotAllowedError covers both a user cancel and the case where the
      // provider has no usable credential for any of the allowed ids
      // (e.g. the passkey was created in a different browser/profile and
      // never persisted on this device).
      ctx.logger.info?.(
        'passkey authentication not allowed (cancelled or no usable credential)',
        {
          action: 'authenticatePrfPasskey',
          allowedCredentials: credentialIds.length,
        },
      )
      if (throwOnCancel) throw error
      return null
    }

    ctx.logger.error?.('Failed to authenticate with PRF passkey', error, {
      action: 'authenticatePrfPasskey',
    })
    return null
  }
}
