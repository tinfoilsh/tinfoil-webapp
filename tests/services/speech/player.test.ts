import { SPEECH } from '@/services/speech/constants'
import { SpeechPlayer } from '@/services/speech/player'
import { speechSource } from '@/services/speech/stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { controlledSpeak, controlledSpeech, FakeAudioContext } from './fixtures'

describe('buffered speech playback', () => {
  let audio: FakeAudioContext
  let generation: ReturnType<typeof controlledSpeech>
  let player: SpeechPlayer
  let owner: symbol

  beforeEach(() => {
    audio = new FakeAudioContext()
    generation = controlledSpeech()
    player = new SpeechPlayer(() => audio as unknown as AudioContext)
    owner = Symbol('message')
  })
  afterEach(() => player.stop())

  async function start() {
    player.read(owner, generation.stream)
    await vi.waitFor(() => expect(generation.requests).toHaveLength(1))
    return generation.requests[0]
  }

  it('holds the stream until enough playable seconds exist, then plays it in order', async () => {
    const request = await start()
    request.push(SPEECH.START_BUFFER_SECONDS - 1, 0.1)
    await vi.waitFor(() => expect(request.consumed).toBe(1))
    expect(audio.scheduled).toHaveLength(0)
    expect(player.getSnapshot().status).toBe('loading')
    request.push(1, 0.2)
    await vi.waitFor(() => expect(audio.scheduled).toHaveLength(2))
    expect(player.getSnapshot().status).toBe('playing')
    expect(audio.scheduled[0].buffer!.getChannelData()[0]).toBeCloseTo(0.1)
    expect(audio.scheduled[1].buffer!.getChannelData()[0]).toBeCloseTo(0.2)
    expect(audio.scheduled[1].startTime).toBe(
      audio.scheduled[0].startTime + SPEECH.START_BUFFER_SECONDS - 1,
    )
    expect(generation.requests).toHaveLength(1)
  })

  it('plays a fully generated short response and releases audio when it ends', async () => {
    const request = await start()
    request.push(2)
    request.finish()
    await vi.waitFor(() => expect(audio.scheduled).toHaveLength(1))
    audio.advanceTo(3)
    expect(player.getSnapshot().status).toBe('idle')
    expect(audio.close).toHaveBeenCalledOnce()
  })

  it('cleans up and surfaces an error if scheduling an audio node fails', async () => {
    const node = audio.createBufferSource()
    node.start = () => {
      throw new DOMException('Cannot start', 'InvalidStateError')
    }
    node.stop = () => {
      throw new DOMException('Never started', 'InvalidStateError')
    }
    vi.spyOn(audio, 'createBufferSource').mockReturnValue(node)
    const request = await start()
    request.push(1)
    request.finish()
    await vi.waitFor(() => expect(player.getSnapshot().status).toBe('error'))
    expect(node.disconnect).toHaveBeenCalledOnce()
    expect(audio.close).toHaveBeenCalledOnce()
  })

  it('buffers again after an underrun instead of immediately playing every tiny arrival', async () => {
    const request = await start()
    request.push(SPEECH.START_BUFFER_SECONDS)
    await vi.waitFor(() => expect(audio.scheduled).toHaveLength(1))
    audio.advanceTo(SPEECH.START_BUFFER_SECONDS + 1)
    expect(player.getSnapshot().status).toBe('loading')
    request.push(1)
    await vi.waitFor(() => expect(request.consumed).toBe(2))
    expect(audio.scheduled).toHaveLength(1)
    request.finish()
    await vi.waitFor(() => expect(audio.scheduled).toHaveLength(2))
    expect(audio.scheduled[1].startTime).toBe(
      audio.currentTime + SPEECH.SCHEDULE_LEAD_SECONDS,
    )
  })

  it('aborts the stream, stops scheduled audio, and ignores late arrivals', async () => {
    const request = await start()
    request.push(SPEECH.START_BUFFER_SECONDS)
    await vi.waitFor(() => expect(audio.scheduled).toHaveLength(1))
    player.stop(owner)
    expect(request.signal.aborted).toBe(true)
    expect(audio.scheduled.every((node) => node.stopped)).toBe(true)
    request.push(20)
    await vi.waitFor(() => expect(request.finished).toBe(true))
    expect(audio.scheduled).toHaveLength(1)
    expect(player.getSnapshot().status).toBe('idle')
  })

  it('does not allow stale owners to stop replacement playback', async () => {
    const request = await start()
    const newOwner = Symbol('another message')
    audio = new FakeAudioContext()
    // A single player switches owners and disposes its old session.
    player.read(newOwner, generation.stream)
    expect(request.signal.aborted).toBe(true)
    player.stop(owner)
    expect(player.getSnapshot().owner).toBe(newOwner)
    await vi.waitFor(() => expect(generation.requests).toHaveLength(2))
    expect(generation.requests[1].signal.aborted).toBe(false)
  })

  it('stops on failure without exposing server errors or response content', async () => {
    const request = await start()
    request.fail(new Error('sensitive response content'))
    await vi.waitFor(() => expect(player.getSnapshot().status).toBe('error'))
    expect(player.getSnapshot().error).toBe(
      'Could not read this response aloud. Please try again.',
    )
    expect(audio.close).toHaveBeenCalledOnce()
  })

  it('rejects a stream that ends without audio', async () => {
    const request = await start()
    request.finish()
    await vi.waitFor(() => expect(player.getSnapshot().status).toBe('error'))
    expect(player.getSnapshot().error).toBe(
      'The speech service returned unsupported audio. Please try again.',
    )
  })

  it('does not start a request if stopped while audio permission is pending', async () => {
    let resume!: () => void
    audio.resume.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resume = resolve
        }),
    )
    player.read(owner, generation.stream)
    player.stop(owner)
    resume()
    await Promise.resolve()
    expect(generation.requests).toHaveLength(0)
    expect(audio.close).toHaveBeenCalledOnce()
  })

  it('stops on page exit', async () => {
    const request = await start()
    window.dispatchEvent(new Event('pagehide'))
    expect(request.signal.aborted).toBe(true)
    expect(player.getSnapshot().status).toBe('idle')
  })

  it('stops on an unhandled Escape key from anywhere on the page', async () => {
    const request = await start()
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      }),
    )
    expect(request.signal.aborted).toBe(true)
    expect(player.getSnapshot()).toEqual({ owner: null, status: 'idle' })
    expect(audio.close).toHaveBeenCalledOnce()
  })

  it('keeps reading when Escape was already handled or another key is pressed', async () => {
    const request = await start()
    const dialogEscape = vi.fn((event: KeyboardEvent) => event.preventDefault())
    document.addEventListener('keydown', dialogEscape, { capture: true })
    try {
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        }),
      )
    } finally {
      document.removeEventListener('keydown', dialogEscape, { capture: true })
    }
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
      }),
    )
    expect(dialogEscape).toHaveBeenCalledOnce()
    expect(request.signal.aborted).toBe(false)
    expect(player.getSnapshot()).toEqual({ owner, status: 'loading' })
  })

  it('shows an actionable error if the browser closes playback', async () => {
    const request = await start()
    audio.state = 'closed'
    audio.onstatechange?.()
    expect(player.getSnapshot()).toMatchObject({
      status: 'error',
      error: 'Audio playback was interrupted. Please try again.',
    })
    expect(request.signal.aborted).toBe(true)
  })

  it.each(['suspended', 'interrupted'])(
    'preserves playback across a temporary %s context',
    async (state) => {
      const request = await start()
      request.push(2)
      request.finish()
      await vi.waitFor(() => expect(audio.scheduled).toHaveLength(1))
      audio.state = state
      audio.onstatechange?.()
      expect(player.getSnapshot().status).toBe('paused')
      expect(audio.scheduled[0].stopped).toBe(false)
      player.resume(Symbol('wrong owner'))
      expect(audio.resume).toHaveBeenCalledOnce()
      player.resume(owner)
      await vi.waitFor(() =>
        expect(player.getSnapshot().status).toBe('playing'),
      )
      expect(audio.scheduled).toHaveLength(1)
      expect(generation.requests).toHaveLength(1)
      audio.advanceTo(3)
      expect(player.getSnapshot().status).toBe('idle')
    },
  )

  it('waits to request speech when initial audio activation is interrupted', async () => {
    audio.resume.mockImplementationOnce(async () => {
      audio.state = 'interrupted'
    })
    player.read(owner, generation.stream)
    await vi.waitFor(() => expect(player.getSnapshot().status).toBe('paused'))
    expect(generation.requests).toHaveLength(0)
    player.resume(owner)
    await vi.waitFor(() => expect(generation.requests).toHaveLength(1))
    expect(player.getSnapshot().status).toBe('loading')
  })

  it('queues incoming audio while paused and resumes scheduling in order', async () => {
    const request = await start()
    request.push(SPEECH.START_BUFFER_SECONDS)
    await vi.waitFor(() => expect(audio.scheduled).toHaveLength(1))
    audio.state = 'suspended'
    audio.onstatechange?.()
    request.push(1)
    request.push(2)
    request.finish()
    await vi.waitFor(() => expect(request.finished).toBe(true))
    expect(audio.scheduled).toHaveLength(1)
    audio.state = 'running'
    audio.onstatechange?.()
    await vi.waitFor(() => expect(audio.scheduled).toHaveLength(3))
    expect(audio.scheduled[1].startTime).toBe(
      audio.scheduled[0].startTime + SPEECH.START_BUFFER_SECONDS,
    )
    expect(audio.scheduled[2].startTime).toBe(audio.scheduled[1].startTime + 1)
    expect(player.getSnapshot().status).toBe('playing')
  })

  it('stops reading a stream far ahead of playback and reads on as it plays', async () => {
    const request = await start()
    const seconds = SPEECH.MAX_BUFFERED_SECONDS + 2
    for (let second = 0; second < seconds; second++) request.push(1)
    await vi.waitFor(() =>
      expect(audio.scheduled).toHaveLength(SPEECH.MAX_BUFFERED_SECONDS),
    )
    expect(request.consumed).toBe(SPEECH.MAX_BUFFERED_SECONDS - 1)
    audio.advanceTo(3)
    await vi.waitFor(() => expect(audio.scheduled).toHaveLength(seconds))
  })

  it('stops reading while paused once enough audio waits to play', async () => {
    const request = await start()
    request.push(SPEECH.START_BUFFER_SECONDS)
    await vi.waitFor(() => expect(audio.scheduled).toHaveLength(1))
    audio.state = 'suspended'
    audio.onstatechange?.()
    const room = SPEECH.MAX_BUFFERED_SECONDS - SPEECH.START_BUFFER_SECONDS
    for (let second = 0; second < room + 2; second++) request.push(1)
    await vi.waitFor(() => expect(request.consumed).toBe(room))
    audio.state = 'running'
    audio.onstatechange?.()
    expect(audio.scheduled).toHaveLength(room + 1)
    audio.advanceTo(SPEECH.START_BUFFER_SECONDS + 1)
    await vi.waitFor(() => expect(audio.scheduled).toHaveLength(room + 3))
  })
})

describe('stalled speech', () => {
  let player: SpeechPlayer
  let audio: FakeAudioContext
  beforeEach(() => {
    vi.useFakeTimers()
    audio = new FakeAudioContext()
    player = new SpeechPlayer(() => audio as unknown as AudioContext)
  })
  afterEach(() => {
    player.stop()
    vi.useRealTimers()
  })

  it.each([
    ['no response arrives', () => new Promise<Response>(() => {})],
    [
      'the response stops sending audio',
      async (signal: AbortSignal) => {
        const speech = controlledSpeak()
        const response = await speech.speak('reply', signal)
        speech.responses[0].push(1)
        return response
      },
    ],
  ])('ends playback with an error when %s', async (_case, open) => {
    const owner = Symbol('message')
    const signals: AbortSignal[] = []
    player.read(
      owner,
      speechSource((signal) => {
        signals.push(signal)
        return open(signal)
      }),
    )
    await vi.advanceTimersByTimeAsync(SPEECH.IDLE_TIMEOUT_MS - 1)
    expect(signals).toHaveLength(1)
    expect(player.getSnapshot()).toEqual({ owner, status: 'loading' })

    await vi.advanceTimersByTimeAsync(1)

    expect(player.getSnapshot()).toEqual({
      owner,
      status: 'error',
      error: 'The speech service stopped responding. Please try again.',
    })
    expect(signals[0].aborted).toBe(true)
  })
})
