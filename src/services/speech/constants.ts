export const SPEECH = {
  // The harness streams a reply's audio as raw PCM: mono, signed 16-bit
  // little-endian.
  SAMPLE_RATE: 24000,
  CHANNELS: 1,
  PCM_SCALE: 32768,
  BLOCK_SAMPLES: 6000,
  START_BUFFER_SECONDS: 12,
  SCHEDULE_LEAD_SECONDS: 0.05,
  // The stream is not read further while this much audio waits to play.
  MAX_BUFFERED_SECONDS: 30,
  // A response that sends nothing for this long has stalled.
  IDLE_TIMEOUT_MS: 60_000,
} as const

export const DICTATION = {
  MIME_TYPE: 'audio/webm',
  FILE_NAME: 'audio.webm',
  SAMPLE_RATE: 44100,
  CHANNELS: 1,
  BITS_PER_SECOND: 128_000,
  // How often a recording hands over what it has captured.
  TIMESLICE_MS: 1000,
  // How often the microphone's level is read to find a pause.
  LEVEL_SAMPLE_MS: 100,
  // A level below PAUSE_LEVEL held for PAUSE_MS is a pause between words.
  PAUSE_LEVEL: 0.02,
  PAUSE_MS: 500,
  // A recording with no pause in it ends at this many times its length.
  LONGEST_SEGMENT_FACTOR: 1.5,
  // The waits before each attempt after a recording failed to transcribe,
  // after which it waits for the user.
  RETRY_DELAYS_MS: [2_000, 5_000, 15_000, 30_000, 60_000, 120_000, 300_000],
  // An attempt not answered by then is abandoned. A recording transcribes
  // in seconds.
  ATTEMPT_TIMEOUT_MS: 60_000,
} as const
