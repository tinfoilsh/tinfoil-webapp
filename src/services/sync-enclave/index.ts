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
export type { BundleBody, RemoteBundle } from './key-bundle'

export * as passkeyKeyFlow from './passkey-key-flow'
export type {
  PasskeyFlowError,
  PasskeyFlowFailure,
  PasskeyFlowResult,
  PasskeyFlowSuccess,
  PasskeyUserInfo,
} from './passkey-key-flow'

export { classifyEnclaveError } from './enclave-error-classification'
export type {
  EnclaveErrorClassification,
  EnclaveErrorCode,
  EnclaveErrorKind,
} from './enclave-error-classification'

export * as syncApi from './sync-api'
export type {
  AddBundleRequest,
  ConflictPolicy,
  DeleteRequest,
  KeyRegisterBundleInput,
  KeyRegisterRequest,
  KeyRegisterResponse,
  ListStatusDelete,
  ListStatusRequest,
  ListStatusResponse,
  ListStatusUpdate,
  MigrateRequest,
  MigrateResponse,
  OKResponse,
  PullItem,
  PullKey,
  PullRequest,
  PullResponse,
  PushRequest,
  PushResponse,
  Scope,
} from './sync-api'
