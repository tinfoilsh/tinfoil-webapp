import type { BaseModel } from '@/config/models'
import { AuthenticationError } from 'openai'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const createCompletion = vi.fn()
const createRecoverableTransport = vi.fn()
const releaseRecoverableTransport = vi.fn()
const createRecoverableClient = vi.fn()
const resetTinfoilClient = vi.fn()

vi.mock('@/components/chat/constants', async () => {
  const actual = await vi.importActual<
    typeof import('@/components/chat/constants')
  >('@/components/chat/constants')
  return {
    ...actual,
    CONSTANTS: {
      ...actual.CONSTANTS,
      MESSAGE_SEND_MAX_RETRIES: 2,
      MESSAGE_SEND_RETRY_DELAY_MS: 0,
    },
  }
})

vi.mock('@/services/inference/tinfoil-client', () => ({
  acquireRecoverableTinfoilTransport: async () => ({
    transport: await createRecoverableTransport(),
    release: releaseRecoverableTransport,
  }),
  createRecoverableTinfoilClient: (...args: unknown[]) =>
    createRecoverableClient(...args),
  discardRateLimitSnapshot: vi.fn(),
  getRateLimitInfo: vi.fn(() => null),
  getTinfoilClient: vi.fn(),
  refreshRateLimit: vi.fn(async () => undefined),
  resetTinfoilClient: () => resetTinfoilClient(),
}))

import { sendChatStream } from '@/services/inference/inference-client'

const model: BaseModel = {
  modelName: 'gpt-oss-120b',
  image: '',
  name: 'Test',
  nameShort: 'Test',
  description: 'Test model',
  type: 'chat',
}

function successfulStream() {
  return {
    async *[Symbol.asyncIterator]() {
      yield { choices: [{ delta: { content: 'answer' } }] }
    },
  }
}

function recoveryCallbacks() {
  return {
    onAttemptStarted: vi.fn(),
    onTokenCaptured: vi.fn(async () => undefined),
    onAttemptAbandoned: vi.fn(async () => undefined),
  }
}

function send(recovery = recoveryCallbacks()) {
  return {
    promise: sendChatStream({
      model,
      systemPrompt: '',
      updatedMessages: [
        {
          role: 'user',
          content: 'question',
          timestamp: new Date(),
        },
      ],
      signal: new AbortController().signal,
      genUIEnabled: false,
      recovery,
    }),
    recovery,
  }
}

describe('recoverable inference retries', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    createRecoverableTransport.mockResolvedValue({ transport: true })
    createRecoverableClient.mockResolvedValue({
      waitForTokenCapture: () => Promise.resolve(),
      client: {
        chat: {
          completions: {
            create: (...args: unknown[]) => createCompletion(...args),
          },
        },
      },
    })
  })

  it('reuses attestation and preserves retries when cleanup fails', async () => {
    const sdkStream = successfulStream()
    createCompletion
      .mockRejectedValueOnce(new TypeError('network unavailable'))
      .mockResolvedValueOnce(sdkStream)
    const recovery = recoveryCallbacks()
    recovery.onAttemptAbandoned.mockRejectedValueOnce(
      new Error('cleanup unavailable'),
    )

    const stream = await send(recovery).promise
    expect(typeof stream[Symbol.asyncIterator]).toBe('function')
    await expect(stream.recoveryReady).resolves.toBeUndefined()
    const chunks = []
    for await (const chunk of stream) {
      chunks.push(chunk)
    }
    expect(chunks).toHaveLength(1)

    expect(createRecoverableTransport).toHaveBeenCalledOnce()
    expect(releaseRecoverableTransport).toHaveBeenCalledOnce()
    expect(createRecoverableClient).toHaveBeenCalledTimes(2)
    expect(createCompletion).toHaveBeenCalledTimes(2)
  })

  it('refreshes authentication for a recoverable request', async () => {
    createCompletion
      .mockRejectedValueOnce(
        new AuthenticationError(
          401,
          { error: { message: 'expired' }, type: 'auth_error' },
          'expired',
          new Headers(),
        ),
      )
      .mockResolvedValueOnce(successfulStream())

    const stream = await send().promise
    expect(typeof stream[Symbol.asyncIterator]).toBe('function')
    const chunks = []
    for await (const chunk of stream) {
      chunks.push(chunk)
    }
    expect(chunks).toHaveLength(1)

    expect(resetTinfoilClient).toHaveBeenCalledOnce()
    expect(createRecoverableTransport).toHaveBeenCalledOnce()
    expect(releaseRecoverableTransport).toHaveBeenCalledOnce()
    expect(createRecoverableClient).toHaveBeenCalledTimes(2)
  })

  it('returns the stream before the pending recovery cloud upload completes', async () => {
    let finishCloudUpload!: () => void
    const pendingCloudUpload = new Promise<void>((resolve) => {
      finishCloudUpload = resolve
    })
    createRecoverableClient.mockResolvedValueOnce({
      waitForTokenCapture: () => pendingCloudUpload,
      client: {
        chat: {
          completions: {
            create: (...args: unknown[]) => createCompletion(...args),
          },
        },
      },
    })
    createCompletion.mockResolvedValueOnce(successfulStream())

    const stream = await send().promise
    let recoveryReady = false
    void stream.recoveryReady?.then(() => {
      recoveryReady = true
    })

    expect(recoveryReady).toBe(false)
    const chunks = []
    for await (const chunk of stream) {
      chunks.push(chunk)
    }
    expect(chunks).toEqual([{ choices: [{ delta: { content: 'answer' } }] }])
    expect(recoveryReady).toBe(false)

    finishCloudUpload()
    await stream.recoveryReady
    expect(recoveryReady).toBe(true)
  })

  it('abandons recovery when token persistence fails', async () => {
    const captureError = new Error('persistence unavailable')
    createRecoverableClient.mockResolvedValueOnce({
      waitForTokenCapture: () => Promise.reject(captureError),
      client: {
        chat: {
          completions: {
            create: (...args: unknown[]) => createCompletion(...args),
          },
        },
      },
    })
    createCompletion.mockResolvedValueOnce(successfulStream())
    const { promise, recovery } = send()

    const stream = await promise

    await expect(stream.recoveryReady).rejects.toBe(captureError)
    expect(recovery.onAttemptAbandoned).toHaveBeenCalledOnce()
  })

  it('releases the transport after an aborted request', async () => {
    createCompletion.mockRejectedValueOnce(
      new DOMException('Aborted', 'AbortError'),
    )

    await expect(send().promise).rejects.toMatchObject({ name: 'AbortError' })

    expect(releaseRecoverableTransport).toHaveBeenCalledOnce()
  })

  it('releases the transport after a terminal request error', async () => {
    createCompletion.mockRejectedValueOnce(
      Object.assign(new Error('invalid request'), { status: 400 }),
    )

    await expect(send().promise).rejects.toMatchObject({
      code: 'SERVER_ERROR',
    })

    expect(releaseRecoverableTransport).toHaveBeenCalledOnce()
  })
})
