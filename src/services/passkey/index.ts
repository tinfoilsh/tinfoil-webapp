export {
  getLocalPasskeyCredentialId,
  setLocalPasskeyCredentialId,
} from './local-passkey-credential'
export {
  PasskeyCredentialConflictError,
  decryptKeyBundle,
  deletePasskeyCredential,
  encryptKeyBundle,
  getPasskeyCredentialState,
  getPasskeyDeviceState,
  hasPasskeyCredentials,
  loadPasskeyCredentials,
  loadRecoveryCandidates,
  retrieveEncryptedKeys,
  savePasskeyCredentials,
  storeEncryptedKeys,
} from './passkey-key-storage'
export type {
  KeyBundle,
  PasskeyCredentialEntry,
  PasskeyCredentialState,
  PasskeyDeviceState,
  StoreEncryptedKeysOptions,
} from './passkey-key-storage'
export {
  PasskeyTimeoutError,
  PrfNotSupportedError,
  authenticatePrfPasskey,
  clearCachedPrfResult,
  createPrfPasskey,
  deriveKeyEncryptionKey,
  getCachedPrfResult,
} from './passkey-service'
export type { PrfPasskeyResult } from './passkey-service'
export { isPrfSupported, resetPrfSupportCache } from './prf-support'
