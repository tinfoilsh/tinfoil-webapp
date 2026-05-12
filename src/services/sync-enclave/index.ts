export {
  SyncEnclaveClient,
  SyncEnclaveError,
  getSyncEnclaveClient,
  resetSyncEnclaveClient,
} from './sync-enclave-client'

export {
  buildCanonical,
  computeOperationHash,
  deriveOpHashKey,
  operationHashForCek,
} from './operation-hash'
export type { OperationCanonicalInput } from './operation-hash'

export {
  cekBytesToHex,
  cekHexToBytes,
  deriveKeyIdHex,
  unwrapCekFromBundle,
  wrapCekForCredential,
  wrapPrimaryCekForCredential,
} from './key-bundle'
export type { RemoteBundle } from './key-bundle'

export * as passkeyKeyFlow from './passkey-key-flow'
export type {
  PasskeyFlowError,
  PasskeyFlowFailure,
  PasskeyFlowResult,
  PasskeyFlowSuccess,
  PasskeyUserInfo,
} from './passkey-key-flow'

export * as syncApi from './sync-api'
export type {
  BundleBody,
  CurrentKeyResponse,
  ListStatusResponse,
  NeedsMigrationResponse,
  RegisterKeyRequest,
  RegisterKeyResponse,
  Scope,
  TombstonesResponse,
  WriteOptions,
  WriteResponse,
} from './sync-api'
