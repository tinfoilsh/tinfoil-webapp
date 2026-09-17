import type { Message } from '@/components/chat/types'
import { DEV_SAFEGUARD_FLAG_RESPONSE } from '@/constants/dev-simulator'
import type {
  ChatChunk,
  ChatChunkStream,
} from '@/services/inference/chat-stream'
import { sendChatStream } from '@/services/inference/inference-client'
import {
  getSafeguardsSnapshot,
  refreshSafeguards,
  resetSafeguards,
  simulateSafeguardFlag,
} from '@/services/safeguards'
import {
  DEV_SIMULATOR_MODEL,
  SIMULATOR_PATTERNS,
  getSimulatorPattern,
} from '@/utils/dev-simulator'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { createCompletion } = vi.hoisted(() => ({ createCompletion: vi.fn() }))

vi.mock('@/config', () => ({
  API_BASE_URL: 'https://api.test',
  IS_DEV: true,
  DEV_API_KEY: '',
}))
vi.mock('@/services/auth', () => ({
  authTokenManager: { getAuthHeaders: vi.fn() },
  AuthTokenUnavailableError: class extends Error {},
}))
vi.mock('@/services/inference/tinfoil-client', () => ({
  getTinfoilClient: vi.fn(async () => ({
    chat: { completions: { create: createCompletion } },
  })),
  acquireRecoverableTinfoilTransport: vi.fn(),
  createRecoverableTinfoilClient: vi.fn(),
  discardRateLimitSnapshot: vi.fn(),
  getRateLimitInfo: vi.fn(),
  refreshRateLimit: vi.fn(),
  resetTinfoilClient: vi.fn(),
}))
vi.mock('@/components/chat/constants', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/components/chat/constants')>()
  return {
    ...actual,
    CONSTANTS: {
      ...actual.CONSTANTS,
      MESSAGE_SEND_MAX_RETRIES: 3,
      MESSAGE_SEND_RETRY_DELAY_MS: 1,
    },
  }
})

function userMessage(content: string): Message {
  return { role: 'user', content, timestamp: new Date() }
}

function send(
  content: string,
  options: {
    conversationId?: string
    signal?: AbortSignal
    messages?: Message[]
  } = {},
) {
  return sendChatStream({
    model: DEV_SIMULATOR_MODEL,
    systemPrompt: '',
    updatedMessages: options.messages ?? [userMessage(content)],
    signal: options.signal ?? new AbortController().signal,
    conversationId: options.conversationId ?? 'current-chat',
    genUIEnabled: false,
  })
}

async function collect(stream: ChatChunkStream): Promise<ChatChunk[]> {
  const chunks: ChatChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

function contentOf(chunks: ChatChunk[]): string {
  return chunks
    .map((chunk) => chunk.choices?.[0]?.delta?.content ?? '')
    .join('')
}

describe('local Dev Simulator', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    resetSafeguards()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('Unexpected network request')),
    )
  })

  afterEach(() => {
    resetSafeguards()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('answers help using the original user text without any simulator server or API call', async () => {
    const result = collect(await send('help'))
    await vi.runAllTimersAsync()
    const chunks = await result

    expect(contentOf(chunks)).toBe(getSimulatorPattern('help').content)
    expect(
      chunks
        .map((chunk) => chunk.choices?.[0]?.delta?.reasoning_content ?? '')
        .join(''),
    ).toBe('')
    expect(contentOf(chunks)).toContain('Available Dev Simulator commands')
    expect(contentOf(chunks)).toContain('`flag safeguard`')
    for (const command of Object.keys(SIMULATOR_PATTERNS)) {
      expect(contentOf(chunks)).toContain(`\`${command}\``)
    }
    expect(chunks.at(-1)?.choices?.[0]?.finish_reason).toBe('stop')
    expect(fetch).not.toHaveBeenCalled()
    expect(createCompletion).not.toHaveBeenCalled()
  })

  it.each(['flag safeguard', '  FLAG SAFEGUARD  '])(
    'flags the actual conversation for %s and confirms it is only a preview',
    async (command) => {
      const chunks = await collect(await send(command))
      expect(contentOf(chunks)).toBe(DEV_SAFEGUARD_FLAG_RESPONSE)
      expect(getSafeguardsSnapshot()).toMatchObject({
        isPreview: true,
        flaggedChatIds: { 'current-chat': true },
        flaggedChats: [{ conversationId: 'current-chat' }],
        policy: { inWindow: 1 },
      })
      expect(fetch).not.toHaveBeenCalled()
      expect(createCompletion).not.toHaveBeenCalled()
    },
  )

  it('counts each chat once and retains simulated flags across settings refreshes', async () => {
    await refreshSafeguards()
    await collect(await send('flag safeguard'))
    const firstFlag = getSafeguardsSnapshot().flaggedChats[0]
    await collect(await send('flag safeguard'))
    await refreshSafeguards()
    expect(getSafeguardsSnapshot().flaggedChats).toEqual([firstFlag])
    expect(getSafeguardsSnapshot().policy?.inWindow).toBe(1)

    await collect(
      await send('flag safeguard', { conversationId: 'another-chat' }),
    )
    await refreshSafeguards()
    expect(getSafeguardsSnapshot().policy?.inWindow).toBe(2)
    expect(getSafeguardsSnapshot().flaggedChatIds).toEqual({
      'current-chat': true,
      'another-chat': true,
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('does not retrigger a command from earlier conversation history', async () => {
    const result = collect(
      await send('help', {
        messages: [userMessage('flag safeguard'), userMessage('help')],
      }),
    )
    await vi.runAllTimersAsync()
    expect(contentOf(await result)).toBe(getSimulatorPattern('help').content)
    expect(getSafeguardsSnapshot().flaggedChats).toEqual([])
  })

  it('requires the exact command rather than matching it in prose', async () => {
    const result = collect(await send('What does flag safeguard mean?'))
    await vi.runAllTimersAsync()
    await result
    expect(getSafeguardsSnapshot().flaggedChats).toEqual([])
  })

  it('does not flag a chat when the command is canceled before consumption', async () => {
    const controller = new AbortController()
    const stream = await send('flag safeguard', { signal: controller.signal })
    controller.abort()
    await expect(collect(stream)).rejects.toMatchObject({ name: 'AbortError' })
    expect(getSafeguardsSnapshot().flaggedChats).toEqual([])
  })

  it('cancels an in-progress simulator delay immediately', async () => {
    const controller = new AbortController()
    const iterator = (await send('help', { signal: controller.signal }))[
      Symbol.asyncIterator
    ]()
    const pending = iterator.next()
    const rejected = expect(pending).rejects.toMatchObject({
      name: 'AbortError',
    })
    controller.abort()
    await rejected
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects a missing chat ID instead of reporting a successful preview', async () => {
    await expect(
      send('flag safeguard', { conversationId: '' }),
    ).rejects.toMatchObject({ code: 'FETCH_ERROR' })
    expect(simulateSafeguardFlag('  ')).toBe(false)
    expect(getSafeguardsSnapshot().flaggedChats).toEqual([])
  })

  it('clears simulated chat IDs when the safeguards state is reset', async () => {
    await collect(await send('flag safeguard'))
    resetSafeguards()
    expect(getSafeguardsSnapshot().isPreview).toBe(false)
    expect(getSafeguardsSnapshot().flaggedChatIds).toEqual({})
    await refreshSafeguards()
    expect(
      getSafeguardsSnapshot().flaggedChatIds['current-chat'],
    ).toBeUndefined()
  })

  it('preserves the simulated retry pattern without making network calls', async () => {
    const onRetry = vi.fn()
    const result = sendChatStream({
      model: DEV_SIMULATOR_MODEL,
      systemPrompt: '',
      updatedMessages: [userMessage('test retry')],
      signal: new AbortController().signal,
      onRetry,
      genUIEnabled: false,
    }).then(collect)
    await vi.runAllTimersAsync()
    expect(contentOf(await result)).toBe(
      getSimulatorPattern('test retry').content,
    )
    expect(onRetry).toHaveBeenCalledTimes(3)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('leaves the same words on a normal model on the normal SDK path', async () => {
    createCompletion.mockResolvedValue({
      async *[Symbol.asyncIterator]() {
        yield { choices: [{ delta: { content: 'Normal answer' } }] }
      },
    })
    const stream = await sendChatStream({
      model: { ...DEV_SIMULATOR_MODEL, modelName: 'gpt-oss-120b' },
      systemPrompt: '',
      updatedMessages: [userMessage('flag safeguard')],
      signal: new AbortController().signal,
      conversationId: 'current-chat',
      genUIEnabled: false,
    })
    expect(contentOf(await collect(stream))).toBe('Normal answer')
    expect(createCompletion).toHaveBeenCalledOnce()
    expect(createCompletion.mock.calls[0][1].headers).toMatchObject({
      'X-Tinfoil-Conversation-Id': 'current-chat',
    })
    expect(getSafeguardsSnapshot().flaggedChats).toEqual([])
  })
})
