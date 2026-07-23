import {
  LOCAL_PASSKEY_CREDENTIAL_ID,
  SECRET_PASSKEY_PRF_OUTPUT,
} from '@/constants/storage-keys'
import { logError, logInfo } from '@/utils/error-handling'
import { createPasskeyKit } from '@tinfoilsh/passkey-kit'

const RP_ID =
  typeof window !== 'undefined' && window.location.hostname === 'localhost'
    ? 'localhost'
    : 'tinfoil.sh'

const RP_NAME = 'Tinfoil Chat'

/**
 * App-wide passkey SDK instance. PRF salt and HKDF info are left at the
 * SDK's Tinfoil v1 protocol defaults so bundles stay interoperable with
 * every other Tinfoil client.
 */
export const passkeyKit = createPasskeyKit({
  rpId: RP_ID,
  rpName: RP_NAME,
  storageKeys: {
    prfResult: SECRET_PASSKEY_PRF_OUTPUT,
    localCredentialId: LOCAL_PASSKEY_CREDENTIAL_ID,
  },
  errorMessages: {
    prfNotSupported:
      "Your passkey provider doesn't support the security features required by Tinfoil. " +
      "Try using iCloud Keychain, Chrome's built-in passkey manager, or the Passwords app in your device settings.",
  },
  logger: {
    info: (message, metadata) =>
      logInfo(message, { component: 'PasskeyKit', metadata }),
    error: (message, error, metadata) =>
      logError(message, error, { component: 'PasskeyKit', metadata }),
  },
})
