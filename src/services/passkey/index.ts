export {
  PasskeyTimeoutError,
  PrfNotSupportedError,
  clearCachedPrfResult,
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
  decryptKeyBundle,
  deletePasskeyCredential,
  encryptKeyBundle,
  getPasskeyCredentialState,
  getPasskeyDeviceState,
  hasPasskeyCredentials,
  loadPasskeyCredentials,
  loadRecoveryCandidates,
  promoteRecoveredCekToEnclave,
  recoverPasskeyKeyBundle,
  savePasskeyCredentials,
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
export { isPrfSupported, resetPrfSupportCache } from './prf-support'
