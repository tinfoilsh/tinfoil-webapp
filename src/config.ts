// For Next.js, public environment variables are replaced at build time
// We'll provide fallback values for development if not set
export const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL || ''
const OAUTH_API_BASE_URL = API_BASE_URL || 'https://api.tinfoil.sh'

export const OAUTH = {
  CLIENT_ID: process.env.NEXT_PUBLIC_TINFOIL_OAUTH_CLIENT_ID || '',
  AUTHORIZE_URL:
    process.env.NEXT_PUBLIC_TINFOIL_OAUTH_AUTHORIZE_URL ||
    'https://dash.tinfoil.sh/oauth/authorize',
  TOKEN_URL:
    process.env.NEXT_PUBLIC_TINFOIL_OAUTH_TOKEN_URL ||
    `${OAUTH_API_BASE_URL}/oauth/token`,
  REVOKE_URL:
    process.env.NEXT_PUBLIC_TINFOIL_OAUTH_REVOKE_URL ||
    `${OAUTH_API_BASE_URL}/oauth/revoke`,
  REDIRECT_URI: process.env.NEXT_PUBLIC_TINFOIL_OAUTH_REDIRECT_URI || '',
  SCOPE:
    process.env.NEXT_PUBLIC_TINFOIL_OAUTH_SCOPE ||
    'inference:chat offline_access',
  CALLBACK_PATH: '/oauth/callback',
  ACCESS_TOKEN_EXPIRY_BUFFER_MS: 60_000,
  CODE_VERIFIER_BYTES: 32,
  STATE_BYTES: 16,
} as const

// Local dev mode: bypass TinfoilAI client and connect to local router
export const IS_DEV = process.env.NEXT_PUBLIC_DEV === 'true'
export const DEV_API_KEY = process.env.NEXT_PUBLIC_DEV_API_KEY || ''

// Pagination settings
export const PAGINATION = {
  CHATS_PER_PAGE: 20,
} as const

// Cloud sync settings
export const CLOUD_SYNC = {
  RETRY_DELAY: 100, // milliseconds
  CHAT_SYNC_INTERVAL: 60000, // 60 seconds (1 minute) - frequency for syncing chats
  PROFILE_SYNC_INTERVAL: 300000, // 5 minutes - frequency for syncing profile (less frequent)
  KEY_VALIDATION_PROBE_LIMIT: 3,
} as const

export const PASSKEY = {
  CREDENTIAL_SAVE_MAX_ATTEMPTS: 3,
} as const
