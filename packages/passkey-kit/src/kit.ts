/**
 * The main SDK entry point. `createPasskeyKit(config)` binds relying-party
 * configuration, protocol constants, and local persistence into a single
 * object exposing both high-level flows (enroll / unlock / rewrap) and the
 * lower-level ceremony + crypto building blocks.
 */

import { base64ToBytes, bytesToBase64 } from './codec'
import {
  deriveKeyEncryptionKey as deriveKekFromPrf,
  unwrapCek,
  wrapCek,
} from './crypto'
import { browserLocalStorageAdapter, type StorageAdapter } from './storage'
import { detectPrfSupport } from './support'
import type {
  EnrollResult,
  PasskeyKitConfig,
  PasskeyKitStorageKeys,
  PasskeyUser,
  PrfPasskeyResult,
  UnlockResult,
  WrappedCek,
} from './types'
import {
  authenticatePrfPasskey,
  createPrfPasskey,
  type CeremonyContext,
} from './webauthn'

// Tinfoil v1 protocol constants. Kept as defaults so every Tinfoil client
// wrapping the same CEK stays interoperable; override both for a new
// protocol domain.
const DEFAULT_PRF_SALT_INPUT = 'tinfoil-chat-key-encryption'
const DEFAULT_HKDF_INFO = 'tinfoil-chat-kek-v1'

const DEFAULT_STORAGE_KEYS: PasskeyKitStorageKeys = {
  prfResult: 'tinfoil-secret-passkey-prf-output',
  localCredentialId: 'tinfoil-local-passkey-credential-id',
}

const DEFAULT_WEBAUTHN_TIMEOUT_MS = 30_000

// Internal hard timeout to guard against providers (e.g. some
// password-manager browser extensions) that never resolve the
// credentials.create/get promise. Kept tight so users aren't left staring
// at an indefinite spinner; the WebAuthn flow itself should complete well
// within this window once the provider actually prompts.
const DEFAULT_STUCK_TIMEOUT_MS = 10_000

interface PrfCacheEntry {
  credentialId: string
  prfOutput: string // base64-encoded
}

export interface PasskeyKit {
  /** Optimistic device/browser PRF support check (cached per kit). */
  isPrfSupported(): Promise<boolean>
  resetPrfSupportCache(): void

  /**
   * Create a new PRF-capable passkey. Returns null when the user cancels;
   * throws PrfNotSupportedError / PasskeyTimeoutError otherwise on failure.
   */
  createPasskey(user: PasskeyUser): Promise<PrfPasskeyResult | null>
  /**
   * Prompt for an assertion against any of the given credential ids and
   * return the matched credential's PRF output. Null on cancel/failure.
   */
  authenticate(
    credentialIds: string[],
    options?: { throwOnCancel?: boolean },
  ): Promise<PrfPasskeyResult | null>
  /** Derive the AES-256-GCM KEK from a PRF output (HKDF-SHA-256). */
  deriveKek(prfOutput: ArrayBuffer | Uint8Array): Promise<CryptoKey>

  /** Create a passkey and wrap the given CEK under it in one flow. */
  enroll(opts: {
    user: PasskeyUser
    cek: Uint8Array
  }): Promise<EnrollResult | null>
  /** Authenticate against the given wrapped CEKs and unwrap the matching one. */
  unlock(wrappedCeks: WrappedCek[]): Promise<UnlockResult | null>
  /**
   * Re-wrap a CEK using the cached PRF output (no biometric prompt).
   * Returns null when nothing is cached.
   */
  rewrapWithCachedPrf(cek: Uint8Array): Promise<WrappedCek | null>
  /** Wrap a CEK under the KEK of an explicit PRF result. */
  wrapWithPrfResult(
    prfResult: PrfPasskeyResult,
    cek: Uint8Array,
  ): Promise<WrappedCek>
  /** Unwrap a CEK with the KEK of an explicit PRF result. */
  unwrapWithPrfResult(
    prfResult: PrfPasskeyResult,
    wrapped: Pick<WrappedCek, 'kekIvHex' | 'wrappedKeyHex'>,
  ): Promise<Uint8Array>

  /**
   * Cached PRF result from local storage, if any. The PRF output is
   * deterministic for a given passkey, so it can be reused to avoid
   * re-prompting biometrics on key updates.
   */
  getCachedPrfResult(): PrfPasskeyResult | null
  clearCachedPrfResult(): void
  /** Credential id owned by this device (platform attachment), if known. */
  getLocalCredentialId(): string | null
  setLocalCredentialId(credentialId: string): void
  /** Clear all device-local state (e.g. on sign-out). */
  clearLocalState(): void
}

export function createPasskeyKit(config: PasskeyKitConfig): PasskeyKit {
  const logger = config.logger ?? {}
  const storage: StorageAdapter | null =
    config.storage === undefined ? browserLocalStorageAdapter : config.storage
  const storageKeys: PasskeyKitStorageKeys = {
    ...DEFAULT_STORAGE_KEYS,
    ...config.storageKeys,
  }
  const prfSalt =
    typeof config.prfSaltInput === 'string' || config.prfSaltInput === undefined
      ? new TextEncoder().encode(config.prfSaltInput ?? DEFAULT_PRF_SALT_INPUT)
      : config.prfSaltInput
  const hkdfInfo = config.hkdfInfo ?? DEFAULT_HKDF_INFO

  let prfSupportCache: boolean | null = null

  function cachePrfResult(result: PrfPasskeyResult): void {
    if (!storage) return
    const entry: PrfCacheEntry = {
      credentialId: result.credentialId,
      prfOutput: bytesToBase64(new Uint8Array(result.prfOutput)),
    }
    try {
      storage.setItem(storageKeys.prfResult, JSON.stringify(entry))
    } catch {
      // best-effort
    }
  }

  function setLocalCredentialId(credentialId: string): void {
    storage?.setItem(storageKeys.localCredentialId, credentialId)
  }

  // Cross-device hybrid (QR-paired phone, etc.) reports
  // `authenticatorAttachment === 'cross-platform'` on the resulting
  // credential. Caching the cred id in that case would make this
  // device look like it has its own passkey when in reality the user
  // just borrowed another device's passkey for a one-shot unlock.
  // Per WebAuthn L3 §5.2.1, we only treat `authenticatorAttachment`
  // of `'platform'` as "this device truly owns this credential".
  function onPrfResult(
    result: PrfPasskeyResult,
    credential: PublicKeyCredential,
  ): void {
    cachePrfResult(result)
    if (credential.authenticatorAttachment === 'platform') {
      setLocalCredentialId(result.credentialId)
    }
  }

  const ceremonyContext: CeremonyContext = {
    rpId: config.rpId,
    rpName: config.rpName,
    prfSalt,
    webauthnTimeoutMs: config.webauthnTimeoutMs ?? DEFAULT_WEBAUTHN_TIMEOUT_MS,
    stuckTimeoutMs: config.stuckTimeoutMs ?? DEFAULT_STUCK_TIMEOUT_MS,
    logger,
    onPrfResult,
  }

  const deriveKek = (prfOutput: ArrayBuffer | Uint8Array) =>
    deriveKekFromPrf(prfOutput, hkdfInfo)

  async function wrapWithPrfResult(
    prfResult: PrfPasskeyResult,
    cek: Uint8Array,
  ): Promise<WrappedCek> {
    const kek = await deriveKek(prfResult.prfOutput)
    return wrapCek({ credentialId: prfResult.credentialId, kek, cek })
  }

  return {
    async isPrfSupported(): Promise<boolean> {
      if (prfSupportCache !== null) return prfSupportCache
      prfSupportCache = await detectPrfSupport()
      return prfSupportCache
    },

    resetPrfSupportCache(): void {
      prfSupportCache = null
    },

    createPasskey(user: PasskeyUser): Promise<PrfPasskeyResult | null> {
      return createPrfPasskey(ceremonyContext, user)
    },

    authenticate(
      credentialIds: string[],
      options: { throwOnCancel?: boolean } = {},
    ): Promise<PrfPasskeyResult | null> {
      return authenticatePrfPasskey(ceremonyContext, credentialIds, options)
    },

    deriveKek,

    async enroll(opts: {
      user: PasskeyUser
      cek: Uint8Array
    }): Promise<EnrollResult | null> {
      const prfResult = await createPrfPasskey(ceremonyContext, opts.user)
      if (!prfResult) return null
      const wrappedCek = await wrapWithPrfResult(prfResult, opts.cek)
      return { credentialId: prfResult.credentialId, wrappedCek, prfResult }
    },

    async unlock(wrappedCeks: WrappedCek[]): Promise<UnlockResult | null> {
      if (wrappedCeks.length === 0) return null
      const prfResult = await authenticatePrfPasskey(
        ceremonyContext,
        wrappedCeks.map((w) => w.credentialId),
      )
      if (!prfResult) return null
      const match = wrappedCeks.find(
        (w) => w.credentialId === prfResult.credentialId,
      )
      if (!match) {
        logger.error?.(
          'assertion matched a credential with no wrapped CEK',
          undefined,
          { action: 'unlock', credentialId: prfResult.credentialId },
        )
        return null
      }
      const kek = await deriveKek(prfResult.prfOutput)
      const cek = await unwrapCek(kek, match)
      return { credentialId: prfResult.credentialId, cek }
    },

    async rewrapWithCachedPrf(cek: Uint8Array): Promise<WrappedCek | null> {
      const cached = this.getCachedPrfResult()
      if (!cached) return null
      return wrapWithPrfResult(cached, cek)
    },

    wrapWithPrfResult,

    async unwrapWithPrfResult(
      prfResult: PrfPasskeyResult,
      wrapped: Pick<WrappedCek, 'kekIvHex' | 'wrappedKeyHex'>,
    ): Promise<Uint8Array> {
      const kek = await deriveKek(prfResult.prfOutput)
      return unwrapCek(kek, wrapped)
    },

    getCachedPrfResult(): PrfPasskeyResult | null {
      if (!storage) return null
      try {
        const raw = storage.getItem(storageKeys.prfResult)
        if (!raw) return null
        const entry = JSON.parse(raw) as PrfCacheEntry
        return {
          credentialId: entry.credentialId,
          prfOutput: base64ToBytes(entry.prfOutput).buffer as ArrayBuffer,
        }
      } catch {
        return null
      }
    },

    clearCachedPrfResult(): void {
      storage?.removeItem(storageKeys.prfResult)
    },

    getLocalCredentialId(): string | null {
      return storage?.getItem(storageKeys.localCredentialId) ?? null
    },

    setLocalCredentialId,

    clearLocalState(): void {
      storage?.removeItem(storageKeys.prfResult)
      storage?.removeItem(storageKeys.localCredentialId)
    },
  }
}
