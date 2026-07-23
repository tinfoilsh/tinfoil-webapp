import { decryptResponseWithToken, type SessionRecoveryToken } from 'tinfoil'
import { getRecoveryBaseURL } from './tinfoil-client'

const RECOVERY_SESSION_ID_PATTERN = /^[0-9a-f]{32}$/
const RECOVERY_REQUEST_TIMEOUT_MS = 30_000

export type RecoveryState = 'processing' | 'complete' | 'failed' | 'missing'
export type RecoveryStatus = {
  state: RecoveryState
  bytes: number
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
  if (response.status === 404) return { state: 'missing', bytes: 0 }
  if (response.status === 410) return { state: 'failed', bytes: 0 }
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
  const bytes =
    typeof body === 'object' && body !== null && 'bytes' in body
      ? body.bytes
      : undefined
  if (status !== 'processing' && status !== 'complete' && status !== 'failed') {
    throw new ChatRecoveryError('Invalid encrypted recovery status response')
  }
  if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 0) {
    throw new ChatRecoveryError('Invalid encrypted recovery byte count')
  }
  return { state: status, bytes }
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
  replayBytes = 0,
  onReplayComplete?: () => void,
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
  if (!response.body || replayBytes <= 0 || !onReplayComplete) {
    onReplayComplete?.()
    return decryptResponseWithToken(response, token)
  }

  let replayBytesRemaining = replayBytes
  let replayComplete = false
  let liveRemainder: Uint8Array | undefined
  const reader = response.body.getReader()
  const markReplayComplete = () => {
    if (replayComplete) return
    replayComplete = true
    onReplayComplete()
  }
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (liveRemainder) {
        markReplayComplete()
        controller.enqueue(liveRemainder)
        liveRemainder = undefined
        return
      }

      const { done, value } = await reader.read()
      if (done) {
        if (replayBytesRemaining === 0) {
          markReplayComplete()
        }
        controller.close()
        return
      }
      if (replayBytesRemaining === 0) {
        markReplayComplete()
        controller.enqueue(value)
        return
      }
      if (value.byteLength <= replayBytesRemaining) {
        replayBytesRemaining -= value.byteLength
        controller.enqueue(value)
        return
      }

      liveRemainder = value.slice(replayBytesRemaining)
      controller.enqueue(value.slice(0, replayBytesRemaining))
      replayBytesRemaining = 0
    },
    cancel(reason) {
      return reader.cancel(reason)
    },
  })
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
