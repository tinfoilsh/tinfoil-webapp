import { IS_DEV } from '@/config'

export const DEV_SIMULATOR_ENABLED =
  process.env.NODE_ENV === 'development' || IS_DEV
export const DEV_SAFEGUARD_FLAG_COMMAND = 'flag safeguard'
export const DEV_SAFEGUARD_RESET_COMMAND = 'reset safeguards'
export const DEV_SIMULATOR_HELP_COMMAND = 'help'
export const DEV_SIMULATOR_ERROR_COMMAND = 'test error'
export const DEV_SIMULATOR_ERROR_MESSAGE =
  'Simulated connection failure for local testing. No network request was made. Dismiss this banner and send a different message to continue; resending this command triggers the error again.'
export const DEV_SIMULATOR_HELP_STREAM = {
  streamDelayMs: 10,
  chunkSize: 32,
} as const
export const DEV_SAFEGUARD_FLAG_RESPONSE =
  'Flagged this chat through the local mock controlplane. The sidebar and Settings → Safeguards now reflect the mocked flag; nothing was sent to the real controlplane. Repeating this command counts the chat only once. Send `reset safeguards` or restart `dev:backend` to clear.'
export const DEV_SAFEGUARD_RESET_RESPONSE =
  'Cleared all mocked safeguard flags on the local backend and refreshed the store.'
export const DEV_SAFEGUARD_SIGN_IN_REQUIRED =
  'Local safeguard testing requires signing in so the mock backend receives a bearer token, matching production behavior.'
