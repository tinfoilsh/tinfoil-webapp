import { HarnessClient } from '@/services/harness/client'
import { activateAPI, HarnessAPI } from '@/services/harness/runtime'
import { HarnessError } from '@/services/harness/sse'
import { SPEECH } from '@/services/speech/constants'
import { speechErrorMessage } from '@/services/speech/errors'
import { decodePcmStream, streamSpeech } from '@/services/speech/stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

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

  it('accepts the audio limit and rejects the first excess sample', async () => {
    const MAX_PCM_SAMPLES = 2_880_000
    const BLOCK_BYTES = SPEECH.BLOCK_SAMPLES * SPEECH.BYTES_PER_SAMPLE
    const signal = new AbortController().signal
    let acceptedSamples = 0
    const valid = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new Uint8Array(MAX_PCM_SAMPLES * SPEECH.BYTES_PER_SAMPLE),
        )
        controller.close()
      },
    })
    for await (const part of decodePcmStream(valid, signal)) {
      acceptedSamples += part.length
    }
    expect(acceptedSamples).toBe(MAX_PCM_SAMPLES)
    expect(valid.locked).toBe(false)

    const cancel = vi.fn()
    let remainingBytes = (MAX_PCM_SAMPLES + 1) * SPEECH.BYTES_PER_SAMPLE
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (remainingBytes === 0) {
            controller.close()
            return
          }
          const byteCount = Math.min(BLOCK_BYTES, remainingBytes)
          remainingBytes -= byteCount
          controller.enqueue(new Uint8Array(byteCount))
        },
        cancel,
      },
      { highWaterMark: 0 },
    )
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
    expect(body.locked).toBe(false)
  })
})

describe('speech requests', () => {
  // The attested connection to the harness, with its transport replaced.
  function connect(response: () => Response | Promise<Response>) {
    const secure = {
      ready: vi.fn().mockResolvedValue(undefined),
      fetch: vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
        response(),
      ),
      getVerificationDocument: vi.fn(),
    }
    activateAPI(
      new HarnessAPI(
        new HarnessClient(
          'https://harness.example/',
          async () => 'clerk-session',
          secure,
        ),
        'alice',
      ),
    )
    return secure
  }

  it('asks the harness to read each chunk over the attested connection', async () => {
    const secure = connect(
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
    expect(secure.fetch).toHaveBeenCalledTimes(2)
    for (const [index, [url, init]] of secure.fetch.mock.calls.entries()) {
      expect(url).toBe('https://harness.example/v1/speech')
      expect(init?.method).toBe('POST')
      expect(JSON.parse(init?.body as string)).toEqual({ text: chunks[index] })
      expect(new Headers(init?.headers).get('Authorization')).toBe(
        'Bearer clerk-session',
      )
      expect(init?.signal).toBeInstanceOf(AbortSignal)
    }
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
      connect(
        () => new Response(body, { headers: { 'Content-Type': mediaType } }),
      )
      await expect(
        collect(streamSpeech('Hello.', new AbortController().signal)),
      ).rejects.toMatchObject({ code: 'invalid-audio' })
      expect(cancel).toHaveBeenCalledOnce()
      expect(body.locked).toBe(false)
    },
  )

  it('does not retry a refused request', async () => {
    const secure = connect(
      () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'TOOL_UNAVAILABLE',
              message: 'Speech is unavailable',
            },
          }),
          { status: 503, headers: { 'Content-Type': 'application/json' } },
        ),
    )
    const refusal = await collect(
      streamSpeech('Hello.', new AbortController().signal),
    ).catch((error: unknown) => error)
    expect(refusal).toBeInstanceOf(HarnessError)
    expect(refusal).toMatchObject({ status: 503, code: 'TOOL_UNAVAILABLE' })
    expect(secure.fetch).toHaveBeenCalledOnce()
  })

  it('does not send speech after cancellation while the connection is verified', async () => {
    let verified!: () => void
    const secure = connect(
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
    const result = collect(streamSpeech('Hello.', controller.signal))
    await vi.waitFor(() => expect(secure.ready).toHaveBeenCalledOnce())
    controller.abort()
    verified()
    await expect(result).rejects.toMatchObject({ name: 'AbortError' })
    expect(secure.fetch).not.toHaveBeenCalled()
  })

  it('explains a rate limit by its status without exposing server details', async () => {
    connect(
      () =>
        new Response(
          JSON.stringify({
            error: { code: 'RATE_LIMITED', message: 'private request details' },
          }),
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
    connect(
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
