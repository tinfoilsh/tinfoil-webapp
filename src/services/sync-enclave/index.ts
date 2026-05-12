export {
  SyncEnclaveClient,
  SyncEnclaveError,
  getSyncEnclaveClient,
  resetSyncEnclaveClient,
} from './sync-enclave-client'

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
