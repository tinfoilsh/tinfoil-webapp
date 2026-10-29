// The chat service's routes and the error codes the browser acts on.
import type { paths } from './openapi'
import type {
  ClientErrorCode,
  ErrorAction,
  ErrorCode,
  HarnessErrorBody,
} from './types'

export const ROUTES = {
  session: '/v1/session',
  changes: '/v1/changes',
  profileGet: '/v1/profile/get',
  profileUpdate: '/v1/profile/update',
  profileUpgrade: '/v1/profile/upgrade',
  profileMerge: '/v1/profile/merge',
  keysCurrent: '/v1/keys/current',
  keysRegister: '/v1/keys/register',
  keysAddBundle: '/v1/keys/add-bundle',
  keysRemoveBundle: '/v1/keys/remove-bundle',
  keysMigrateAll: '/v1/keys/migrate-all',
  turn: '/v1/threads/turn',
  follow: '/v1/threads/follow',
  cancel: '/v1/threads/cancel',
  queueSend: '/v1/threads/queue/send',
  queueRemove: '/v1/threads/queue/remove',
  list: '/v1/threads/list',
  search: '/v1/threads/search',
  get: '/v1/threads/get',
  update: '/v1/threads/update',
  delete: '/v1/threads/delete',
  deleteAll: '/v1/threads/delete-all',
  fork: '/v1/threads/fork',
  messageDelete: '/v1/threads/messages/delete',
  messageUpdate: '/v1/threads/messages/update',
  share: '/v1/threads/share',
  shareStatus: '/v1/threads/share/status',
  shareRevoke: '/v1/threads/share/revoke',
  shareOpen: '/v1/shares/open',
  transcript: '/v1/threads/transcript',
  threadImport: '/v1/threads/import',
  upgrade: '/v1/threads/upgrade',
  attachmentUpload: '/v1/attachments/upload',
  attachmentGet: '/v1/attachments/get',
  attachmentGetPublic: '/v1/attachments/get-public',
  projectsList: '/v1/projects/list',
  projectsGet: '/v1/projects/get',
  projectsCreate: '/v1/projects/create',
  projectsUpdate: '/v1/projects/update',
  projectsDelete: '/v1/projects/delete',
  projectsDeleteAll: '/v1/projects/delete-all',
  projectDocumentUpload: '/v1/projects/documents/upload',
  projectDocumentDelete: '/v1/projects/documents/delete',
  favicon: '/v1/metadata/favicon',
  linkMetadata: '/v1/metadata/link',
  speech: '/v1/speech',
  transcriptions: '/v1/transcriptions',
  export: '/v1/export',
  import: '/v1/import',
  importStatus: '/v1/import/status',
} as const satisfies Record<string, keyof paths>

export type HarnessRoute = (typeof ROUTES)[keyof typeof ROUTES]

// Every widget the harness declares is named with this prefix.
export const WIDGET_PREFIX = 'render_'

// A run's stream: a turn starts one, and following one replays it.
export type RunRoute = typeof ROUTES.turn | typeof ROUTES.follow

export const ERROR_CODES = {
  // The harness had applied a turn sent again.
  alreadyApplied: 'ALREADY_APPLIED',
  // The run is not live on the instance that answered.
  runNotFound: 'RUN_NOT_FOUND',
  runInFlight: 'RUN_IN_FLIGHT',
  quotaExhausted: 'QUOTA_EXHAUSTED',
  rateLimited: 'RATE_LIMITED',
  contextTooLarge: 'CONTEXT_TOO_LARGE',
  modelUnavailable: 'MODEL_UNAVAILABLE',
  // A stream that closed before its run ended. The run may go on.
  streamInterrupted: 'STREAM_INTERRUPTED',
  invalidStream: 'INVALID_STREAM',
  // Set by this client, not the harness: a refusal or a run's error without
  // the members the protocol requires of it.
  invalidResponse: 'INVALID_RESPONSE',
  upstreamRefused: 'UPSTREAM_REFUSED',
  keyRequired: 'KEY_REQUIRED',
  keyMismatch: 'KEY_MISMATCH',
  unauthenticated: 'UNAUTHENTICATED',
  badRequest: 'BAD_REQUEST',
  configuration: 'CONFIGURATION',
  connection: 'CONNECTION',
  threadNotFound: 'THREAD_NOT_FOUND',
  threadExists: 'THREAD_EXISTS',
  // The chat changed while a run that edits it in place ran.
  revisionConflict: 'REVISION_CONFLICT',
  // A tool, such as a widget, is not offered to the client.
  toolUnavailable: 'TOOL_UNAVAILABLE',
  threadTooLarge: 'THREAD_TOO_LARGE',
  attachmentsUnavailable: 'ATTACHMENTS_UNAVAILABLE',
  attachmentTooLarge: 'ATTACHMENT_TOO_LARGE',
  attachmentUnsupported: 'ATTACHMENT_UNSUPPORTED',
  // The safeguards flagged the chat, which takes no more turns.
  chatFlagged: 'CHAT_FLAGGED',
  // The chat already holds the most turns it queues behind a running reply.
  // It is not the caller's quota.
  queueFull: 'QUEUE_FULL',
  // An archive holds more than the harness can process.
  archiveTooLarge: 'ARCHIVE_TOO_LARGE',
  // Other archives hold the harness's temporary space for now.
  tempSpaceBusy: 'TEMP_SPACE_BUSY',
  projectsRequireCloud: 'PROJECTS_REQUIRE_CLOUD',
  // The search index could not be rebuilt for a search.
  searchIndexFailed: 'SEARCH_INDEX_FAILED',
  importInvalid: 'IMPORT_INVALID',
  importTooLarge: 'IMPORT_TOO_LARGE',
  payloadTooLarge: 'PAYLOAD_TOO_LARGE',
  // The request needs the chat access the browser mints, which it lacked or
  // which expired.
  credentialRequired: 'CREDENTIAL_REQUIRED',
  // Set by this client, not the harness: a reply this device could not store.
  localSaveFailed: 'LOCAL_SAVE_FAILED',
  // Set by this client, not the harness: a change that needs the account's
  // settings before they have loaded.
  profileLoading: 'PROFILE_LOADING',
} as const satisfies Record<string, ErrorCode | ClientErrorCode>

// What this client does about an error it has no handling of its own for.
export const ERROR_ACTIONS = {
  reauthenticate: 'reauthenticate',
  reload: 'reload',
  retry: 'retry',
  wait: 'wait',
  unlock: 'unlock',
  revise: 'revise',
  stop: 'stop',
} as const satisfies Record<string, ErrorAction>

// The action an error asks for. One this client does not know, as a later
// harness may ask for, fails the request: the client shows the error and
// offers nothing more.
export const actionOf = (action: string): ErrorAction =>
  Object.values<string>(ERROR_ACTIONS).includes(action)
    ? (action as ErrorAction)
    : ERROR_ACTIONS.stop

// Why a request failed when the harness's answer to it is not one the
// protocol allows.
export const invalidResponse = (): HarnessErrorBody => ({
  code: ERROR_CODES.invalidResponse,
  action: ERROR_ACTIONS.stop,
  message: 'The chat service sent a response this client cannot read.',
})

// Set on every answer the enclave seals, which is every answer the harness
// gives; one without it came from whatever stands in front of the enclave.
export const RESPONSE_NONCE_HEADER = 'Ehbp-Response-Nonce'

// Why a request failed when its answer did not come from the harness: a
// refusal the enclave did not seal says nothing this client may show or act
// on, and whether the request took effect is unknown, as when the connection
// drops.
export const unsealedRefusal = (): HarnessErrorBody => ({
  code: ERROR_CODES.connection,
  action: ERROR_ACTIONS.retry,
  message:
    'The chat service could not be reached. Check your connection and try again.',
})

// Carries a signed-in account's chat access, which the harness checks before
// it reads a request's body.
export const INFERENCE_KEY_HEADER = 'X-Tinfoil-Inference-Key'

// Names the harness instance holding a run, so a request about the run can
// be routed to it.
export const HARNESS_INSTANCE_HEADER = 'X-Tinfoil-Harness-Instance'

// Names the last event of a run a client applied, which following the run
// resumes after.
export const LAST_EVENT_ID_HEADER = 'Last-Event-ID'
