import type { Message } from '@/components/chat/types'
import {
  DEV_SAFEGUARD_FLAG_RESPONSE,
  DEV_SAFEGUARD_RESET_RESPONSE,
  DEV_SAFEGUARD_SIGN_IN_REQUIRED,
  DEV_SIMULATOR_ERROR_COMMAND,
  DEV_SIMULATOR_ERROR_MESSAGE,
} from '@/constants/dev-simulator'
import type {
  ChatChunk,
  ChatChunkStream,
} from '@/services/inference/chat-stream'
import { sendChatStream } from '@/services/inference/inference-client'
import { getSafeguardsSnapshot, resetSafeguards } from '@/services/safeguards'
import {
  DEV_SIMULATOR_MODEL,
  SIMULATOR_PATTERNS,
  getSimulatorPattern,
} from '@/utils/dev-simulator'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { createCompletion } = vi.hoisted(() => ({ createCompletion: vi.fn() }))

vi.mock('@/config', () => ({
  API_BASE_URL: '',
  IS_DEV: true,
  DEV_API_KEY: '',
}))

const { getAuthHeaders } = vi.hoisted(() => ({
  getAuthHeaders: vi.fn(),
}))

vi.mock('@/services/auth', () => {
  class AuthTokenUnavailableError extends Error {
    constructor(msg = 'unavailable') {
      super(msg)
      this.name = 'AuthTokenUnavailableError'
    }
  }
  return {
    authTokenManager: { getAuthHeaders },
    AuthTokenUnavailableError,
  }
})

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

interface MockFlag {
  id: string
  conversation_id: string
  created_at: string
}

/**
 * Minimal in-memory analogue of the local mock backend. Bound as a `fetch`
 * stub so the inference client exercises its real HTTP path end-to-end.
 */
function installMockBackend(): {
  flags: MockFlag[]
  fetchMock: ReturnType<typeof vi.fn>
} {
  const flags: MockFlag[] = []
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      const method = init?.method ?? 'GET'
      if (url === '/api/dev/safeguard-flags' && method === 'POST') {
        const body = init?.body ? JSON.parse(String(init.body)) : {}
        const id = body?.conversation_id
        if (typeof id !== 'string' || !id.trim()) {
          return new Response(JSON.stringify({ error: 'bad' }), { status: 400 })
        }
        const existing = flags.find((f) => f.conversation_id === id.trim())
        if (existing) {
          return new Response(
            JSON.stringify({ created: false, duplicate: true }),
            { status: 200 },
          )
        }
        flags.unshift({
          id: `dev-safeguard:${id.trim()}`,
          conversation_id: id.trim(),
          created_at: new Date().toISOString(),
        })
        return new Response(
          JSON.stringify({ created: true, duplicate: false }),
          { status: 200 },
        )
      }
      if (url === '/api/dev/safeguard-flags' && method === 'DELETE') {
        const cleared = flags.length
        flags.length = 0
        return new Response(JSON.stringify({ cleared }), { status: 200 })
      }
      if (url === '/api/users/me/safeguard-flags') {
        return new Response(
          JSON.stringify({
            flags,
            in_window: flags.length,
            window_hours: 168,
            warn_threshold: 8,
            ban_threshold: 10,
          }),
          { status: 200 },
        )
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`)
    },
  )
  vi.stubGlobal('fetch', fetchMock)
  return { flags, fetchMock }
}

let backendFlags: MockFlag[]
let fetchMock: ReturnType<typeof vi.fn>

describe('local Dev Simulator', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    resetSafeguards()
    getAuthHeaders.mockResolvedValue({
      Authorization: 'Bearer local-test-token',
      'Content-Type': 'application/json',
    })
    const backend = installMockBackend()
    backendFlags = backend.flags
    fetchMock = backend.fetchMock
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
    expect(contentOf(chunks)).toContain('Available Dev Simulator commands')
    expect(contentOf(chunks)).toContain('`flag safeguard`')
    expect(contentOf(chunks)).toContain('`reset safeguards`')
    expect(contentOf(chunks)).toContain(`\`${DEV_SIMULATOR_ERROR_COMMAND}\``)
    for (const command of Object.keys(SIMULATOR_PATTERNS)) {
      expect(contentOf(chunks)).toContain(`\`${command}\``)
    }
    expect(chunks.at(-1)?.choices?.[0]?.finish_reason).toBe('stop')
    expect(createCompletion).not.toHaveBeenCalled()
  })

  it.each([DEV_SIMULATOR_ERROR_COMMAND, '  TEST ERROR  '])(
    'surfaces a repeatable connection error immediately for %s without network calls',
    async (command) => {
      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(send(command)).rejects.toMatchObject({
          name: 'ChatError',
          code: 'FETCH_ERROR',
          message: DEV_SIMULATOR_ERROR_MESSAGE,
        })
        expect(vi.getTimerCount()).toBe(0)
      }
      expect(createCompletion).not.toHaveBeenCalled()
    },
  )

  it('honors cancellation instead of showing the simulated error', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      send(DEV_SIMULATOR_ERROR_COMMAND, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  it.each(['flag safeguard', '  FLAG SAFEGUARD  '])(
    'POSTs the active conversation id and refreshes the store via the normal HTTP path for %s',
    async (command) => {
      const chunks = await collect(await send(command))
      expect(contentOf(chunks)).toBe(DEV_SAFEGUARD_FLAG_RESPONSE)

      const posts = fetchMock.mock.calls.filter(
        (call) => (call[1] as RequestInit)?.method === 'POST',
      )
      expect(posts).toHaveLength(1)
      expect(posts[0][0]).toBe('/api/dev/safeguard-flags')
      expect(JSON.parse(String((posts[0][1] as RequestInit).body))).toEqual({
        conversation_id: 'current-chat',
      })
      const headers = (posts[0][1] as RequestInit).headers as Record<
        string,
        string
      >
      expect(headers.Authorization).toBe('Bearer local-test-token')

      const gets = fetchMock.mock.calls.filter(
        (call) => ((call[1] as RequestInit)?.method ?? 'GET') === 'GET',
      )
      expect(gets.some((c) => c[0] === '/api/users/me/safeguard-flags')).toBe(
        true,
      )
      expect(backendFlags.map((f) => f.conversation_id)).toEqual([
        'current-chat',
      ])
      expect(getSafeguardsSnapshot().flaggedChatIds).toEqual({
        'current-chat': true,
      })
      expect(getSafeguardsSnapshot()).not.toHaveProperty('isPreview')
    },
  )

  it('counts each chat once through the mock backend', async () => {
    await collect(await send('flag safeguard'))
    await collect(await send('flag safeguard'))
    expect(backendFlags.map((f) => f.conversation_id)).toEqual(['current-chat'])
    await collect(
      await send('flag safeguard', { conversationId: 'another-chat' }),
    )
    expect(backendFlags.map((f) => f.conversation_id).sort()).toEqual([
      'another-chat',
      'current-chat',
    ])
    expect(getSafeguardsSnapshot().flaggedChatIds).toEqual({
      'current-chat': true,
      'another-chat': true,
    })
    expect(fetchMock).toHaveBeenCalled()
  })

  it('clears flags on `reset safeguards` through the DELETE endpoint', async () => {
    await collect(await send('flag safeguard'))
    expect(backendFlags).toHaveLength(1)
    const chunks = await collect(await send('reset safeguards'))
    expect(contentOf(chunks)).toBe(DEV_SAFEGUARD_RESET_RESPONSE)
    expect(backendFlags).toHaveLength(0)
    expect(getSafeguardsSnapshot().flaggedChatIds).toEqual({})
    const deletes = fetchMock.mock.calls.filter(
      (call) => (call[1] as RequestInit)?.method === 'DELETE',
    )
    expect(deletes).toHaveLength(1)
    expect(deletes[0][0]).toBe('/api/dev/safeguard-flags')
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

  it('aborts an in-flight safeguard mutation request', async () => {
    const controller = new AbortController()
    let notifyStarted!: () => void
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve
    })
    fetchMock.mockImplementationOnce(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          notifyStarted()
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'))
          })
        }),
    )

    const stream = await send('flag safeguard', { signal: controller.signal })
    const pending = collect(stream)
    await started
    controller.abort()

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchMock.mock.calls[0][1]?.signal).toBe(controller.signal)
  })

  it('rejects a missing chat ID with a clear FETCH_ERROR', async () => {
    await expect(
      send('flag safeguard', { conversationId: '' }),
    ).rejects.toMatchObject({ code: 'FETCH_ERROR' })
    expect(getSafeguardsSnapshot().flaggedChats).toEqual([])
  })

  it('explains that sign-in is required when no Clerk token is available', async () => {
    const { AuthTokenUnavailableError } = await import('@/services/auth')
    getAuthHeaders.mockRejectedValue(
      new AuthTokenUnavailableError('signed out'),
    )
    await expect(collect(await send('flag safeguard'))).rejects.toMatchObject({
      code: 'FETCH_ERROR',
      message: DEV_SAFEGUARD_SIGN_IN_REQUIRED,
    })
    await expect(collect(await send('reset safeguards'))).rejects.toMatchObject(
      {
        code: 'FETCH_ERROR',
        message: DEV_SAFEGUARD_SIGN_IN_REQUIRED,
      },
    )
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
  })

  it.each(['flag safeguard', 'reset safeguards', DEV_SIMULATOR_ERROR_COMMAND])(
    'leaves %s on a normal model on the normal SDK path',
    async (command) => {
      createCompletion.mockResolvedValue({
        async *[Symbol.asyncIterator]() {
          yield { choices: [{ delta: { content: 'Normal answer' } }] }
        },
      })
      const stream = await sendChatStream({
        model: { ...DEV_SIMULATOR_MODEL, modelName: 'gpt-oss-120b' },
        systemPrompt: '',
        updatedMessages: [userMessage(command)],
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
    },
  )
})
