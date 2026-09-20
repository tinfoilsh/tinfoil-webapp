import { getTinfoilClient } from '@/services/inference/tinfoil-client'
import { SPEECH } from './constants'
import { SpeechError } from './errors'

export type SpeechStream = (
  text: string,
  signal: AbortSignal,
) => AsyncIterable<Float32Array>

export async function* decodePcmStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<Float32Array> {
  const reader = body.getReader()
  const cancel = () => {
    void reader.cancel().catch(() => undefined)
  }
  signal.addEventListener('abort', cancel, { once: true })
  let lowByte: number | undefined
  let block = new Float32Array(SPEECH.BLOCK_SAMPLES)
  let used = 0
  let total = 0
  try {
    signal.throwIfAborted()
    while (true) {
      const { done, value } = await reader.read()
      signal.throwIfAborted()
      if (done) break
      for (const byte of value) {
        if (lowByte === undefined) {
          lowByte = byte
          continue
        }
        const unsigned = lowByte | (byte << 8)
        block[used++] =
          (unsigned >= SPEECH.PCM_SCALE
            ? unsigned - SPEECH.PCM_SCALE * 2
            : unsigned) / SPEECH.PCM_SCALE
        lowByte = undefined
        if (++total > SPEECH.MAX_CHUNK_AUDIO_SECONDS * SPEECH.SAMPLE_RATE) {
          throw new SpeechError('invalid-audio')
        }
        if (used === block.length) {
          yield block
          signal.throwIfAborted()
          block = new Float32Array(SPEECH.BLOCK_SAMPLES)
          used = 0
        }
      }
    }
    if (lowByte !== undefined || total === 0)
      throw new SpeechError('invalid-audio')
    if (used) yield block.slice(0, used)
  } finally {
    signal.removeEventListener('abort', cancel)
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

export const streamSpeech: SpeechStream = async function* (text, signal) {
  const controller = new AbortController()
  const abort = () => controller.abort(signal.reason)
  signal.addEventListener('abort', abort, { once: true })
  const timeout = setTimeout(
    () =>
      controller.abort(
        new DOMException('Speech request timed out', 'TimeoutError'),
      ),
    SPEECH.REQUEST_TIMEOUT_MS,
  )
  try {
    signal.throwIfAborted()
    const client = await getTinfoilClient()
    controller.signal.throwIfAborted()
    const response = await client.audio.speech.create(
      {
        model: SPEECH.MODEL,
        voice: SPEECH.VOICE,
        instructions: SPEECH.INSTRUCTIONS,
        input: text,
        response_format: 'pcm',
        stream_format: 'audio',
      },
      {
        signal: controller.signal,
        maxRetries: 0,
        timeout: SPEECH.REQUEST_TIMEOUT_MS,
      },
    )
    controller.signal.throwIfAborted()
    const mediaType = response.headers.get('content-type')?.split(';')[0].trim()
    if (mediaType !== 'audio/pcm' || !response.body) {
      await response.body?.cancel()
      throw new SpeechError('invalid-audio')
    }
    yield* decodePcmStream(response.body, controller.signal)
  } finally {
    clearTimeout(timeout)
    signal.removeEventListener('abort', abort)
    controller.abort()
  }
}
