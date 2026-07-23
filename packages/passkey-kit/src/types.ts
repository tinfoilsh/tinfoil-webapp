import type { StorageAdapter } from './storage'

/** Structured logging hooks; the SDK never writes to the console itself. */
export interface PasskeyKitLogger {
  info?(message: string, metadata?: Record<string, unknown>): void
  error?(
    message: string,
    error?: unknown,
    metadata?: Record<string, unknown>,
  ): void
}

export interface PasskeyKitStorageKeys {
  /** Key under which the cached PRF result is persisted. */
  prfResult: string
  /** Key under which this device's own credential id is persisted. */
  localCredentialId: string
}

/**
 * Overrides for the messages on errors the SDK throws. Useful for branding
 * or localization; the error classes themselves stay the same, so
 * `instanceof` checks are unaffected.
 */
export interface PasskeyKitErrorMessages {
  /** Message used for `PrfNotSupportedError`. */
  prfNotSupported?: string
  /** Message used for `PasskeyTimeoutError`. */
  timeout?: string
}

export interface PasskeyKitConfig {
  /** WebAuthn relying party id (e.g. `example.com`, or `localhost` in dev). */
  rpId: string
  /** Human-readable relying party name shown in passkey prompts. */
  rpName: string
  /**
   * Input to the PRF `eval.first` salt. Must stay stable across all clients
   * of the same protocol: changing it changes every derived KEK.
   * Defaults to the Tinfoil v1 protocol constant.
   */
  prfSaltInput?: string | Uint8Array
  /**
   * HKDF info string used for domain separation when deriving the KEK from
   * the PRF output. Defaults to the Tinfoil v1 protocol constant.
   */
  hkdfInfo?: string | Uint8Array
  /**
   * Local persistence for the PRF cache and this device's credential id.
   * Defaults to a best-effort `localStorage` adapter; pass `null` to
   * disable local persistence entirely.
   */
  storage?: StorageAdapter | null
  storageKeys?: Partial<PasskeyKitStorageKeys>
  /** Timeout passed to the WebAuthn API (some browsers ignore this). */
  webauthnTimeoutMs?: number
  /**
   * Hard client-side timeout guarding against providers that never resolve
   * the WebAuthn promise. When exceeded, `PasskeyTimeoutError` is thrown.
   */
  stuckTimeoutMs?: number
  /** Custom messages for the errors the SDK throws. */
  errorMessages?: PasskeyKitErrorMessages
  logger?: PasskeyKitLogger
}

/** Identity attached to a newly created passkey. */
export interface PasskeyUser {
  /** Stable opaque user id (becomes the WebAuthn user handle). */
  id: string
  /** Account identifier shown in passkey pickers (usually an email). */
  name: string
  /** Friendly display name; falls back to `name` when omitted. */
  displayName?: string
}

/** Result of a successful PRF ceremony (create or authenticate). */
export interface PrfPasskeyResult {
  /** base64url-encoded credential id. */
  credentialId: string
  /** Raw 32-byte PRF output; treat as secret key material. */
  prfOutput: ArrayBuffer
}

/** A CEK wrapped under a passkey-derived KEK with AES-256-GCM. */
export interface WrappedCek {
  /** base64url-encoded credential id whose PRF output wraps this CEK. */
  credentialId: string
  /** 12-byte AES-GCM IV, hex-encoded. */
  kekIvHex: string
  /** Wrapped CEK ciphertext (including GCM tag), hex-encoded. */
  wrappedKeyHex: string
}

/** Result of the high-level enroll flow: create passkey + wrap CEK. */
export interface EnrollResult {
  credentialId: string
  /** Ciphertext safe to persist server-side. */
  wrappedCek: WrappedCek
  /**
   * Device-local secret state (PRF output). Already persisted through the
   * storage adapter when one is configured; returned so hosts with custom
   * persistence can store it themselves.
   */
  prfResult: PrfPasskeyResult
}

/** Result of the high-level unlock flow: authenticate + unwrap CEK. */
export interface UnlockResult {
  credentialId: string
  /** The recovered raw 32-byte CEK. */
  cek: Uint8Array
}
