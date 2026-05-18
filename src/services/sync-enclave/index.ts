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

export { COVERED_CODES, decideRecovery } from './enclave-error-recovery'
export type { RecoveryAction, RecoveryDecision } from './enclave-error-recovery'

export {
  computeBackoffDelay,
  realScheduler,
  runWithRetry,
} from './retry-policy'
export type { RetryConfig, RetryScheduler } from './retry-policy'

export * as syncApi from './sync-api'
export type {
  AddBundleRequest,
  DeleteRequest,
  KeyCurrentBundle,
  KeyCurrentResponse,
  KeyRegisterBundleInput,
  KeyRegisterRequest,
  KeyRegisterResponse,
  ListStatusDelete,
  ListStatusRequest,
  ListStatusResponse,
  ListStatusUpdate,
  MigrateAllRequest,
  MigrateAllResponse,
  MigrateAllScopeReport,
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
