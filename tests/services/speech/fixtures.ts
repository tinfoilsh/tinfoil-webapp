import { SPEECH } from '@/services/speech/constants'
import type { SpeechSource } from '@/services/speech/stream'
import { onTestFinished, vi } from 'vitest'

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
  signal: AbortSignal
  consumed: number
  finished: boolean
  push: (seconds: number, sample?: number) => void
  finish: () => void
  fail: (error: Error) => void
}

export function controlledSpeech() {
  const requests: ControlledRequest[] = []
  const stream: SpeechSource = async function* (signal) {
    const queue: (Float32Array | Error | null)[] = []
    let wake: (() => void) | undefined
    const enqueue = (item: Float32Array | Error | null) => {
      queue.push(item)
      wake?.()
    }
    const abort = () => wake?.()
    signal.addEventListener('abort', abort, { once: true })
    const request: ControlledRequest = {
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

export interface ControlledResponse {
  messageId: string
  signal: AbortSignal
  push: (seconds: number) => void
  finish: () => void
  fail: (error: Error) => void
}

// Read-aloud requests the harness answers with PCM audio a test feeds.
export function controlledSpeak() {
  const responses: ControlledResponse[] = []
  const speak = vi.fn(async (messageId: string, signal: AbortSignal) => {
    let source!: ReadableStreamDefaultController<Uint8Array>
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        source = controller
      },
    })
    responses.push({
      messageId,
      signal,
      push: (seconds) =>
        source.enqueue(
          new Uint8Array(Math.round(seconds * SPEECH.SAMPLE_RATE) * 2),
        ),
      finish: () => source.close(),
      fail: (error) => source.error(error),
    })
    return new Response(body, { headers: { 'Content-Type': 'audio/pcm' } })
  })
  return { responses, speak }
}

// A browser's MediaRecorder, whose recording holds what a test says the
// microphone heard while it recorded. Like a browser, it hands the
// recording over after stop returns.
export class FakeMediaRecorder {
  static recorders: FakeMediaRecorder[] = []
  static isTypeSupported = (mimeType: string) => mimeType === 'audio/webm'
  ondataavailable: ((event: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null
  state: 'inactive' | 'recording' = 'inactive'
  // Whether another recorder was recording when this one was stopped.
  overlapped = false
  private heard: string[] = []

  constructor(
    readonly stream: MediaStream,
    readonly options: MediaRecorderOptions,
  ) {
    FakeMediaRecorder.recorders.push(this)
  }
  start() {
    this.state = 'recording'
  }
  hear(sound: string) {
    if (this.state !== 'recording') throw new Error('Not recording')
    this.heard.push(sound)
  }
  stop() {
    if (this.state === 'inactive') return
    this.state = 'inactive'
    this.overlapped = FakeMediaRecorder.recorders.some(
      (recorder) => recorder.state === 'recording',
    )
    queueMicrotask(() => {
      if (this.heard.length)
        this.ondataavailable?.({
          data: new Blob(this.heard, { type: this.options.mimeType }),
        })
      this.onstop?.()
    })
  }
}

// The recorder recording now.
export function recording(): FakeMediaRecorder {
  const recorders = FakeMediaRecorder.recorders.filter(
    (recorder) => recorder.state === 'recording',
  )
  if (recorders.length !== 1)
    throw new Error(`${recorders.length} recorders are recording`)
  return recorders[0]
}

// A microphone the page is granted, as MediaRecorder and getUserMedia give
// it, until the test ends.
export function grantMicrophone() {
  const track = { stop: vi.fn() }
  const stream = { getTracks: () => [track] } as unknown as MediaStream
  const getUserMedia = vi.fn(async () => stream)
  FakeMediaRecorder.recorders = []
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getUserMedia },
    configurable: true,
  })
  onTestFinished(() => {
    delete (navigator as { mediaDevices?: unknown }).mediaDevices
  })
  return { track, stream, getUserMedia }
}
