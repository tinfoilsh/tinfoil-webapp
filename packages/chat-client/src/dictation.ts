import { getAudioContextClass } from './audio-context'
import { DICTATION } from './dictation-constants'
import { logWarning } from './logging'
import { ERROR_ACTIONS } from './protocol'
import { recordSegments, type SegmentRecorder } from './segment-recorder'
import { HarnessError } from './sse'

const MS_PER_SECOND = 1000

// A stretch of dictation kept until its text reaches the composer of the
// chat it was dictated in: its recording until it is transcribed, then its
// text.
export interface StoredDictationSegment {
  id: string
  chatId: string
  dictationId: string
  index: number
  startedAt: number
  mimeType: string
  audio?: ArrayBuffer
  text?: string
}

// Where dictation is kept until its text reaches a composer.
export interface DictationStore {
  getDictationSegments(): Promise<StoredDictationSegment[]>
  putDictationSegment(segment: StoredDictationSegment): Promise<void>
  deleteDictationSegment(id: string): Promise<void>
}

// Turns a recording into its text.
export type Transcribe = (audio: File, signal?: AbortSignal) => Promise<string>

// Keeps nothing, for dictation that does not outlive its page.
const NOWHERE: DictationStore = {
  getDictationSegments: async () => [],
  putDictationSegment: async () => {},
  deleteDictationSegment: async () => {},
}

export interface DictationSnapshot {
  // Recording while the microphone is open; transcribing while a recording
  // it closed is on its first attempt, which the composer waits for.
  status: 'idle' | 'recording' | 'transcribing'
  stream: MediaStream | null
  // Recordings whose first attempt failed, being tried again.
  retrying: number
  // Recordings that could not be transcribed, kept until the user tries
  // them again or discards them.
  failed: number
}

export class DictationUnsupportedError extends Error {
  constructor() {
    super('WebM audio recording is not supported in this browser')
    this.name = 'DictationUnsupportedError'
  }
}

interface Segment {
  id: string
  // The chat it was dictated in, whose composer alone takes its text.
  chatId: string
  dictationId: string
  index: number
  startedAt: number
  mimeType: string
  audio?: Blob
  text?: string
  recording: boolean
  // Attempts that failed, and the next attempt's place in the retry
  // schedule.
  attempts: number
  retries: number
  retryAt?: number
  inFlight: boolean
  failed: boolean
  // Kept in storage until its text reaches the composer, unless it was
  // dictated in a temporary chat.
  persist: boolean
  // The segment's writes to storage, in the order they were made.
  saving: Promise<void>
}

interface Meter {
  level: () => number
  close: () => void
}

const IDLE: DictationSnapshot = {
  status: 'idle',
  stream: null,
  retrying: 0,
  failed: 0,
}

// Reads the microphone's level, or reads it as quiet where audio cannot be
// analyzed, so recordings end at their length.
function meter(stream: MediaStream): Meter {
  const quiet: Meter = { level: () => 0, close: () => {} }
  const AudioContextClass = getAudioContextClass()
  if (!AudioContextClass) return quiet
  try {
    const context = new AudioContextClass()
    const source = context.createMediaStreamSource(stream)
    const analyser = context.createAnalyser()
    source.connect(analyser)
    void context.resume().catch(() => {})
    const samples = new Float32Array(analyser.fftSize)
    return {
      level: () => {
        analyser.getFloatTimeDomainData(samples)
        let sumOfSquares = 0
        for (const sample of samples) sumOfSquares += sample * sample
        return Math.sqrt(sumOfSquares / samples.length)
      },
      close: () => {
        source.disconnect()
        void context.close().catch(() => {})
      },
    }
  } catch {
    return quiet
  }
}

// Whether a recording that failed to transcribe is worth sending again
// unasked: not one the chat service refused for a reason that waiting does
// not change.
export function transcribesLater(error: unknown): boolean {
  if (!(error instanceof HarnessError)) return true
  const { action } = error.detail
  return action === ERROR_ACTIONS.retry || action === ERROR_ACTIONS.wait
}

// How long to wait before transcribing a recording again after an attempt
// failed, or undefined when it waits for the user instead.
function retryDelay(error: unknown, retries: number): number | undefined {
  if (retries >= DICTATION.RETRY_DELAYS_MS.length || !transcribesLater(error))
    return undefined
  const delay = DICTATION.RETRY_DELAYS_MS[retries]
  if (!(error instanceof HarnessError)) return delay
  return Math.max(delay, (error.detail.retryAfter ?? 0) * MS_PER_SECOND)
}

const order = (a: Segment, b: Segment) =>
  a.startedAt - b.startedAt || a.index - b.index

const waiting = (segment: Segment) =>
  segment.text === undefined && !segment.failed

interface Receiver {
  chatId: string
  receive: (text: string) => void
}

// Dictation, sent to be transcribed in short recordings while the user keeps
// talking. Each recording's text reaches, in order, the composer of the chat
// it was dictated in, and a recording is kept on this device until its text
// has, so a failure, a reload or a closed tab loses no more than the
// recording under way.
export class Dictation {
  private snapshot: DictationSnapshot = IDLE
  private readonly listeners = new Set<() => void>()
  private readonly receivers: Receiver[] = []
  private readonly segments = new Map<string, Segment>()
  private recorder: SegmentRecorder | null = null
  private stream: MediaStream | null = null
  // The composer that started the dictation under way.
  private owner: symbol | undefined
  // Counts starts, so a stop while the microphone is asked for ends it.
  private starts = 0
  private starting = false
  private wake: ReturnType<typeof setTimeout> | undefined
  private lifetime = new AbortController()
  private loaded: Promise<void> | null = null

  constructor(
    private readonly transcribe: Transcribe,
    private readonly storage: DictationStore = NOWHERE,
  ) {}

  getSnapshot = (): DictationSnapshot => this.snapshot
  getServerSnapshot = (): DictationSnapshot => IDLE
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  // The composer that the text dictated in a chat goes to, until the
  // function returned is called. Text that arrives while no composer of its
  // chat listens waits for one, as does dictation a closed page left in
  // storage.
  listen(chatId: string, receive: (text: string) => void): () => void {
    const receiver: Receiver = { chatId, receive }
    this.receivers.push(receiver)
    this.loaded ??= this.load()
    this.deliver()
    return () => {
      const index = this.receivers.lastIndexOf(receiver)
      if (index >= 0) this.receivers.splice(index, 1)
    }
  }

  async start({
    owner,
    chatId,
    segmentSeconds,
    persist,
  }: {
    owner: symbol
    chatId: string
    segmentSeconds: number
    persist: boolean
  }): Promise<void> {
    if (this.recorder || this.starting) return
    if (
      typeof MediaRecorder === 'undefined' ||
      !MediaRecorder.isTypeSupported(DICTATION.MIME_TYPE)
    )
      throw new DictationUnsupportedError()
    const start = ++this.starts
    this.owner = owner
    this.starting = true
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: DICTATION.CHANNELS,
          sampleRate: DICTATION.SAMPLE_RATE,
          echoCancellation: true,
          noiseSuppression: true,
        },
      })
    } finally {
      this.starting = false
    }
    if (start !== this.starts) {
      stream.getTracks().forEach((track) => track.stop())
      return
    }
    const dictationId = crypto.randomUUID()
    const startedAt = Date.now()
    const segmentId = (index: number) => `${dictationId}:${index}`
    const level = meter(stream)
    const release = () => {
      stream.getTracks().forEach((track) => track.stop())
      level.close()
      if (this.stream === stream) this.stream = null
    }
    let recorder: SegmentRecorder
    try {
      recorder = recordSegments({
        stream,
        segmentMs: segmentSeconds * MS_PER_SECOND,
        level: level.level,
        onBegin: (index) => {
          const id = segmentId(index)
          this.segments.set(id, {
            id,
            chatId,
            dictationId,
            index,
            startedAt,
            mimeType: DICTATION.MIME_TYPE,
            recording: true,
            attempts: 0,
            retries: 0,
            inFlight: false,
            failed: false,
            persist,
            saving: Promise.resolve(),
          })
        },
        onSegment: (index, audio) => this.recorded(segmentId(index), audio),
        onEnd: () => {
          release()
          if (this.recorder === recorder) this.recorder = null
          this.refresh()
        },
      })
    } catch (error) {
      release()
      throw error
    }
    this.stream = stream
    this.recorder = recorder
    this.refresh()
  }

  // Closes the microphone, unless an owner is named that did not start the
  // dictation under way. What was recorded is still transcribed.
  stop(owner?: symbol): void {
    if (owner !== undefined && owner !== this.owner) return
    this.starts++
    const recorder = this.recorder
    this.recorder = null
    recorder?.stop()
    this.refresh()
  }

  // Transcribes again the recordings that failed.
  retry(): void {
    for (const segment of this.segments.values()) {
      if (!segment.failed) continue
      segment.failed = false
      segment.retries = 0
      segment.retryAt = undefined
    }
    this.work()
  }

  // Forgets the recordings that failed, so the text after them arrives.
  discard(): void {
    for (const segment of [...this.segments.values()]) {
      if (segment.failed) this.forget(segment)
    }
    this.deliver()
  }

  // Ends dictation and forgets it, as when the account signs out; storage
  // is cleared with the account's other data.
  reset(): void {
    this.stop()
    this.lifetime.abort()
    this.lifetime = new AbortController()
    clearTimeout(this.wake)
    this.segments.clear()
    this.loaded = null
    this.refresh()
  }

  private async load(): Promise<void> {
    const lifetime = this.lifetime.signal
    let stored: StoredDictationSegment[]
    try {
      stored = await this.storage.getDictationSegments()
    } catch (error) {
      logWarning('Failed to read saved dictation', {
        component: 'Dictation',
        metadata: { error: String(error) },
      })
      return
    }
    if (lifetime.aborted) return
    for (const saved of stored) {
      if (this.segments.has(saved.id)) continue
      // A recording a closed page left is tried again without the composer
      // waiting for it.
      const segment: Segment = {
        ...saved,
        audio: saved.audio
          ? new Blob([saved.audio], { type: saved.mimeType })
          : undefined,
        recording: false,
        attempts: saved.text === undefined ? 1 : 0,
        retries: 0,
        inFlight: false,
        failed: false,
        persist: true,
        saving: Promise.resolve(),
      }
      if (segment.audio || segment.text !== undefined)
        this.segments.set(segment.id, segment)
      else this.forget(segment)
    }
    this.deliver()
    this.work()
  }

  private recorded(id: string, audio: Blob): void {
    const segment = this.segments.get(id)
    if (!segment) return
    segment.recording = false
    if (!audio.size) {
      this.segments.delete(id)
      this.deliver()
      return
    }
    segment.audio = audio
    this.save(segment, async () =>
      this.storage.putDictationSegment({
        ...this.stored(segment),
        audio: await audio.arrayBuffer(),
      }),
    )
    this.refresh()
    this.work()
  }

  private stored(segment: Segment): StoredDictationSegment {
    const { id, chatId, dictationId, index, startedAt, mimeType } = segment
    return { id, chatId, dictationId, index, startedAt, mimeType }
  }

  private save(segment: Segment, write: () => Promise<void>): void {
    if (!segment.persist) return
    segment.saving = segment.saving.then(write).catch((error) => {
      logWarning('Failed to save dictation', {
        component: 'Dictation',
        metadata: { error: String(error) },
      })
    })
  }

  // Starts the attempts that are due: one recording's first attempt and one
  // retry at a time, oldest first, so a recording being retried never holds
  // up one the composer waits for.
  private work(): void {
    clearTimeout(this.wake)
    const now = Date.now()
    const pending = [...this.segments.values()]
      .filter(
        (segment) =>
          segment.audio &&
          waiting(segment) &&
          !segment.recording &&
          !segment.inFlight,
      )
      .sort(order)
    const inFlight = [...this.segments.values()].filter(
      (segment) => segment.inFlight,
    )
    for (const first of [true, false]) {
      if (inFlight.some((segment) => (segment.attempts === 0) === first))
        continue
      const next = pending.find(
        (segment) =>
          (segment.attempts === 0) === first && (segment.retryAt ?? 0) <= now,
      )
      if (next) void this.attempt(next)
    }
    // An attempt that ends starts the next one due; a retry not yet due
    // wakes the queue when it is.
    const due = pending
      .map((segment) => segment.retryAt ?? 0)
      .filter((retryAt) => retryAt > now)
    if (due.length)
      this.wake = setTimeout(() => this.work(), Math.min(...due) - now)
    this.refresh()
  }

  private async attempt(segment: Segment): Promise<void> {
    const lifetime = this.lifetime.signal
    segment.inFlight = true
    try {
      const text = await this.transcribe(
        new File([segment.audio!], DICTATION.FILE_NAME, {
          type: segment.mimeType,
        }),
        AbortSignal.any([
          lifetime,
          AbortSignal.timeout(DICTATION.ATTEMPT_TIMEOUT_MS),
        ]),
      )
      if (lifetime.aborted || this.segments.get(segment.id) !== segment) return
      segment.text = text.trim()
      segment.audio = undefined
      this.save(segment, () =>
        this.storage.putDictationSegment({
          ...this.stored(segment),
          text: segment.text,
        }),
      )
    } catch (error) {
      if (lifetime.aborted || this.segments.get(segment.id) !== segment) return
      const delay = retryDelay(error, segment.retries)
      segment.attempts++
      segment.retries++
      if (delay === undefined) {
        logWarning('Dictation could not be transcribed', {
          component: 'Dictation',
          metadata: {
            code: error instanceof HarnessError ? error.code : undefined,
          },
        })
        segment.failed = true
      } else {
        segment.retryAt = Date.now() + delay
      }
    } finally {
      segment.inFlight = false
    }
    this.deliver()
    this.work()
  }

  // Hands the composer of each dictation's chat its text in order, up to the
  // first recording still waiting for its own.
  private deliver(): void {
    const dictations = new Map<string, Segment[]>()
    for (const segment of [...this.segments.values()].sort(order)) {
      const segments = dictations.get(segment.dictationId) ?? []
      segments.push(segment)
      dictations.set(segment.dictationId, segments)
    }
    for (const segments of dictations.values()) {
      const receiver = this.receivers.findLast(
        ({ chatId }) => chatId === segments[0].chatId,
      )
      if (!receiver) continue
      for (const segment of segments) {
        if (segment.text === undefined) break
        this.forget(segment)
        if (segment.text) receiver.receive(segment.text)
      }
    }
    this.refresh()
  }

  private forget(segment: Segment): void {
    this.segments.delete(segment.id)
    this.save(segment, () => this.storage.deleteDictationSegment(segment.id))
  }

  private refresh(): void {
    const segments = [...this.segments.values()].filter(waiting)
    const snapshot: DictationSnapshot = {
      status: this.recorder
        ? 'recording'
        : segments.some((segment) => segment.attempts === 0)
          ? 'transcribing'
          : 'idle',
      stream: this.recorder ? this.stream : null,
      retrying: segments.filter((segment) => segment.attempts > 0).length,
      failed: [...this.segments.values()].filter((segment) => segment.failed)
        .length,
    }
    if (
      snapshot.status === this.snapshot.status &&
      snapshot.stream === this.snapshot.stream &&
      snapshot.retrying === this.snapshot.retrying &&
      snapshot.failed === this.snapshot.failed
    )
      return
    this.snapshot = snapshot
    this.listeners.forEach((listener) => listener())
  }
}
