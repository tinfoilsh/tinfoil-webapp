// Account, billing, and public map tokens use the control plane.
export const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL || ''
export const PAGINATION = { CHATS_PER_PAGE: 20 } as const
export const PASSKEY = { CREDENTIAL_SAVE_MAX_ATTEMPTS: 3 } as const
