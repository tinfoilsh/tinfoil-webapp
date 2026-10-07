import { authTokenManager } from '@/services/auth'
import {
  getTinfoilClient,
  getVerificationDocument,
  resetTinfoilClient,
} from '@/services/inference/tinfoil-client'
import {
  APIConnectionError,
  APIUserAbortError,
  AuthenticationError,
} from 'openai'
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
} from 'openai/resources/chat/completions'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  config: {
    API_BASE_URL: 'https://controlplane.example',
    DEV_API_KEY: 'development-token',
    IS_DEV: false,
  },
  enclaveURL: 'https://enclave.example/v1',
  createTransport: vi.fn<() => typeof fetch>(),
  ready: vi.fn<() => Promise<void>>(),
  verification: { securityVerified: true },
  readVerification: vi.fn(),
}))

vi.mock('@/config', () => mocks.config)
vi.mock('tinfoil', async (original) => ({
  ...(await original<typeof import('tinfoil')>()),
  SecureClient: class {
    fetch = mocks.createTransport()
    ready = mocks.ready
    getBaseURL = () => mocks.enclaveURL
    getVerificationDocument = mocks.readVerification
  },
}))

const MODEL = 'gpt-oss-120b'
const CLERK_TOKEN = 'clerk-token'
const OLD_SESSION_TOKEN = 'old-session-token'
const FRESH_SESSION_TOKEN = 'fresh-session-token'
const EVENTS_HEADER = 'X-Tinfoil-Events'
const EVENTS_VALUE = 'web_search,code_execution'
const CONVERSATION_HEADER = 'X-Tinfoil-Conversation-Id'
const CONVERSATION_ID = 'conversation-1'
const FORM_DATA_PROBE = 'data:,'
const NO_SDK_RETRIES = { maxRetries: 0 }
const request: ChatCompletionCreateParamsNonStreaming = {
  model: MODEL,
  messages: [{ role: 'user', content: 'Hello' }],
}

function completion(content: string): ChatCompletion {
  return {
    id: 'completion-1',
    object: 'chat.completion',
    created: 1,
    model: MODEL,
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        logprobs: null,
        message: { role: 'assistant', content, refusal: null },
      },
    ],
  }
}

function authFailure() {
  return Response.json(
    { error: { message: 'Expired session', type: 'auth_error' } },
    { status: 401 },
  )
}

describe('tinfoil-client retry proxy', () => {
  let staleTransport: ReturnType<typeof vi.fn<typeof fetch>>
  let freshTransport: ReturnType<typeof vi.fn<typeof fetch>>
  let tokenFetch: ReturnType<typeof vi.fn<typeof fetch>>

  beforeEach(() => {
    resetTinfoilClient()
    authTokenManager.reset()
    authTokenManager.initialize(async () => CLERK_TOKEN)
    mocks.config.IS_DEV = false
    mocks.createTransport.mockReset()
    mocks.ready.mockReset().mockResolvedValue(undefined)
    mocks.readVerification.mockReset().mockReturnValue(mocks.verification)
    const unexpectedRequest: typeof fetch = async (input) => {
      throw new Error(`Unexpected enclave request: ${String(input)}`)
    }
    staleTransport = vi.fn(unexpectedRequest)
    freshTransport = vi.fn(unexpectedRequest)
    mocks.createTransport
      .mockImplementation(() => {
        throw new Error('Unexpected extra SecureClient')
      })
      .mockReturnValueOnce(staleTransport)
      .mockReturnValueOnce(freshTransport)
    const tokens = [OLD_SESSION_TOKEN, FRESH_SESSION_TOKEN]
    tokenFetch = vi.fn(async (input, options) => {
      expect(input).toBe(`${mocks.config.API_BASE_URL}/api/chat/token`)
      expect(new Headers(options?.headers).get('Authorization')).toBe(
        `Bearer ${CLERK_TOKEN}`,
      )
      const key = tokens.shift()
      if (!key) throw new Error('Unexpected extra session-token mint')
      return Response.json({ key })
    })
    vi.stubGlobal('fetch', tokenFetch)
  })

  afterEach(() => {
    resetTinfoilClient()
    authTokenManager.reset()
    vi.unstubAllGlobals()
  })

  function expectChatRequest(
    transport: typeof staleTransport,
    token: string,
    expected = request,
  ) {
    expect(transport).toHaveBeenCalledOnce()
    const [url, options] = transport.mock.calls[0]
    expect(url).toBe(`${mocks.enclaveURL}/chat/completions`)
    expect(options?.method).toBe('POST')
    expect(JSON.parse(String(options?.body))).toEqual(expected)
    const headers = new Headers(options?.headers)
    expect(headers.get('Authorization')).toBe(`Bearer ${token}`)
    expect(headers.get(EVENTS_HEADER)).toBe(EVENTS_VALUE)
  }

  it('should forward client.chat.completions.create() calls', async () => {
    staleTransport.mockResolvedValueOnce(Response.json(completion('hi')))
    const client = await getTinfoilClient()
    expect(
      await client.chat.completions.create(request, NO_SDK_RETRIES),
    ).toEqual(completion('hi'))
    expectChatRequest(staleTransport, OLD_SESSION_TOKEN)
    expect(mocks.ready).toHaveBeenCalledOnce()
    expect(tokenFetch).toHaveBeenCalledOnce()
  })

  it('should forward client.audio.transcriptions.create() calls', async () => {
    staleTransport.mockImplementation(async (input) =>
      input === FORM_DATA_PROBE
        ? new Response('')
        : Response.json({ text: 'hello world' }),
    )
    const client = await getTinfoilClient()
    const file = new File(['audio bytes'], 'audio.mp3', { type: 'audio/mpeg' })
    expect(
      await client.audio.transcriptions.create(
        { file, model: MODEL },
        NO_SDK_RETRIES,
      ),
    ).toEqual({ text: 'hello world' })
    const sent = staleTransport.mock.calls.filter(
      ([url]) => url !== FORM_DATA_PROBE,
    )
    expect(sent).toHaveLength(1)
    const [url, options] = sent[0]
    expect(url).toBe(`${mocks.enclaveURL}/audio/transcriptions`)
    expect(options?.method).toBe('POST')
    expect(new Headers(options?.headers).get('Authorization')).toBe(
      `Bearer ${OLD_SESSION_TOKEN}`,
    )
    const form = options?.body
    if (!(form instanceof FormData)) throw new Error('Expected multipart form')
    expect(form.get('model')).toBe(MODEL)
    const uploaded = form.get('file')
    if (!(uploaded instanceof File)) throw new Error('Expected uploaded file')
    expect(uploaded.name).toBe('audio.mp3')
    expect(uploaded.type).toBe('audio/mpeg')
    expect(await uploaded.text()).toBe('audio bytes')
  })

  it.each([false, true])(
    'returns the verification document through the live export (dev=%s)',
    async (dev) => {
      mocks.config.IS_DEV = dev
      expect(await getVerificationDocument()).toBe(
        dev ? null : mocks.verification,
      )
      expect(mocks.ready).toHaveBeenCalledTimes(dev ? 0 : 1)
      expect(mocks.readVerification).toHaveBeenCalledTimes(dev ? 0 : 1)
      expect(staleTransport).not.toHaveBeenCalled()
    },
  )

  it('should retry on AuthenticationError and succeed with fresh client', async () => {
    staleTransport.mockResolvedValueOnce(authFailure())
    freshTransport.mockResolvedValueOnce(Response.json(completion('retried')))
    const client = await getTinfoilClient()
    expect(
      await client.chat.completions.create(request, NO_SDK_RETRIES),
    ).toEqual(completion('retried'))
    expectChatRequest(staleTransport, OLD_SESSION_TOKEN)
    expectChatRequest(freshTransport, FRESH_SESSION_TOKEN)
    expect(tokenFetch).toHaveBeenCalledTimes(2)
    expect(mocks.ready).toHaveBeenCalledTimes(2)
  })

  it.each([403, 503, 'network'] as const)(
    'propagates non-auth failure %s without refreshing or replaying',
    async (status) => {
      const networkError = new TypeError(
        'Expired api key text is not an auth classification',
      )
      if (status === 'network')
        staleTransport.mockRejectedValueOnce(networkError)
      else
        staleTransport.mockResolvedValueOnce(
          Response.json(
            { error: { message: 'Expired api key', code: 'not_auth' } },
            { status },
          ),
        )
      const client = await getTinfoilClient()
      const result = client.chat.completions.create(request, NO_SDK_RETRIES)
      if (status === 'network') {
        await expect(result).rejects.toBeInstanceOf(APIConnectionError)
        await expect(result).rejects.toMatchObject({ cause: networkError })
      } else await expect(result).rejects.toMatchObject({ status })
      expect(staleTransport).toHaveBeenCalledOnce()
      expect(freshTransport).not.toHaveBeenCalled()
      expect(tokenFetch).toHaveBeenCalledOnce()
      expect(mocks.createTransport).toHaveBeenCalledOnce()
    },
  )

  it('should use fresh client for all calls after a retry (no stale-client bug)', async () => {
    staleTransport.mockResolvedValueOnce(authFailure())
    freshTransport.mockImplementation(async () =>
      Response.json(completion('ok')),
    )
    const client = await getTinfoilClient()
    const create = client.chat.completions.create

    // First call triggers retry
    await create(request, NO_SDK_RETRIES)

    // Second call should go directly to fresh client, not the stale one
    freshTransport.mockClear()
    staleTransport.mockClear()
    const secondRequest: ChatCompletionCreateParamsNonStreaming = {
      model: MODEL,
      messages: [{ role: 'user', content: 'Second request' }],
    }
    expect(await create(secondRequest, NO_SDK_RETRIES)).toEqual(
      completion('ok'),
    )
    expect(staleTransport).not.toHaveBeenCalled()
    expectChatRequest(freshTransport, FRESH_SESSION_TOKEN, secondRequest)
    expect(tokenFetch).toHaveBeenCalledTimes(2)
  })

  it('should only retry once — a second AuthenticationError is thrown', async () => {
    staleTransport.mockResolvedValueOnce(authFailure())
    freshTransport.mockResolvedValueOnce(authFailure())
    const client = await getTinfoilClient()
    await expect(
      client.chat.completions.create(request, NO_SDK_RETRIES),
    ).rejects.toBeInstanceOf(AuthenticationError)
    expectChatRequest(staleTransport, OLD_SESSION_TOKEN)
    expectChatRequest(freshTransport, FRESH_SESSION_TOKEN)
    expect(tokenFetch).toHaveBeenCalledTimes(2)
    expect(mocks.createTransport).toHaveBeenCalledTimes(2)
  })

  it('should not be thenable (await returns the proxy itself)', async () => {
    const client = await getTinfoilClient()
    expect(await client).toBe(client)
    expect(staleTransport).not.toHaveBeenCalled()
    expect(tokenFetch).toHaveBeenCalledOnce()
  })

  it.each(['before', 'during'])(
    'forwards request options and aborts %s transport without auth replay',
    async (when) => {
      const controller = new AbortController()
      staleTransport.mockImplementation(
        (_url, options) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = options?.signal
            if (!signal) throw new Error('Missing caller cancellation signal')
            signal.addEventListener(
              'abort',
              () => reject(new DOMException('Aborted', 'AbortError')),
              { once: true },
            )
          }),
      )
      const client = await getTinfoilClient()
      if (when === 'before') controller.abort()
      const result = client.chat.completions.create(request, {
        ...NO_SDK_RETRIES,
        signal: controller.signal,
        headers: { [CONVERSATION_HEADER]: CONVERSATION_ID },
      })
      const rejected = expect(result).rejects.toBeInstanceOf(APIUserAbortError)
      if (when === 'during') {
        await vi.waitFor(() => expect(staleTransport).toHaveBeenCalledOnce())
        expectChatRequest(staleTransport, OLD_SESSION_TOKEN)
        const options = staleTransport.mock.calls[0][1]
        expect(new Headers(options?.headers).get(CONVERSATION_HEADER)).toBe(
          CONVERSATION_ID,
        )
        expect(options?.signal?.aborted).toBe(false)
        controller.abort()
        expect(options?.signal?.aborted).toBe(true)
      }
      await rejected
      expect(staleTransport).toHaveBeenCalledTimes(when === 'before' ? 0 : 1)
      expect(freshTransport).not.toHaveBeenCalled()
      expect(tokenFetch).toHaveBeenCalledOnce()
    },
  )

  it('does not send inference when attestation rejects', async () => {
    const failure = new Error('Attestation rejected')
    mocks.ready.mockRejectedValueOnce(failure)
    await expect(getTinfoilClient()).rejects.toBe(failure)
    expect(staleTransport).not.toHaveBeenCalled()
    expect(freshTransport).not.toHaveBeenCalled()
    expect(mocks.readVerification).not.toHaveBeenCalled()
  })
})
