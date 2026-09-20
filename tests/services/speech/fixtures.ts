import { SPEECH } from '@/services/speech/constants'
import type { SpeechStream } from '@/services/speech/stream'
import { vi } from 'vitest'

export class FakeAudioContext {
  currentTime = 0
  state = 'running'
  destination = {}
  onstatechange: (() => void) | null = null
  scheduled: FakeAudioSource[] = []
  resume = vi.fn(async (): Promise<void> => {
    this.state = 'running'
    this.onstatechange?.()
  })
  close = vi.fn(async () => {
    this.state = 'closed'
  })
  createBuffer(_channels: number, length: number, sampleRate: number) {
    const data = new Float32Array(length)
    return { duration: length / sampleRate, getChannelData: () => data }
  }
  createBufferSource() {
    return new FakeAudioSource(this)
  }
  advanceTo(time: number) {
    for (;;) {
      const next = this.scheduled.find(
        (node) =>
          !node.ended &&
          !node.stopped &&
          node.startTime + node.buffer!.duration <= time,
      )
      if (!next) break
      this.currentTime = next.startTime + next.buffer!.duration
      next.ended = true
      next.onended?.()
    }
    this.currentTime = time
  }
}

class FakeAudioSource {
  buffer: ReturnType<FakeAudioContext['createBuffer']> | null = null
  onended: (() => void) | null = null
  startTime = 0
  stopped = false
  ended = false
  connect = vi.fn()
  disconnect = vi.fn()
  constructor(private context: FakeAudioContext) {}
  start(time: number) {
    this.startTime = time
    this.context.scheduled.push(this)
  }
  stop() {
    this.stopped = true
  }
}

export interface ControlledRequest {
  text: string
  signal: AbortSignal
  consumed: number
  finished: boolean
  push: (seconds: number, sample?: number) => void
  finish: () => void
  fail: (error: Error) => void
}

export function controlledSpeech() {
  const requests: ControlledRequest[] = []
  const stream: SpeechStream = async function* (text, signal) {
    const queue: (Float32Array | Error | null)[] = []
    let wake: (() => void) | undefined
    const enqueue = (item: Float32Array | Error | null) => {
      queue.push(item)
      wake?.()
    }
    const abort = () => wake?.()
    signal.addEventListener('abort', abort, { once: true })
    const request: ControlledRequest = {
      text,
      signal,
      consumed: 0,
      finished: false,
      push: (seconds, sample = 0) =>
        enqueue(
          new Float32Array(Math.round(seconds * SPEECH.SAMPLE_RATE)).fill(
            sample,
          ),
        ),
      finish: () => enqueue(null),
      fail: (error) => enqueue(error),
    }
    requests.push(request)
    try {
      for (;;) {
        signal.throwIfAborted()
        if (!queue.length)
          await new Promise<void>((resolve) => {
            wake = resolve
          })
        const item = queue.shift()
        if (item === null) return
        if (item instanceof Error) throw item
        if (item) {
          yield item
          request.consumed++
        }
      }
    } finally {
      request.finished = true
      signal.removeEventListener('abort', abort)
    }
  }
  return { requests, stream }
}

export function speechParagraphs(count: number): string {
  return Array.from(
    { length: count },
    (_, i) => `${i}: ${'A'.repeat(SPEECH.TARGET_CHUNK_CHARACTERS)}.`,
  ).join(' ')
}
