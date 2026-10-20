import { SPEECH } from './constants'
import { SpeechError } from './errors'

// Audio samples as they arrive, until the signal aborts.
export type SpeechSource = (signal: AbortSignal) => AsyncIterable<Float32Array>

// Asks the harness to read a reply aloud; it answers with one audio stream.
export type OpenSpeech = (signal: AbortSignal) => Promise<Response>

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
        total++
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

// The samples of the audio stream the harness answers a read-aloud request
// with.
export function speechSource(open: OpenSpeech): SpeechSource {
  return async function* (signal) {
    const response = await open(signal)
    signal.throwIfAborted()
    const mediaType = response.headers.get('content-type')?.split(';')[0].trim()
    if (mediaType !== 'audio/pcm' || !response.body) {
      await response.body?.cancel()
      throw new SpeechError('invalid-audio')
    }
    yield* decodePcmStream(response.body, signal)
  }
}
