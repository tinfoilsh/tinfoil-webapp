export const HARNESS_URL =
  import.meta.env.WXT_HARNESS_URL || 'https://chat-api.tinfoil.sh'
export const CONTROLPLANE_URL =
  import.meta.env.WXT_CONTROLPLANE_URL || 'https://api.tinfoil.sh'
export const CLERK_PUBLISHABLE_KEY =
  import.meta.env.WXT_CLERK_PUBLISHABLE_KEY || ''
export const CLERK_FRONTEND_API = import.meta.env.WXT_CLERK_FRONTEND_API || ''
export const WEB_SIGN_IN_URL = new URL(
  '/signin',
  import.meta.env.WXT_WEBAPP_URL || 'https://chat.tinfoil.sh',
).href
export const PANEL_PORT = 'tinfoil-panel'
export const TOKEN_TIMEOUT_MS = 30_000
export const PANEL_HEARTBEAT_MS = 20_000
export const TASK_TIMEOUT_MS = 20 * 60_000
export const DEFAULT_MODEL = 'kimi-k3-1-pro'
export const RECONNECT_DELAYS_MS = [0, 1_000, 2_000, 4_000, 8_000, 15_000]
export const MAX_PROMPT_CHARS = 30_000

export function randomSecret(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
}
