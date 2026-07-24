import { decryptResponseWithToken, type SessionRecoveryToken } from 'tinfoil'
import { getRecoveryBaseURL } from './tinfoil-client'

const RECOVERY_SESSION_ID_PATTERN = /^[0-9a-f]{32}$/
const RECOVERY_REQUEST_TIMEOUT_MS = 30_000
const EHBP_RESPONSE_NONCE_HEADER = 'Ehbp-Response-Nonce'

export type RecoveryState = 'processing' | 'complete' | 'failed' | 'missing'
export type RecoveryStatus = {
  state: RecoveryState
  persistedBytes: number
}

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

export async function getChatRecoveryStatus(
  sessionId: string,
): Promise<RecoveryStatus> {
  const response = await recoveryFetch(sessionId, '/status')
  if (response.status === 404) return { state: 'missing', persistedBytes: 0 }
  if (response.status === 410) return { state: 'failed', persistedBytes: 0 }
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
  const persistedBytes =
    typeof body === 'object' && body !== null && 'bytes' in body
      ? body.bytes
      : undefined
  if (status !== 'processing' && status !== 'complete' && status !== 'failed') {
    throw new ChatRecoveryError('Invalid encrypted recovery status response')
  }
  if (
    typeof persistedBytes !== 'number' ||
    !Number.isSafeInteger(persistedBytes) ||
    persistedBytes < 0
  ) {
    throw new ChatRecoveryError('Invalid encrypted recovery byte count')
  }
  return { state: status, persistedBytes }
}

export async function getChatRecoveryState(
  sessionId: string,
): Promise<RecoveryState> {
  return (await getChatRecoveryStatus(sessionId)).state
}

export async function fetchRecoveredChatResponse(
  sessionId: string,
  token: SessionRecoveryToken,
  signal?: AbortSignal,
  onEncryptedBytes?: (bytes: number) => void,
): Promise<Response> {
  const response = await recoveryFetch(sessionId, '', { signal })
  const encryptedResponse = response.headers.has(EHBP_RESPONSE_NONCE_HEADER)
  if (!encryptedResponse && response.status === 404) {
    throw new ChatRecoveryError('Recovery session not found', 'missing')
  }
  if (!encryptedResponse && response.status === 410) {
    throw new ChatRecoveryError('Recovery session failed', 'failed')
  }
  if (!encryptedResponse && !response.ok) {
    throw new ChatRecoveryError(
      'Encrypted response recovery failed',
      undefined,
      response.status >= 500,
    )
  }
  if (!response.body || !onEncryptedBytes) {
    return decryptResponseWithToken(response, token)
  }

  onEncryptedBytes(0)
  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        onEncryptedBytes(chunk.byteLength)
        controller.enqueue(chunk)
      },
    }),
  )
  return decryptResponseWithToken(
    new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    }),
    token,
  )
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
