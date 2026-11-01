// Account, billing, and public map tokens use the control plane.
export const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL || 'https://api.tinfoil.sh'

// Injected from package.json at build time (see next.config.mjs).
export const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION || 'dev'

export const PAGINATION = { CHATS_PER_PAGE: 20 } as const
export const PASSKEY = { CREDENTIAL_SAVE_MAX_ATTEMPTS: 3 } as const

// Origin of the unverified sandbox that runs model-authored HTML and JavaScript
// previews (github.com/tinfoilsh/tinfoil-webapp-sandbox).
export const SANDBOX_ORIGIN =
  process.env.NEXT_PUBLIC_SANDBOX_ORIGIN || 'https://webapp-sandbox.tinfoil.sh'
