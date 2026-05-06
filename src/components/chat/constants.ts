export const CONSTANTS = {
  LOADING_TIMEOUT: 500,
  MOBILE_BREAKPOINT: 768,
  INPUT_MIN_HEIGHT: '28px',
  SINGLE_SIDEBAR_BREAKPOINT: 1024, // Below this width, only one sidebar can be open at a time
  MAX_MESSAGES: 100,
  MAX_MESSAGE_LENGTH: 4000,
  MAX_DOCUMENT_SIZE_MB: 10, // Display value for error messages
  MAX_DOCUMENT_SIZE_BYTES: 11 * 1024 * 1024, // Actual limit: 11MB to tolerate ~10.5MB files
  // Maximum number of messages to include in the context window (user can override in settings)
  MAX_PROMPT_MESSAGES: 75,
  MAX_PROMPT_MESSAGES_LIMIT: 200,
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
  // Sidebar widths
  CHAT_SIDEBAR_WIDTH_PX: 300,
  CHAT_SIDEBAR_COLLAPSED_WIDTH_PX: 48,
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
} as const
