import { getAudioContextClass } from '@/utils/audio-context'
import { logWarning } from '@/utils/error-handling'
import { SPEECH } from './constants'
import { SpeechError, speechErrorMessage } from './errors'
import type { SpeechSource } from './stream'

export interface SpeechSnapshot {
  owner: symbol | null
  status: 'idle' | 'loading' | 'playing' | 'paused' | 'error'
  error?: string
}

const IDLE: SpeechSnapshot = { owner: null, status: 'idle' }

interface Session {
  owner: symbol
  controller: AbortController
  context: AudioContext
  source: SpeechSource
  // Samples received and not scheduled yet.
  buffers: Float32Array[]
  bufferedSeconds: number
  nodes: Set<AudioBufferSourceNode>
  requested: boolean
  done: boolean
  scheduledUntil: number
  started: boolean
  // Reads the stream again once playback has drained some audio.
  drained?: () => void
  onPageHide: () => void
  onKeyDown: (event: KeyboardEvent) => void
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
      session.drained?.()
      window.removeEventListener('pagehide', session.onPageHide)
      window.removeEventListener('keydown', session.onKeyDown)
      session.context.onstatechange = null
      for (const node of session.nodes) {
        node.onended = null
        node.stop()
        node.disconnect()
      }
      session.nodes.clear()
      session.buffers = []
      if (session.context.state !== 'closed') {
        void session.context.close().catch(() => undefined)
      }
    }
    this.update(IDLE)
  }

  // Plays the audio a source streams, from its first sample.
  read(owner: symbol, source: SpeechSource): void {
    this.stop()
    try {
      const context = this.audioContext()
      const session: Session = {
        owner,
        controller: new AbortController(),
        context,
        source,
        buffers: [],
        bufferedSeconds: 0,
        nodes: new Set(),
        requested: false,
        done: false,
        scheduledUntil: 0,
        started: false,
        onPageHide: () => this.stop(owner),
        // Escape stops narration from anywhere on the page, so keyboard and
        // screen-reader users need not find the button while audio plays
        // over their screen reader. Dialogs, menus and editors that use
        // Escape mark it handled first.
        onKeyDown: (event) => {
          if (
            event.key === 'Escape' &&
            !event.defaultPrevented &&
            !event.isComposing
          ) {
            this.stop(owner)
          }
        },
      }
      this.session = session
      window.addEventListener('pagehide', session.onPageHide)
      window.addEventListener('keydown', session.onKeyDown)
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
      if (!session.requested) {
        session.requested = true
        void this.receive(session)
      }
      if (session.done && !session.buffers.length && !session.nodes.size) {
        this.stop(session.owner)
        return
      }
      const now = session.context.currentTime
      if (session.started && session.scheduledUntil <= now) {
        session.started = false
        this.update({ owner: session.owner, status: 'loading' })
      }
      // Playback starts, and starts again after running dry, once enough
      // audio is buffered or the stream has ended.
      if (
        !session.started &&
        session.bufferedSeconds > 0 &&
        (session.bufferedSeconds >= SPEECH.START_BUFFER_SECONDS || session.done)
      ) {
        session.started = true
        session.scheduledUntil = now + SPEECH.SCHEDULE_LEAD_SECONDS
        this.update({ owner: session.owner, status: 'playing' })
      }
      if (!session.started) return
      for (const samples of session.buffers) {
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
          this.pump(session)
        }
        try {
          source.start(session.scheduledUntil)
        } catch (error) {
          source.disconnect()
          throw error
        }
        session.nodes.add(source)
        session.scheduledUntil += buffer.duration
      }
      session.buffers = []
      session.bufferedSeconds = 0
    } catch (error) {
      this.fail(session, error)
    } finally {
      session.drained?.()
    }
  }

  // Seconds of audio received and not played yet, buffered or scheduled.
  private ahead(session: Session): number {
    return (
      session.bufferedSeconds +
      Math.max(0, session.scheduledUntil - session.context.currentTime)
    )
  }

  private async receive(session: Session): Promise<void> {
    try {
      let received = false
      for await (const samples of session.source(session.controller.signal)) {
        if (this.session !== session) return
        if (!samples.length) continue
        received = true
        session.buffers.push(samples)
        session.bufferedSeconds += samples.length / SPEECH.SAMPLE_RATE
        this.pump(session)
        while (
          this.session === session &&
          this.ahead(session) >= SPEECH.MAX_BUFFERED_SECONDS
        ) {
          await new Promise<void>((resolve) => {
            session.drained = resolve
          })
        }
        if (this.session !== session) return
      }
      if (this.session !== session) return
      if (!received) throw new SpeechError('invalid-audio')
      session.done = true
      this.pump(session)
    } catch (error) {
      this.fail(session, error)
    }
  }
}

export const speechPlayer = new SpeechPlayer()
