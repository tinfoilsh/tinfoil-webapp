import { HarnessClient } from '@/services/harness/client'
import { activateAPI, HarnessAPI } from '@/services/harness/runtime'
import { HarnessError } from '@/services/harness/sse'
import { SPEECH } from '@/services/speech/constants'
import { speechErrorMessage } from '@/services/speech/errors'
import { decodePcmStream, speechSource } from '@/services/speech/stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SEALED, stubChatAccess } from '../../harness-fixture'

vi.mock('tinfoil', () => ({ SecureClient: vi.fn() }))

async function collect(stream: AsyncIterable<Float32Array>): Promise<number[]> {
  const samples: number[] = []
  for await (const part of stream) samples.push(...part)
  return samples
}

function bytes(...parts: number[][]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      parts.forEach((part) => controller.enqueue(Uint8Array.from(part)))
      controller.close()
    },
  })
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('PCM streaming', () => {
  it('decodes signed little-endian samples across odd network boundaries', async () => {
    expect(
      await collect(
        decodePcmStream(
          bytes([0], [128, 0, 0, 255], [127, 0], [192]),
          new AbortController().signal,
        ),
      ),
    ).toEqual([-1, 0, 32767 / 32768, -0.5])
  })

  it('emits playable blocks before the response ends and flushes the tail', async () => {
    let source!: ReadableStreamDefaultController<Uint8Array>
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        source = controller
      },
    })
    const iterator = decodePcmStream(body, new AbortController().signal)
    source.enqueue(new Uint8Array(SPEECH.BLOCK_SAMPLES * 2 + 2))
    expect((await iterator.next()).value).toHaveLength(SPEECH.BLOCK_SAMPLES)
    source.close()
    expect((await iterator.next()).value).toHaveLength(1)
    expect((await iterator.next()).done).toBe(true)
    expect(body.locked).toBe(false)
  })

  it('rejects empty and truncated audio rather than playing invalid samples', async () => {
    await expect(
      collect(decodePcmStream(bytes([]), new AbortController().signal)),
    ).rejects.toThrow('invalid-audio')
    await expect(
      collect(decodePcmStream(bytes([1]), new AbortController().signal)),
    ).rejects.toThrow('invalid-audio')
  })

  it('cancels a pending body read and releases the reader on stop', async () => {
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({ cancel })
    const controller = new AbortController()
    const result = collect(decodePcmStream(body, controller.signal))
    controller.abort()
    await expect(result).rejects.toMatchObject({ name: 'AbortError' })
    expect(cancel).toHaveBeenCalledOnce()
    expect(body.locked).toBe(false)
  })
})

describe('speech requests', () => {
  // The attested connection to the harness, with its transport replaced.
  function connect(response: () => Response | Promise<Response>) {
    stubChatAccess()
    const secure = {
      ready: vi.fn().mockResolvedValue(undefined),
      fetch: vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
        response(),
      ),
      getVerificationDocument: vi.fn(),
    }
    const api = new HarnessAPI(
      new HarnessClient(
        'https://harness.example/',
        async () => 'clerk-session',
        () => secure,
      ),
      'alice',
    )
    activateAPI(api)
    // A chat kept on this device, which the harness reads without a key.
    const speech = speechSource((signal) =>
      api.stream(
        '/v1/speech',
        { local: true, thread: { id: 'chat' }, messageId: 'reply' },
        { signal, keyless: true },
      ),
    )
    return { secure, speech }
  }

  it('reads the one audio stream the harness answers over the attested connection', async () => {
    const { secure, speech } = connect(
      () =>
        new Response(bytes([0, 64], [0, 192]), {
          headers: { 'Content-Type': 'audio/pcm; rate=24000' },
        }),
    )
    await expect(
      collect(speech(new AbortController().signal)),
    ).resolves.toEqual([0.5, -0.5])
    expect(secure.fetch).toHaveBeenCalledOnce()
    const [url, init] = secure.fetch.mock.calls[0]
    expect(url).toBe('https://harness.example/v1/speech')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(init?.body as string)).toEqual({
      local: true,
      thread: { id: 'chat' },
      messageId: 'reply',
    })
    expect(new Headers(init?.headers).get('Authorization')).toBe(
      'Bearer clerk-session',
    )
  })

  it.each(['audio/wav', 'application/json'])(
    'rejects and cancels unexpected %s instead of interpreting it as PCM',
    async (mediaType) => {
      const cancel = vi.fn()
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(mediaType === 'audio/wav' ? 'RIFF' : '{}'),
          )
        },
        cancel,
      })
      const { speech } = connect(
        () => new Response(body, { headers: { 'Content-Type': mediaType } }),
      )
      await expect(
        collect(speech(new AbortController().signal)),
      ).rejects.toMatchObject({ code: 'invalid-audio' })
      expect(cancel).toHaveBeenCalledOnce()
      expect(body.locked).toBe(false)
    },
  )

  it('does not retry a refused request', async () => {
    const { secure, speech } = connect(
      () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'TOOL_UNAVAILABLE',
              message: 'Speech is unavailable',
              action: 'retry',
            },
          }),
          {
            status: 503,
            headers: { 'Content-Type': 'application/json', ...SEALED },
          },
        ),
    )
    const refusal = await collect(speech(new AbortController().signal)).catch(
      (error: unknown) => error,
    )
    expect(refusal).toBeInstanceOf(HarnessError)
    expect(refusal).toMatchObject({ status: 503, code: 'TOOL_UNAVAILABLE' })
    expect(secure.fetch).toHaveBeenCalledOnce()
  })

  it('does not send speech after cancellation while the connection is verified', async () => {
    let verified!: () => void
    const { secure, speech } = connect(
      () =>
        new Response(bytes([0, 0]), {
          headers: { 'Content-Type': 'audio/pcm' },
        }),
    )
    secure.ready.mockReturnValue(
      new Promise<void>((resolve) => {
        verified = resolve
      }),
    )
    const controller = new AbortController()
    const result = collect(speech(controller.signal))
    await vi.waitFor(() => expect(secure.ready).toHaveBeenCalledOnce())
    controller.abort()
    verified()
    await expect(result).rejects.toMatchObject({ name: 'AbortError' })
    expect(secure.fetch).not.toHaveBeenCalled()
  })

  it('explains a rate limit by its status without exposing server details', async () => {
    const { speech } = connect(
      () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'RATE_LIMITED',
              message: 'private request details',
              action: 'wait',
            },
          }),
          {
            status: 429,
            headers: { 'Content-Type': 'application/json', ...SEALED },
          },
        ),
    )
    const result = collect(speech(new AbortController().signal)).catch(
      speechErrorMessage,
    )
    await expect(result).resolves.toBe(
      'Speech usage limit reached. Please try again later.',
    )
  })

  it.each([
    [
      400,
      'BAD_REQUEST',
      'stop',
      'There is nothing to read aloud',
      'There is no readable text in this response.',
    ],
    [
      413,
      'PAYLOAD_TOO_LARGE',
      'revise',
      'The text is too long to read aloud',
      'This response is too long to read aloud.',
    ],
  ])(
    'shows why the harness refuses a text with status %i',
    async (status, code, action, message, shown) => {
      const { speech } = connect(
        () =>
          new Response(JSON.stringify({ error: { code, message, action } }), {
            status,
            headers: { 'Content-Type': 'application/json', ...SEALED },
          }),
      )
      const result = collect(speech(new AbortController().signal)).catch(
        speechErrorMessage,
      )
      await expect(result).resolves.toBe(shown)
    },
  )
})
