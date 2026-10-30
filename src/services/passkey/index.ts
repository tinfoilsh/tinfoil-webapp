export {
  PasskeyTimeoutError,
  PrfNotSupportedError,
  createAndWrapTinfoilKey,
  passkeyKeyManager,
} from './kit'
export {
  getLocalPasskeyCredentialId,
  setLocalPasskeyCredentialId,
} from './local-passkey-credential'
export {
  PasskeyCredentialConflictError,
  addWrappedKeyForCurrentKey,
  deletePasskeyCredential,
  getPasskeyCredentialState,
  getPasskeyDeviceState,
  loadPasskeyCredentials,
  recoverPasskeyKeyBundle,
  storeEncryptedKeys,
  tinfoilWrappedKeyBundleToEnclave,
  wrapTinfoilKeyBundle,
} from './passkey-key-storage'
export type {
  KeyBundle,
  PasskeyCredentialEntry,
  PasskeyCredentialState,
  PasskeyDeviceState,
  StoreEncryptedKeysOptions,
  TinfoilWrappedKeyBundle,
} from './passkey-key-storage'
export { isPrfSupported } from './prf-support'
