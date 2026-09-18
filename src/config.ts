// For Next.js, public environment variables are replaced at build time
// We'll provide fallback values for development if not set
export const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL || ''

// Injected from package.json at build time (see next.config.mjs).
export const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION || 'dev'

// Local dev mode: bypass TinfoilAI client and connect to local router.
// Gated on BOTH the build flag and a localhost runtime origin. Dev mode only
// ever targets a local proxy, so a production bundle accidentally built with
// NEXT_PUBLIC_DEV=true still fails closed (attestation stays on) when served
// from a public origin.
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
  RETRY_DELAY: 100, // milliseconds
  CHAT_SYNC_INTERVAL: 20000, // 20 seconds - frequency for syncing chats
  PROFILE_SYNC_INTERVAL: 60000, // 60 seconds (1 minute) - frequency for syncing profile
  PROFILE_SYNC_DEBOUNCE: 2000,
  KEY_VALIDATION_PROBE_LIMIT: 3,
} as const

export const PASSKEY = {
  CREDENTIAL_SAVE_MAX_ATTEMPTS: 3,
} as const
