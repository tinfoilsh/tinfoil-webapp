import type { BaseModel } from '@/config/models'
import { AuthenticationError } from 'openai'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const createCompletion = vi.fn()
const createRecoverableTransport = vi.fn()
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
  createRecoverableTinfoilTransport: () => createRecoverableTransport(),
  createRecoverableTinfoilClient: (...args: unknown[]) =>
    createRecoverableClient(...args),
  getTinfoilClient: vi.fn(),
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
    createCompletion
      .mockRejectedValueOnce(new TypeError('network unavailable'))
      .mockResolvedValueOnce(successfulStream())
    const recovery = recoveryCallbacks()
    recovery.onAttemptAbandoned.mockRejectedValueOnce(
      new Error('cleanup unavailable'),
    )

    await expect(send(recovery).promise).resolves.toBeInstanceOf(Response)

    expect(createRecoverableTransport).toHaveBeenCalledOnce()
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

    await expect(send().promise).resolves.toBeInstanceOf(Response)

    expect(resetTinfoilClient).toHaveBeenCalledOnce()
    expect(createRecoverableTransport).toHaveBeenCalledOnce()
    expect(createRecoverableClient).toHaveBeenCalledTimes(2)
  })
})
