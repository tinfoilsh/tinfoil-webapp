import { IS_DEV } from '@/config'

export const DEV_SIMULATOR_ENABLED =
  process.env.NODE_ENV === 'development' || IS_DEV
export const DEV_SAFEGUARD_FLAG_COMMAND = 'flag safeguard'
export const DEV_SIMULATOR_HELP_COMMAND = 'help'
export const DEV_SIMULATOR_ERROR_COMMAND = 'test error'
export const DEV_SIMULATOR_ERROR_MESSAGE =
  'Simulated connection failure for local testing. No network request was made. Dismiss this banner and send a different message to continue; resending this command triggers the error again.'
export const DEV_SIMULATOR_HELP_STREAM = {
  streamDelayMs: 10,
  chunkSize: 32,
} as const
export const DEV_SAFEGUARD_FLAG_ID_PREFIX = 'dev-safeguard:'
export const DEV_SAFEGUARD_FLAG_RESPONSE =
  'Local preview: this chat is now flagged. Look for the red flag in the sidebar and, when signed in, under Settings → Safeguards. Nothing was reported and your account is unaffected. Repeating this command counts the chat only once. Reload the page to reset the preview.'
