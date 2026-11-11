// Account, billing, and public map tokens use the control plane.
export const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL || 'https://api.tinfoil.sh'

// Injected from package.json at build time (see next.config.mjs).
export const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION || 'dev'

// The Vercel deployment this page was built in, injected at build time (see
// next.config.mjs). Empty for a build outside Vercel.
export const DEPLOYMENT_ID = process.env.NEXT_PUBLIC_DEPLOYMENT_ID || ''

export const PAGINATION = { CHATS_PER_PAGE: 20 } as const

// Origin of the unverified sandbox that runs model-authored HTML and JavaScript
// previews (github.com/tinfoilsh/tinfoil-webapp-sandbox).
export const SANDBOX_ORIGIN =
  process.env.NEXT_PUBLIC_SANDBOX_ORIGIN || 'https://webapp-sandbox.tinfoil.sh'
