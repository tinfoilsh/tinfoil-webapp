// Local dev mode is gated on both the build flag and a local/private runtime
// origin. A dev-flagged bundle served publicly therefore keeps attestation and
// direct controlplane routing enabled.
function isLocalRuntimeOrigin(): boolean {
  if (typeof window === 'undefined') return false
  const { hostname } = window.location
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname.startsWith('192.168.') ||
    hostname.startsWith('10.')
  )
}

export const IS_DEV =
  process.env.NEXT_PUBLIC_DEV === 'true' && isLocalRuntimeOrigin()

// Local dev sends controlplane requests through the same-origin API gateway.
// Hosted builds reject NEXT_PUBLIC_DEV in next.config.mjs, and the runtime
// origin check above keeps non-hosted public bundles on the direct API.
const CONFIGURED_API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL || 'https://api.tinfoil.sh'
export const API_BASE_URL = IS_DEV ? '' : CONFIGURED_API_BASE_URL

// Injected from package.json at build time (see next.config.mjs).
export const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION || 'dev'
export const DEV_API_KEY = process.env.NEXT_PUBLIC_DEV_API_KEY || ''

// Sync enclave URL. The web client speaks only to this attested enclave
// for blob reads/writes; the enclave is the only encryptor.
export const SYNC_ENCLAVE_URL =
  process.env.NEXT_PUBLIC_SYNC_ENCLAVE_URL || 'https://sync.tinfoil.sh'

// GitHub repo used for sync-enclave code-measurement verification.
export const SYNC_ENCLAVE_REPO =
  process.env.NEXT_PUBLIC_SYNC_ENCLAVE_REPO || 'tinfoilsh/confidential-sync'

export const SYNC_ENCLAVE_TIMEOUTS = {
  READY_MS: 30000,
  REQUEST_MS: 30000,
} as const

// Pagination settings
export const PAGINATION = {
  CHATS_PER_PAGE: 20,
  // Metadata-only page size used when scanning cloud history to find the
  // first chat that is not cached locally. Larger than CHATS_PER_PAGE so
  // long, fully-cached histories cost few round trips to scan. A returned
  // cursor still points at a page start, so a later content fetch of
  // CHATS_PER_PAGE items from that cursor stays correct.
  CURSOR_SCAN_PAGE_SIZE: 100,
} as const

// Cloud sync settings
export const CLOUD_SYNC = {
  // Requires upgraded readers and a server-enforced writer version boundary.
  DOCUMENT_ATTACHMENT_WRITES_ENABLED: false,
  RETRY_DELAY: 100, // milliseconds
  // Chats per content pull request. The enclave accepts up to MAX_PULL_IDS
  // but that bound protects the server; the client must decrypt and parse
  // the whole response on the main thread before REQUEST_MS elapses, and
  // chats with attachments can be megabytes each, so keep batches small.
  PULL_BATCH_SIZE: 20,
  // Mirrors the sync enclave's envelope plaintext cap. Checked before
  // any bytes leave the device so an oversized chat fails fast instead
  // of uploading its attachments and then being rejected by the push.
  MAX_CHAT_PLAINTEXT_BYTES: 32 * 1024 * 1024,
  CHAT_SYNC_INTERVAL: 20000, // 20 seconds - frequency for syncing chats
  PROFILE_SYNC_INTERVAL: 60000, // 60 seconds (1 minute) - frequency for syncing profile
  PROFILE_SYNC_DEBOUNCE: 2000,
  KEY_VALIDATION_PROBE_LIMIT: 3,
} as const

export const PASSKEY = {
  CREDENTIAL_SAVE_MAX_ATTEMPTS: 3,
} as const
