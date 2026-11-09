import { DICTATION } from '@/services/speech/constants'
import { recordSegments } from '@/services/speech/segment-recorder'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeMediaRecorder, grantMicrophone, recording } from './fixtures'

const SEGMENT_MS = 10_000
const SPEAKING = 0.5

describe('recordSegments', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['setInterval', 'clearInterval', 'Date'],
    })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  // Records with a microphone whose level a test sets, and notes when each
  // recording is handed over and what it holds.
  function record() {
    const { stream } = grantMicrophone()
    let level = SPEAKING
    const segments: { index: number; at: number; audio: Blob }[] = []
    const ended = vi.fn()
    const started = Date.now()
    const recorder = recordSegments({
      stream,
      segmentMs: SEGMENT_MS,
      level: () => level,
      onBegin: () => {},
      onSegment: (index, audio) => {
        segments.push({ index, at: Date.now() - started, audio })
      },
      onEnd: ended,
    })
    // Each recording handed over, with what it holds.
    const handedOver = () =>
      Promise.all(
        segments.map(async ({ index, at, audio }) => ({
          index,
          at,
          audio: await audio.text(),
        })),
      )
    return {
      recorder,
      handedOver,
      ended,
      setLevel: (value: number) => {
        level = value
      },
    }
  }

  it('ends a recording at the first pause after its length, never mid-word', async () => {
    const { handedOver, setLevel } = record()
    recording().hear('first ')
    // Still speaking when the recording reaches its length.
    await vi.advanceTimersByTimeAsync(SEGMENT_MS + 2_000)
    expect(await handedOver()).toEqual([])
    setLevel(0)
    await vi.advanceTimersByTimeAsync(DICTATION.PAUSE_MS + 100)
    expect(await handedOver()).toEqual([
      { index: 0, at: 12_600, audio: 'first ' },
    ])
    // The next recording was already running when the first stopped.
    expect(FakeMediaRecorder.recorders[0].overlapped).toBe(true)
    recording().hear('second')
    expect(FakeMediaRecorder.recorders).toHaveLength(2)
  })

  it('ends a recording with no pause in it at its longest', async () => {
    const { handedOver } = record()
    recording().hear('one long sentence')
    await vi.advanceTimersByTimeAsync(
      SEGMENT_MS * DICTATION.LONGEST_SEGMENT_FACTOR,
    )
    expect(await handedOver()).toEqual([
      {
        index: 0,
        at: SEGMENT_MS * DICTATION.LONGEST_SEGMENT_FACTOR,
        audio: 'one long sentence',
      },
    ])
  })

  it('hands over the last recording and ends when stopped', async () => {
    const { recorder, handedOver, ended, setLevel } = record()
    setLevel(0)
    recording().hear('only ')
    await vi.advanceTimersByTimeAsync(SEGMENT_MS + DICTATION.PAUSE_MS)
    recording().hear('then this')
    recorder.stop()
    await vi.waitFor(() => expect(ended).toHaveBeenCalledOnce())
    expect(
      (await handedOver()).map(({ index, audio }) => ({ index, audio })),
    ).toEqual([
      { index: 0, audio: 'only ' },
      { index: 1, audio: 'then this' },
    ])
    // Stopped recorders no longer cut the microphone into recordings.
    await vi.advanceTimersByTimeAsync(SEGMENT_MS * 2)
    expect(FakeMediaRecorder.recorders).toHaveLength(2)
  })
})
