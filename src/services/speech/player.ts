import { getAudioContextClass } from '@/utils/audio-context'
import { logWarning } from '@/utils/error-handling'
import { SPEECH } from './constants'
import { SpeechError, speechErrorMessage } from './errors'
import { streamSpeech, type SpeechStream } from './stream'
import {
  prepareSpeechText,
  splitSpeechText,
  type SpeechTextFormat,
} from './text'

export interface SpeechSnapshot {
  owner: symbol | null
  status: 'idle' | 'loading' | 'playing' | 'paused' | 'error'
  error?: string
}

const IDLE: SpeechSnapshot = { owner: null, status: 'idle' }

interface Chunk {
  buffers: Float32Array[]
  seconds: number
  done: boolean
  pendingNodes: number
}

interface Session {
  owner: symbol
  controller: AbortController
  context: AudioContext
  text: string[]
  chunks: Map<number, Chunk>
  nodes: Set<AudioBufferSourceNode>
  nextRequest: number
  nextSchedule: number
  nextPlayback: number
  inFlight: number
  scheduledUntil: number
  started: boolean
  onPageHide: () => void
}

function createAudioContext(): AudioContext {
  const AudioContextClass = getAudioContextClass()
  if (!AudioContextClass) throw new SpeechError('unsupported')
  return new AudioContextClass({ sampleRate: SPEECH.SAMPLE_RATE })
}

export class SpeechPlayer {
  private snapshot: SpeechSnapshot = IDLE
  private listeners = new Set<() => void>()
  private session: Session | null = null

  constructor(
    private readonly synthesize: SpeechStream = streamSpeech,
    private readonly audioContext: () => AudioContext = createAudioContext,
  ) {}

  getSnapshot = (): SpeechSnapshot => this.snapshot
  getServerSnapshot = (): SpeechSnapshot => IDLE
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private update(snapshot: SpeechSnapshot): void {
    if (
      this.snapshot.owner === snapshot.owner &&
      this.snapshot.status === snapshot.status &&
      this.snapshot.error === snapshot.error
    )
      return
    this.snapshot = snapshot
    this.listeners.forEach((listener) => listener())
  }

  stop(owner?: symbol): void {
    if (owner !== undefined && this.snapshot.owner !== owner) return
    const session = this.session
    this.session = null
    if (session) {
      session.controller.abort()
      window.removeEventListener('pagehide', session.onPageHide)
      session.context.onstatechange = null
      for (const node of session.nodes) {
        node.onended = null
        node.stop()
        node.disconnect()
      }
      session.nodes.clear()
      session.chunks.clear()
      session.text = []
      if (session.context.state !== 'closed') {
        void session.context.close().catch(() => undefined)
      }
    }
    this.update(IDLE)
  }

  read(
    owner: symbol,
    content: string,
    format: SpeechTextFormat = 'markdown',
  ): void {
    this.stop()
    try {
      const text = splitSpeechText(prepareSpeechText(content, format))
      if (!text.length) throw new SpeechError('empty')
      const context = this.audioContext()
      const session: Session = {
        owner,
        controller: new AbortController(),
        context,
        text,
        chunks: new Map(),
        nodes: new Set(),
        nextRequest: 0,
        nextSchedule: 0,
        nextPlayback: 0,
        inFlight: 0,
        scheduledUntil: 0,
        started: false,
        onPageHide: () => this.stop(owner),
      }
      this.session = session
      window.addEventListener('pagehide', session.onPageHide)
      this.update({ owner, status: 'loading' })
      // Resume synchronously within the click gesture, before any network await.
      void context
        .resume()
        .then(() => {
          if (this.session !== session) return
          context.onstatechange = () => this.handleContextState(session)
          this.handleContextState(session)
        })
        .catch((error: unknown) => this.fail(session, error))
    } catch (error) {
      this.stop()
      this.update({ owner, status: 'error', error: speechErrorMessage(error) })
    }
  }

  private fail(session: Session, error: unknown): void {
    if (this.session !== session) return
    this.stop()
    logWarning('Read aloud failed', {
      component: 'SpeechPlayer',
      metadata: {
        code: error instanceof SpeechError ? error.code : 'request-failed',
      },
    })
    this.update({
      owner: session.owner,
      status: 'error',
      error: speechErrorMessage(error),
    })
  }

  resume(owner: symbol): void {
    const session = this.session
    if (
      !session ||
      session.owner !== owner ||
      this.snapshot.status !== 'paused'
    )
      return
    void session.context
      .resume()
      .then(() => this.handleContextState(session))
      .catch((error: unknown) => this.fail(session, error))
  }

  private handleContextState(session: Session): void {
    if (this.session !== session) return
    if (session.context.state === 'closed') {
      this.fail(session, new SpeechError('interrupted'))
    } else if (session.context.state !== 'running') {
      this.update({ owner: session.owner, status: 'paused' })
    } else {
      this.update({
        owner: session.owner,
        status: session.started ? 'playing' : 'loading',
      })
      this.pump(session)
    }
  }

  private pump(session: Session): void {
    if (this.session !== session || session.context.state !== 'running') return
    try {
      while (session.nextPlayback < session.nextSchedule) {
        const chunk = session.chunks.get(session.nextPlayback)
        if (!chunk?.done || chunk.pendingNodes || chunk.buffers.length) break
        session.chunks.delete(session.nextPlayback++)
      }
      if (session.nextPlayback === session.text.length) {
        this.stop(session.owner)
        return
      }

      let contiguousSeconds = 0
      let completeChunks = 0
      for (
        let index = session.nextSchedule;
        index < session.nextRequest;
        index++
      ) {
        const chunk = session.chunks.get(index)!
        contiguousSeconds += chunk.seconds
        if (!chunk.done) break
        completeChunks++
      }

      const now = session.context.currentTime
      if (session.started && session.scheduledUntil <= now) {
        session.started = false
        this.update({ owner: session.owner, status: 'loading' })
      }
      const remainingChunks = session.text.length - session.nextSchedule
      const shortTailReady = completeChunks === remainingChunks
      // A full lookahead window must be playable even when it is shorter than
      // the startup target; further requests are gated on playback progress.
      const shortWindowReady =
        session.nextRequest ===
          session.nextPlayback + SPEECH.LOOKAHEAD_CHUNKS &&
        session.nextSchedule + completeChunks === session.nextRequest
      if (
        !session.started &&
        contiguousSeconds > 0 &&
        (contiguousSeconds >= SPEECH.START_BUFFER_SECONDS ||
          shortTailReady ||
          shortWindowReady)
      ) {
        session.started = true
        session.scheduledUntil = now + SPEECH.SCHEDULE_LEAD_SECONDS
        this.update({ owner: session.owner, status: 'playing' })
      }

      if (session.started) {
        while (session.nextSchedule < session.nextRequest) {
          const chunk = session.chunks.get(session.nextSchedule)!
          for (const samples of chunk.buffers) {
            const buffer = session.context.createBuffer(
              SPEECH.CHANNELS,
              samples.length,
              SPEECH.SAMPLE_RATE,
            )
            buffer.getChannelData(0).set(samples)
            const source = session.context.createBufferSource()
            source.buffer = buffer
            source.connect(session.context.destination)
            source.onended = () => {
              source.disconnect()
              session.nodes.delete(source)
              chunk.pendingNodes--
              this.pump(session)
            }
            try {
              source.start(session.scheduledUntil)
            } catch (error) {
              source.disconnect()
              throw error
            }
            chunk.pendingNodes++
            session.nodes.add(source)
            session.scheduledUntil += buffer.duration
          }
          chunk.buffers = []
          chunk.seconds = 0
          if (!chunk.done) break
          session.nextSchedule++
        }
      }

      const bufferedSeconds =
        Math.max(0, session.scheduledUntil - now) +
        Array.from(session.chunks.values()).reduce(
          (total, chunk) => total + chunk.seconds,
          0,
        )
      while (
        session.inFlight < SPEECH.CONCURRENT_REQUESTS &&
        session.nextRequest < session.text.length &&
        session.nextRequest < session.nextPlayback + SPEECH.LOOKAHEAD_CHUNKS &&
        bufferedSeconds < SPEECH.HIGH_WATER_SECONDS
      ) {
        const index = session.nextRequest++
        const chunk: Chunk = {
          buffers: [],
          seconds: 0,
          done: false,
          pendingNodes: 0,
        }
        session.chunks.set(index, chunk)
        session.inFlight++
        void this.generate(session, index, chunk)
      }
    } catch (error) {
      this.fail(session, error)
    }
  }

  private async generate(
    session: Session,
    index: number,
    chunk: Chunk,
  ): Promise<void> {
    try {
      let samplesReceived = 0
      for await (const samples of this.synthesize(
        session.text[index],
        session.controller.signal,
      )) {
        if (this.session !== session) return
        if (!samples.length) continue
        samplesReceived += samples.length
        if (
          samplesReceived >
          SPEECH.MAX_CHUNK_AUDIO_SECONDS * SPEECH.SAMPLE_RATE
        )
          throw new SpeechError('invalid-audio')
        chunk.buffers.push(samples)
        chunk.seconds += samples.length / SPEECH.SAMPLE_RATE
        this.pump(session)
      }
      if (this.session !== session) return
      if (!samplesReceived) throw new SpeechError('invalid-audio')
      chunk.done = true
      session.inFlight--
      this.pump(session)
    } catch (error) {
      this.fail(session, error)
    }
  }
}

export const speechPlayer = new SpeechPlayer()
