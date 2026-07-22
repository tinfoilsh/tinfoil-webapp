import { decryptResponseWithToken, type SessionRecoveryToken } from 'tinfoil'
import { getRecoveryBaseURL } from './tinfoil-client'

const RECOVERY_SESSION_ID_PATTERN = /^[0-9a-f]{32}$/
const RECOVERY_REQUEST_TIMEOUT_MS = 30_000

export type RecoveryState = 'processing' | 'complete' | 'failed' | 'missing'

export class ChatRecoveryError extends Error {
  constructor(
    message: string,
    public readonly state?: RecoveryState,
    public readonly retryable = false,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'ChatRecoveryError'
  }
}

function assertSessionId(sessionId: string): void {
  if (!RECOVERY_SESSION_ID_PATTERN.test(sessionId)) {
    throw new ChatRecoveryError('Invalid recovery session identifier')
  }
}

async function recoveryURL(sessionId: string, suffix = ''): Promise<string> {
  assertSessionId(sessionId)
  const baseURL = getRecoveryBaseURL()
  const base = new URL(baseURL)
  return new URL(`/recovery/${sessionId}${suffix}`, base.origin).toString()
}

async function recoveryFetch(
  sessionId: string,
  suffix = '',
  init: RequestInit = {},
): Promise<Response> {
  const signal = init.signal ?? AbortSignal.timeout(RECOVERY_REQUEST_TIMEOUT_MS)
  try {
    return await fetch(await recoveryURL(sessionId, suffix), {
      ...init,
      signal,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    })
  } catch (error) {
    throw new ChatRecoveryError(
      'Encrypted response recovery request failed',
      undefined,
      true,
      { cause: error },
    )
  }
}

export async function getChatRecoveryState(
  sessionId: string,
): Promise<RecoveryState> {
  const response = await recoveryFetch(sessionId, '/status')
  if (response.status === 404) return 'missing'
  if (response.status === 410) return 'failed'
  if (!response.ok) {
    throw new ChatRecoveryError(
      'Encrypted response recovery status failed',
      undefined,
      response.status >= 500,
    )
  }
  const body: unknown = await response.json()
  const status =
    typeof body === 'object' && body !== null && 'status' in body
      ? body.status
      : undefined
  if (status !== 'processing' && status !== 'complete' && status !== 'failed') {
    throw new ChatRecoveryError('Invalid encrypted recovery status response')
  }
  return status
}

export async function fetchRecoveredChatResponse(
  sessionId: string,
  token: SessionRecoveryToken,
  signal?: AbortSignal,
): Promise<Response> {
  const response = await recoveryFetch(sessionId, '', { signal })
  if (response.status === 404) {
    throw new ChatRecoveryError('Recovery session not found', 'missing')
  }
  if (response.status === 409) {
    throw new ChatRecoveryError(
      'Recovery session is still processing',
      'processing',
    )
  }
  if (response.status === 410) {
    throw new ChatRecoveryError('Recovery session failed', 'failed')
  }
  if (!response.ok) {
    throw new ChatRecoveryError(
      'Encrypted response recovery failed',
      undefined,
      response.status >= 500,
    )
  }
  return decryptResponseWithToken(response, token)
}

export async function deleteChatRecovery(sessionId: string): Promise<void> {
  const response = await recoveryFetch(sessionId, '', { method: 'DELETE' })
  if (!response.ok && response.status !== 404) {
    throw new ChatRecoveryError(
      'Failed to delete encrypted response recovery session',
      undefined,
      response.status >= 500,
    )
  }
}
