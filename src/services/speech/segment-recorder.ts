import { DICTATION } from './constants'

export interface SegmentRecorder {
  // Ends the recording under way, which is handed over as the last one.
  stop(): void
}

interface SegmentRecorderOptions {
  stream: MediaStream
  segmentMs: number
  // The microphone's level now, from 0 to 1.
  level: () => number
  // A recording begins, numbered in the order they are made.
  onBegin: (index: number) => void
  onSegment: (index: number, audio: Blob) => void
  // The last recording was handed over, whether stop was called or the
  // microphone went away.
  onEnd: () => void
}

// Records a microphone as a series of recordings that each play on their
// own. A recording ends at the first pause after it has run segmentMs, or at
// its longest without one, and the next starts before it ends, so no sound
// falls between them.
export function recordSegments({
  stream,
  segmentMs,
  level,
  onBegin,
  onSegment,
  onEnd,
}: SegmentRecorderOptions): SegmentRecorder {
  let count = 0
  let stopped = false
  const begin = (): MediaRecorder => {
    const index = count++
    const recorder = new MediaRecorder(stream, {
      mimeType: DICTATION.MIME_TYPE,
      audioBitsPerSecond: DICTATION.BITS_PER_SECOND,
    })
    const chunks: Blob[] = []
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data)
    }
    recorder.onstop = () => {
      onSegment(index, new Blob(chunks, { type: DICTATION.MIME_TYPE }))
      if (recorder !== current) return
      stopped = true
      clearInterval(timer)
      onEnd()
    }
    recorder.start(DICTATION.TIMESLICE_MS)
    onBegin(index)
    return recorder
  }
  let current = begin()
  let startedAt = Date.now()
  let quietSince: number | undefined
  const timer = setInterval(() => {
    const now = Date.now()
    if (level() >= DICTATION.PAUSE_LEVEL) quietSince = undefined
    else quietSince ??= now
    const elapsed = now - startedAt
    const paused =
      quietSince !== undefined && now - quietSince >= DICTATION.PAUSE_MS
    if (
      (elapsed >= segmentMs && paused) ||
      elapsed >= segmentMs * DICTATION.LONGEST_SEGMENT_FACTOR
    ) {
      const ending = current
      current = begin()
      startedAt = now
      quietSince = undefined
      ending.stop()
    }
  }, DICTATION.LEVEL_SAMPLE_MS)
  return {
    stop() {
      if (stopped) return
      stopped = true
      clearInterval(timer)
      current.stop()
    },
  }
}
