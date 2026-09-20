import { SPEECH } from '@/services/speech/constants'
import { SpeechPlayer } from '@/services/speech/player'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  controlledSpeech,
  FakeAudioContext,
  speechParagraphs,
} from './fixtures'

describe('buffered speech playback', () => {
  let audio: FakeAudioContext
  let generation: ReturnType<typeof controlledSpeech>
  let player: SpeechPlayer
  let owner: symbol

  beforeEach(() => {
    audio = new FakeAudioContext()
    generation = controlledSpeech()
    player = new SpeechPlayer(
      generation.stream,
      () => audio as unknown as AudioContext,
    )
    owner = Symbol('message')
  })
  afterEach(() => player.stop())

  async function start(chunks = 6) {
    player.read(owner, speechParagraphs(chunks))
    await vi.waitFor(() =>
      expect(generation.requests).toHaveLength(
        Math.min(chunks, SPEECH.CONCURRENT_REQUESTS),
      ),
    )
  }

  it('does not count out-of-order audio toward the startup buffer', async () => {
    await start()
    generation.requests[1].push(20, 0.2)
    generation.requests[1].finish()
    await vi.waitFor(() => expect(generation.requests).toHaveLength(3))
    expect(audio.scheduled).toHaveLength(0)
    expect(player.getSnapshot().status).toBe('loading')
    generation.requests[0].push(SPEECH.START_BUFFER_SECONDS, 0.1)
    await vi.waitFor(() => expect(audio.scheduled).toHaveLength(1))
    expect(audio.scheduled[0].buffer!.getChannelData()[0]).toBeCloseTo(0.1)
    generation.requests[0].finish()
    await vi.waitFor(() => expect(audio.scheduled).toHaveLength(2))
    expect(audio.scheduled[1].buffer!.getChannelData()[0]).toBeCloseTo(0.2)
    expect(audio.scheduled[1].startTime).toBe(
      audio.scheduled[0].startTime + audio.scheduled[0].buffer!.duration,
    )
  })

  it('generates chunks three and four while one and two play, with bounded lookahead', async () => {
    await start()
    for (const request of generation.requests.slice()) {
      request.push(6)
      request.finish()
    }
    await vi.waitFor(() => expect(generation.requests).toHaveLength(4))
    expect(player.getSnapshot().status).toBe('playing')
    expect(audio.currentTime).toBe(0)
    for (const request of generation.requests.slice(2)) {
      request.push(6)
      request.finish()
    }
    await vi.waitFor(() => expect(audio.scheduled).toHaveLength(4))
    expect(generation.requests).toHaveLength(4)
    audio.advanceTo(audio.scheduled[0].startTime + 6)
    await vi.waitFor(() => expect(generation.requests).toHaveLength(5))
    expect(generation.requests[4].text).toContain('4:')
  })

  it('holds a single incomplete chunk until enough playable seconds exist', async () => {
    await start(1)
    generation.requests[0].push(SPEECH.START_BUFFER_SECONDS - 1)
    await Promise.resolve()
    expect(audio.scheduled).toHaveLength(0)
    generation.requests[0].push(1)
    await vi.waitFor(() => expect(audio.scheduled).toHaveLength(2))
    expect(player.getSnapshot().status).toBe('playing')
    expect(audio.scheduled[1].startTime).toBe(
      audio.scheduled[0].startTime + SPEECH.START_BUFFER_SECONDS - 1,
    )
  })

  it('plays a fully generated short response and releases audio when it ends', async () => {
    await start(1)
    generation.requests[0].push(2)
    generation.requests[0].finish()
    await vi.waitFor(() => expect(audio.scheduled).toHaveLength(1))
    audio.advanceTo(3)
    expect(player.getSnapshot().status).toBe('idle')
    expect(audio.close).toHaveBeenCalledOnce()
  })

  it('waits beyond two short chunks but does not deadlock a fully buffered lookahead window', async () => {
    await start()
    for (const request of generation.requests.slice()) {
      request.push(1)
      request.finish()
    }
    await vi.waitFor(() => expect(generation.requests).toHaveLength(4))
    expect(audio.scheduled).toHaveLength(0)
    for (const request of generation.requests.slice(2)) {
      request.push(1)
      request.finish()
    }
    await vi.waitFor(() => expect(audio.scheduled).toHaveLength(4))
    expect(player.getSnapshot().status).toBe('playing')
    audio.advanceTo(2)
    await vi.waitFor(() => expect(generation.requests).toHaveLength(5))
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
    await start(1)
    generation.requests[0].push(1)
    generation.requests[0].finish()
    await vi.waitFor(() => expect(player.getSnapshot().status).toBe('error'))
    expect(node.disconnect).toHaveBeenCalledOnce()
    expect(audio.close).toHaveBeenCalledOnce()
  })

  it('buffers again after an underrun instead of immediately playing every tiny arrival', async () => {
    await start(1)
    generation.requests[0].push(SPEECH.START_BUFFER_SECONDS)
    await vi.waitFor(() => expect(audio.scheduled).toHaveLength(1))
    audio.advanceTo(SPEECH.START_BUFFER_SECONDS + 1)
    expect(player.getSnapshot().status).toBe('loading')
    generation.requests[0].push(1)
    await Promise.resolve()
    expect(audio.scheduled).toHaveLength(1)
    generation.requests[0].finish()
    await vi.waitFor(() => expect(audio.scheduled).toHaveLength(2))
    expect(audio.scheduled[1].startTime).toBe(
      audio.currentTime + SPEECH.SCHEDULE_LEAD_SECONDS,
    )
  })

  it('stops launching new requests at the audio high-water mark', async () => {
    await start()
    generation.requests[0].push(SPEECH.HIGH_WATER_SECONDS + 1)
    generation.requests[0].finish()
    generation.requests[1].push(2)
    generation.requests[1].finish()
    await vi.waitFor(() => expect(audio.scheduled).toHaveLength(2))
    expect(generation.requests).toHaveLength(2)
    audio.advanceTo(
      SPEECH.HIGH_WATER_SECONDS + 1 + SPEECH.SCHEDULE_LEAD_SECONDS,
    )
    await vi.waitFor(() => expect(generation.requests).toHaveLength(4))
  })

  it('aborts all generation, stops scheduled audio, and ignores late arrivals', async () => {
    await start()
    generation.requests[0].push(SPEECH.START_BUFFER_SECONDS)
    await vi.waitFor(() => expect(audio.scheduled).toHaveLength(1))
    player.stop(owner)
    expect(generation.requests.every((request) => request.signal.aborted)).toBe(
      true,
    )
    expect(audio.scheduled.every((node) => node.stopped)).toBe(true)
    generation.requests[1].push(20)
    generation.requests[1].finish()
    await Promise.resolve()
    expect(audio.scheduled).toHaveLength(1)
    expect(player.getSnapshot().status).toBe('idle')
  })

  it('does not allow stale owners to stop replacement playback', async () => {
    await start()
    const newOwner = Symbol('another message')
    audio = new FakeAudioContext()
    // A single player switches owners and disposes its old session.
    player.read(newOwner, 'New response.')
    expect(generation.requests[0].signal.aborted).toBe(true)
    player.stop(owner)
    expect(player.getSnapshot().owner).toBe(newOwner)
    await vi.waitFor(() => expect(generation.requests).toHaveLength(3))
    expect(generation.requests[2].signal.aborted).toBe(false)
  })

  it('stops siblings on failure without exposing server errors or response content', async () => {
    await start()
    generation.requests[1].fail(new Error('sensitive response content'))
    await vi.waitFor(() => expect(player.getSnapshot().status).toBe('error'))
    expect(generation.requests[0].signal.aborted).toBe(true)
    expect(player.getSnapshot().error).not.toContain('sensitive')
    expect(audio.close).toHaveBeenCalledOnce()
  })

  it('does not start a request if stopped while audio permission is pending', async () => {
    let resume!: () => void
    audio.resume.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resume = resolve
        }),
    )
    player.read(owner, 'Hello.')
    player.stop(owner)
    resume()
    await Promise.resolve()
    expect(generation.requests).toHaveLength(0)
    expect(audio.close).toHaveBeenCalledOnce()
  })

  it('stops on page exit or external audio interruption', async () => {
    await start()
    window.dispatchEvent(new Event('pagehide'))
    expect(generation.requests[0].signal.aborted).toBe(true)
    expect(player.getSnapshot().status).toBe('idle')
  })

  it('shows an actionable error if the browser suspends playback', async () => {
    await start()
    audio.state = 'suspended'
    audio.onstatechange?.()
    expect(player.getSnapshot()).toMatchObject({
      status: 'error',
      error: 'Audio playback was interrupted. Please try again.',
    })
    expect(generation.requests.every((request) => request.signal.aborted)).toBe(
      true,
    )
  })

  it('rejects an empty response without creating a context or making requests', () => {
    player.read(owner, '```js\nexample()\n```')
    expect(player.getSnapshot()).toMatchObject({
      status: 'error',
      error: 'There is no readable text in this response.',
    })
    expect(generation.requests).toHaveLength(0)
    expect(audio.resume).not.toHaveBeenCalled()
  })
})
