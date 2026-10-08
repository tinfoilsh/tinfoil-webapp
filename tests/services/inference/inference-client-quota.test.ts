import type { BaseModel } from '@/config/models'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const createCompletion = vi.fn()
const discardRateLimitSnapshot = vi.fn()
const getRateLimitInfo = vi.fn()
const refreshRateLimit = vi.fn(async () => undefined)

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
  acquireRecoverableTinfoilTransport: vi.fn(),
  createRecoverableTinfoilClient: vi.fn(),
  discardRateLimitSnapshot: () => discardRateLimitSnapshot(),
  getRateLimitInfo: () => getRateLimitInfo(),
  getTinfoilClient: vi.fn(async () => ({
    chat: {
      completions: {
        create: (...args: unknown[]) => createCompletion(...args),
      },
    },
  })),
  refreshRateLimit: () => refreshRateLimit(),
  resetTinfoilClient: vi.fn(),
}))

import { ChatError } from '@/components/chat/chat-utils'
import {
  AuthTokenRefreshError,
  AuthTokenUnavailableError,
} from '@/services/auth'
import { sendChatStream } from '@/services/inference/inference-client'
import { getTinfoilClient } from '@/services/inference/tinfoil-client'

const model: BaseModel = {
  modelName: 'gpt-oss-120b',
  image: '',
  name: 'Test',
  nameShort: 'Test',
  description: 'Test model',
  type: 'chat',
}

const EXHAUSTED_DAILY_QUOTA = {
  maxRequests: 10,
  remaining: 0,
  resetsAt: '',
  kind: 'free_daily',
} as const

async function collectChunks<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const chunks: T[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

function status429Error() {
  return Object.assign(new Error('Rate limit reached'), { status: 429 })
}

function successfulStream() {
  return {
    async *[Symbol.asyncIterator]() {
      yield { choices: [{ delta: { content: 'answer' } }] }
    },
  }
}

function send(onRetry?: (attempt: number, maxRetries: number) => void) {
  return sendChatStream({
    model,
    systemPrompt: '',
    updatedMessages: [
      { role: 'user', content: 'question', timestamp: new Date() },
    ],
    signal: new AbortController().signal,
    genUIEnabled: false,
    onRetry,
  })
}

describe('sendChatStream 429 quota classification', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('fails immediately with RATE_LIMIT when the daily quota is exhausted', async () => {
    createCompletion.mockRejectedValue(status429Error())
    getRateLimitInfo.mockReturnValue({ ...EXHAUSTED_DAILY_QUOTA })
    const onRetry = vi.fn()

    const error = await send(onRetry).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ChatError)
    expect((error as ChatError).code).toBe('RATE_LIMIT')
    // The rejected request never consumed quota server-side, so the
    // optimistic snapshot must be dropped before trusting the refresh.
    expect(discardRateLimitSnapshot).toHaveBeenCalled()
    expect(refreshRateLimit).toHaveBeenCalled()
    expect(onRetry).not.toHaveBeenCalled()
    expect(createCompletion).toHaveBeenCalledTimes(1)
  })

  it('fails immediately with HOURLY_LIMIT when the hourly cap is exhausted', async () => {
    createCompletion.mockRejectedValue(status429Error())
    getRateLimitInfo.mockReturnValue({
      maxRequests: 0,
      remaining: 0,
      resetsAt: '',
      kind: 'hourly',
    })

    const error = await send().catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ChatError)
    expect((error as ChatError).code).toBe('HOURLY_LIMIT')
    expect(createCompletion).toHaveBeenCalledTimes(1)
  })

  it('retries a 429 when the refreshed quota still has requests remaining', async () => {
    createCompletion
      .mockRejectedValueOnce(status429Error())
      .mockResolvedValueOnce(successfulStream())
    getRateLimitInfo.mockReturnValue({ ...EXHAUSTED_DAILY_QUOTA })
    let finishRefresh!: () => void
    const refreshed = new Promise<void>((resolve) => {
      finishRefresh = resolve
    })
    refreshRateLimit.mockImplementationOnce(async () => {
      await refreshed
      getRateLimitInfo.mockReturnValue({
        ...EXHAUSTED_DAILY_QUOTA,
        remaining: 5,
      })
    })
    const onRetry = vi.fn()

    const pending = send(onRetry)
    await vi.waitFor(() => expect(refreshRateLimit).toHaveBeenCalledOnce())
    expect(createCompletion).toHaveBeenCalledTimes(1)
    expect(onRetry).not.toHaveBeenCalled()
    finishRefresh()
    const stream = await pending

    expect(await collectChunks(stream)).toEqual([
      { choices: [{ delta: { content: 'answer' } }] },
    ])
    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(createCompletion).toHaveBeenCalledTimes(2)
  })

  it('retries a 429 when no quota is tracked (paid tier)', async () => {
    createCompletion
      .mockRejectedValueOnce(status429Error())
      .mockResolvedValueOnce(successfulStream())
    getRateLimitInfo.mockReturnValue(null)

    const stream = await send()

    expect(await collectChunks(stream)).toEqual([
      { choices: [{ delta: { content: 'answer' } }] },
    ])
    expect(createCompletion).toHaveBeenCalledTimes(2)
  })
})

describe('sendChatStream authentication classification', () => {
  it.each([
    new AuthTokenUnavailableError('not-initialized'),
    new AuthTokenUnavailableError('unavailable'),
    new AuthTokenRefreshError(),
  ])(
    'does not label $name as a connection failure or retry it',
    async (error) => {
      vi.clearAllMocks()
      vi.mocked(getTinfoilClient).mockRejectedValueOnce(error)
      const onRetry = vi.fn()

      await expect(send(onRetry)).rejects.toMatchObject({
        code: 'AUTH_ERROR',
        message: error.message,
      })
      expect(onRetry).not.toHaveBeenCalled()
      expect(createCompletion).not.toHaveBeenCalled()
      expect(getTinfoilClient).toHaveBeenCalledTimes(1)
    },
  )
})
