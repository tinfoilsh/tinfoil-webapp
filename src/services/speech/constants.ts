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
  IDLE_TIMEOUT_MS: 30_000,
} as const
