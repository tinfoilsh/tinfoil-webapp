import { SPEECH } from '@/services/speech/constants'
import { speechErrorMessage } from '@/services/speech/errors'
import { decodePcmStream, streamSpeech } from '@/services/speech/stream'
import OpenAI from 'openai'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { getClient } = vi.hoisted(() => ({ getClient: vi.fn() }))
vi.mock('@/services/inference/tinfoil-client', () => ({
  getTinfoilClient: getClient,
}))

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
  vi.useRealTimers()
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
    source.enqueue(
      new Uint8Array(SPEECH.BLOCK_SAMPLES * SPEECH.BYTES_PER_SAMPLE + 2),
    )
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

  it('rejects excessive generated audio and closes the stream', async () => {
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(
          new Uint8Array(SPEECH.BLOCK_SAMPLES * SPEECH.BYTES_PER_SAMPLE),
        )
      },
      cancel,
    })
    await expect(
      (async () => {
        for await (const _part of decodePcmStream(
          body,
          new AbortController().signal,
        )) {
          /* Consume without retaining audio. */
        }
      })(),
    ).rejects.toThrow('invalid-audio')
    expect(cancel).toHaveBeenCalledOnce()
  })
})

describe('speech SDK requests', () => {
  function clientWithResponse(response: () => Response) {
    const transport = vi.fn<typeof fetch>(async () => response())
    getClient.mockResolvedValue(
      new OpenAI({
        apiKey: 'test-session-key',
        fetch: transport,
        dangerouslyAllowBrowser: true,
      }),
    )
    return transport
  }

  it('uses the shared SDK transport with Qwen PCM streaming and no retries', async () => {
    const transport = clientWithResponse(
      () =>
        new Response(bytes([0, 0]), {
          headers: { 'Content-Type': 'audio/pcm' },
        }),
    )
    expect(
      await collect(streamSpeech('Hello.', new AbortController().signal)),
    ).toEqual([0])
    const options = transport.mock.calls[0][1] as RequestInit
    expect(JSON.parse(options.body as string)).toEqual({
      model: SPEECH.MODEL,
      voice: SPEECH.VOICE,
      instructions: SPEECH.INSTRUCTIONS,
      input: 'Hello.',
      response_format: 'pcm',
      stream_format: 'audio',
    })
    expect(options.signal).toBeDefined()
  })

  it('sends identical style guidance separately from the text of parallel chunks', async () => {
    const transport = clientWithResponse(
      () =>
        new Response(bytes([0, 0]), {
          headers: { 'Content-Type': 'audio/pcm' },
        }),
    )
    const chunks = [
      'Here is the first part.',
      'This continues the explanation.',
    ]
    await expect(
      Promise.all(
        chunks.map((text) =>
          collect(streamSpeech(text, new AbortController().signal)),
        ),
      ),
    ).resolves.toEqual([[0], [0]])
    expect(
      transport.mock.calls.map(([, options]) =>
        JSON.parse(options!.body as string),
      ),
    ).toEqual(
      chunks.map((input) => ({
        model: SPEECH.MODEL,
        voice: SPEECH.VOICE,
        instructions: SPEECH.INSTRUCTIONS,
        input,
        response_format: 'pcm',
        stream_format: 'audio',
      })),
    )
  })

  it('rejects unexpected WAV or JSON instead of interpreting it as PCM', async () => {
    clientWithResponse(
      () =>
        new Response('{}', { headers: { 'Content-Type': 'application/json' } }),
    )
    await expect(
      collect(streamSpeech('Hello.', new AbortController().signal)),
    ).rejects.toThrow('invalid-audio')
  })

  it('does not retry a failed generation request', async () => {
    const transport = clientWithResponse(
      () =>
        new Response('{}', {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        }),
    )
    await expect(
      collect(streamSpeech('Hello.', new AbortController().signal)),
    ).rejects.toMatchObject({ status: 503 })
    expect(transport).toHaveBeenCalledOnce()
  })

  it('does not send speech after cancellation during SDK initialization', async () => {
    let resolve!: (value: unknown) => void
    getClient.mockReturnValue(
      new Promise((r) => {
        resolve = r
      }),
    )
    const controller = new AbortController()
    const result = collect(streamSpeech('Hello.', controller.signal))
    controller.abort()
    const create = vi.fn()
    resolve({ audio: { speech: { create } } })
    await expect(result).rejects.toMatchObject({ name: 'AbortError' })
    expect(create).not.toHaveBeenCalled()
  })

  it('uses the HTTP status to explain rate limits without exposing server details', async () => {
    clientWithResponse(
      () =>
        new Response(
          JSON.stringify({ error: { message: 'private request details' } }),
          { status: 429, headers: { 'Content-Type': 'application/json' } },
        ),
    )
    const result = collect(
      streamSpeech('Hello.', new AbortController().signal),
    ).catch(speechErrorMessage)
    await expect(result).resolves.toBe(
      'Speech usage limit reached. Please try again later.',
    )
  })

  it('times out stalled response bodies, not just response headers', async () => {
    vi.useFakeTimers()
    const cancel = vi.fn()
    clientWithResponse(
      () =>
        new Response(new ReadableStream({ cancel }), {
          headers: { 'Content-Type': 'audio/pcm' },
        }),
    )
    const result = collect(streamSpeech('Hello.', new AbortController().signal))
    const rejected = expect(result).rejects.toMatchObject({
      name: 'TimeoutError',
    })
    await vi.advanceTimersByTimeAsync(SPEECH.REQUEST_TIMEOUT_MS)
    await rejected
    expect(cancel).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
})
