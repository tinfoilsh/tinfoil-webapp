import {
  LOCAL_PASSKEY_CREDENTIAL_ID,
  SECRET_PASSKEY_PRF_OUTPUT,
} from '@/constants/storage-keys'
import { base64ToUint8Array, uint8ArrayToBase64 } from '@/utils/binary-codec'
import {
  createPasskeyKeyManager,
  PasskeyKeyError,
  type CachedPRFResult,
  type EvaluatedCredential,
  type PasskeyCapability,
  type PasskeyKeyProfile,
  type PasskeyKeyStorage,
  type PasskeyUser,
  type WrappedKey,
} from '@tinfoilsh/passkey-kit'

const textEncoder = new TextEncoder()

const relyingPartyId =
  typeof window !== 'undefined' && window.location.hostname === 'localhost'
    ? 'localhost'
    : 'tinfoil.sh'

export const TINFOIL_PASSKEY_PROFILE: PasskeyKeyProfile = {
  version: 1,
  relyingPartyId,
  prfSalt: textEncoder.encode('tinfoil-chat-key-encryption'),
  hkdfInfo: textEncoder.encode('tinfoil-chat-kek-v1'),
}

interface LegacyCachedPrfResult {
  credentialId: string
  prfOutput: string
}

function readCachedPrfResult(): CachedPRFResult | null {
  try {
    if (typeof localStorage === 'undefined') return null
    const raw = localStorage.getItem(SECRET_PASSKEY_PRF_OUTPUT)
    if (!raw) return null
    const stored = JSON.parse(raw) as LegacyCachedPrfResult
    return {
      profile: TINFOIL_PASSKEY_PROFILE,
      credentialId: stored.credentialId,
      prfOutput: base64ToUint8Array(stored.prfOutput),
    }
  } catch {
    return null
  }
}

export const tinfoilPasskeyStorage: PasskeyKeyStorage = {
  loadCachedPRFResult: readCachedPrfResult,
  saveCachedPRFResult(result) {
    try {
      if (typeof localStorage === 'undefined') return
      const stored: LegacyCachedPrfResult = {
        credentialId: result.credentialId,
        prfOutput: uint8ArrayToBase64(result.prfOutput),
      }
      localStorage.setItem(SECRET_PASSKEY_PRF_OUTPUT, JSON.stringify(stored))
    } catch {
      // best-effort
    }
  },
  loadLocalCredentialId() {
    try {
      if (typeof localStorage === 'undefined') return null
      return localStorage.getItem(LOCAL_PASSKEY_CREDENTIAL_ID)
    } catch {
      return null
    }
  },
  saveLocalCredentialId(credentialId) {
    try {
      if (typeof localStorage === 'undefined') return
      localStorage.setItem(LOCAL_PASSKEY_CREDENTIAL_ID, credentialId)
    } catch {
      // best-effort
    }
  },
  clear() {
    try {
      if (typeof localStorage === 'undefined') return
      localStorage.removeItem(SECRET_PASSKEY_PRF_OUTPUT)
      localStorage.removeItem(LOCAL_PASSKEY_CREDENTIAL_ID)
    } catch {
      // best-effort
    }
  },
}

export const passkeyKeyManager = createPasskeyKeyManager({
  profile: TINFOIL_PASSKEY_PROFILE,
  relyingPartyName: 'Tinfoil Chat',
  storage: tinfoilPasskeyStorage,
})

let capabilityPromise: Promise<PasskeyCapability> | null = null

export function getPasskeyCapability(): Promise<PasskeyCapability> {
  if (!capabilityPromise) {
    const request = passkeyKeyManager.capability({ operation: 'enroll' })
    const cached = request.catch((error) => {
      if (capabilityPromise === cached) capabilityPromise = null
      throw error
    })
    capabilityPromise = cached
  }
  return capabilityPromise
}

export function resetPasskeyCapabilityCache(): void {
  capabilityPromise = null
}

export function clearCachedPrfResult(): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.removeItem(SECRET_PASSKEY_PRF_OUTPUT)
  } catch {
    // best-effort
  }
}

export function getCachedCredentialId(): string | null {
  return readCachedPrfResult()?.credentialId ?? null
}

export function getCachedPrfOutputForLegacyBundle(): Uint8Array | null {
  return readCachedPrfResult()?.prfOutput ?? null
}

export function getLocalCredentialId(): string | null {
  return tinfoilPasskeyStorage.loadLocalCredentialId()
}

export function setLocalCredentialId(credentialId: string): void {
  tinfoilPasskeyStorage.saveLocalCredentialId(credentialId)
}

export function tinfoilWrappedKeyFromEnclaveBundle(input: {
  credentialId: string
  kekIvHex: string
  wrappedKeyHex: string
}): WrappedKey {
  return {
    profile: TINFOIL_PASSKEY_PROFILE,
    credentialId: input.credentialId,
    kekIvHex: input.kekIvHex,
    wrappedKeyHex: input.wrappedKeyHex,
  }
}

export function enclaveBundleFromTinfoilWrappedKey(wrappedKey: WrappedKey): {
  credentialId: string
  kekIvHex: string
  encryptedKeysHex: string
} {
  return {
    credentialId: wrappedKey.credentialId,
    kekIvHex: wrappedKey.kekIvHex,
    encryptedKeysHex: wrappedKey.wrappedKeyHex,
  }
}

export type TinfoilPasskeyErrorKind =
  'unsupported' | 'cancelled' | 'timeout' | 'failed'

export function classifyTinfoilPasskeyError(
  error: unknown,
): TinfoilPasskeyErrorKind {
  if (!(error instanceof PasskeyKeyError)) return 'failed'
  if (error.category === 'unsupported') return 'unsupported'
  if (error.category === 'cancelled') return 'cancelled'
  if (error.category === 'timeout') return 'timeout'
  return 'failed'
}

export class PrfNotSupportedError extends Error {
  constructor() {
    super(
      "Your passkey provider doesn't support the security features required by Tinfoil. " +
        "Try using iCloud Keychain, Chrome's built-in passkey manager, or the Passwords app in your device settings.",
    )
    this.name = 'PrfNotSupportedError'
  }
}

export class PasskeyTimeoutError extends Error {
  constructor() {
    super('The passkey operation timed out. Please try again.')
    this.name = 'PasskeyTimeoutError'
  }
}

function throwMappedPasskeyError(error: unknown): never {
  const kind = classifyTinfoilPasskeyError(error)
  if (kind === 'unsupported') throw new PrfNotSupportedError()
  if (kind === 'timeout') throw new PasskeyTimeoutError()
  throw error
}

export async function createAndWrapTinfoilKey(input: {
  user: PasskeyUser
  key: Uint8Array
}): Promise<{ credentialId: string; wrappedKey: WrappedKey } | null> {
  try {
    return await passkeyKeyManager.createAndWrapKey(input)
  } catch (error) {
    if (classifyTinfoilPasskeyError(error) === 'cancelled') return null
    throwMappedPasskeyError(error)
  }
}

export async function evaluateTinfoilCredential(
  credentialIds: string[],
): Promise<EvaluatedCredential | null> {
  try {
    return await passkeyKeyManager.evaluateCredential({ credentialIds })
  } catch (error) {
    if (classifyTinfoilPasskeyError(error) === 'cancelled') return null
    throwMappedPasskeyError(error)
  }
}
