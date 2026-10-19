export {
  SyncEnclaveClient,
  SyncEnclaveError,
  SyncNetworkError,
  SyncPersistentAuthError,
  getSyncEnclaveClient,
  resetSyncEnclaveClient,
} from './sync-enclave-client'

export { deriveTinfoilKeyIdHex } from './tinfoil-key-id'

export { classifyEnclaveError } from './enclave-error-classification'
export type {
  EnclaveErrorClassification,
  EnclaveErrorCode,
  EnclaveErrorKind,
} from './enclave-error-classification'

export { decideRecovery } from './enclave-error-recovery'
export type { RecoveryAction, RecoveryDecision } from './enclave-error-recovery'

export { computeBackoffDelay, realScheduler } from './retry-policy'
export type { RetryScheduler } from './retry-policy'

export * as syncApi from './sync-api'
export type {
  AddBundleRequest,
  BackupInventoryItem,
  BackupInventoryProtocolErrorCode,
  BackupInventoryResponse,
  BackupInventoryScope,
  DeleteRequest,
  ForkRequest,
  ForkResponse,
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
  OKResponse,
  PullItem,
  PullKey,
  PullRequest,
  PullResponse,
  PushRequest,
  PushResponse,
  Scope,
} from './sync-api'
