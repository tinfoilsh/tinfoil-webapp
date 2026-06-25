export const CONSTANTS = {
  LOADING_TIMEOUT: 500,
  MOBILE_BREAKPOINT: 768,
  INPUT_MIN_HEIGHT: '28px',
  // Maximum height of the chat input textarea before it scrolls internally
  INPUT_MAX_HEIGHT_PX: 240,
  // Fallback estimate of the input card chrome height (paddings, toolbar row,
  // send button) used when the input area wrapper cannot be measured
  INPUT_VIEWPORT_RESERVED_PX: 160,
  // Minimum breathing room kept above the input area within the visual
  // viewport so it never covers the entire screen above the keyboard
  INPUT_VIEWPORT_TOP_GAP_PX: 24,
  CHAT_INPUT_BOTTOM_GAP_PX: 32,
  CHAT_INPUT_FADE_HEIGHT_PX: 80,
  CHAT_INPUT_FADE_SOLID_AT_PX: 72,
  SINGLE_SIDEBAR_BREAKPOINT: 1024, // Below this width, only one sidebar can be open at a time
  MAX_MESSAGES: 100,
  MAX_MESSAGE_LENGTH: 4000,
  MAX_DOCUMENT_SIZE_MB: 32, // Display value for error messages
  MAX_DOCUMENT_SIZE_BYTES: 33 * 1024 * 1024, // Actual limit: 33MB to tolerate ~32.5MB files
  // Generous safety cap for plain-text files, which are validated against the
  // model's context window by token estimate rather than by byte size
  MAX_TEXT_DOCUMENT_SIZE_MB: 50,
  MAX_TEXT_DOCUMENT_SIZE_BYTES: 50 * 1024 * 1024,
  // Voice recording timeout in milliseconds (10 minutes)
  RECORDING_TIMEOUT_MS: 600000,
  // Default audio model for voice transcription
  DEFAULT_AUDIO_MODEL: 'voxtral-small-24b',
  // Copy button timeout in milliseconds (2 seconds)
  COPY_TIMEOUT_MS: 2000,
  // Maximum width for table columns in pixels
  TABLE_COLUMN_MAX_WIDTH_PX: 300,
  // Chat initialization delay in milliseconds
  CHAT_INIT_DELAY_MS: 300,
  // State update delay for async operations
  ASYNC_STATE_DELAY_MS: 50,
  // Coalesce streaming UI updates to at most one render per this interval.
  // Fast models emit content faster than the screen refreshes, so batching the
  // flushes avoids re-parsing markdown on every network chunk while staying
  // well above the threshold where streaming stops looking smooth (~30fps).
  STREAM_FLUSH_INTERVAL_MS: 33,
  // Sidebar widths
  CHAT_SIDEBAR_WIDTH_PX: 300,
  CHAT_SIDEBAR_COLLAPSED_WIDTH_PX: 48,
  // Duration of the expanded sidebar slide in/out (seconds)
  CHAT_SIDEBAR_SLIDE_DURATION_S: 0.2,
  // Collapsed rail fade timings (seconds). The fade-in waits for the expanded
  // sidebar to finish sliding away so the two appear to swap rather than
  // overlap.
  CHAT_SIDEBAR_RAIL_FADE_IN_DURATION_S: 0.15,
  CHAT_SIDEBAR_RAIL_FADE_OUT_DURATION_S: 0.1,
  SETTINGS_SIDEBAR_WIDTH_PX: 345,
  VERIFIER_SIDEBAR_WIDTH_PX: 345,
  ASK_SIDEBAR_WIDTH_PX: 420,
  ARTIFACT_SIDEBAR_WIDTH_PX: 420,
  ARTIFACT_SIDEBAR_MIN_WIDTH_PX: 360,
  ARTIFACT_SIDEBAR_MAX_WIDTH_PX: 840,
  ARTIFACT_SIDEBAR_RESIZE_STEP_PX: 40,
  // Long text paste threshold (characters) - texts longer than this will be converted to .txt file
  LONG_PASTE_THRESHOLD: 3000,
  // Title generation settings
  TITLE_GENERATION_WORD_THRESHOLD: 100, // Words needed to trigger early title generation during streaming
  // Document processing timeout in milliseconds (10 minutes)
  DOCUMENT_PROCESSING_TIMEOUT_MS: 600000,
  // Retry settings
  VERIFICATION_MAX_RETRIES: 5,
  VERIFICATION_RETRY_DELAY_MS: 2000, // Base delay between retries (exponential backoff)
  MESSAGE_SEND_MAX_RETRIES: 6,
  MESSAGE_SEND_RETRY_DELAY_MS: 1000, // Base delay between retries (exponential backoff)
  // Placeholder messages for empty chat input
  INPUT_PLACEHOLDERS: [
    "What's on your mind?",
    'Ask me anything...',
    'How can I help you today?',
    'Your secrets are safe here...',
  ],
  // Base document title used when no chat title is meaningful
  BASE_DOCUMENT_TITLE: 'Tinfoil Private Chat',
} as const
