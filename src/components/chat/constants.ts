export const CONSTANTS = {
  MOBILE_BREAKPOINT: 768,
  // Welcome-screen composer: one comfortable line of text before it grows.
  WELCOME_INPUT_MIN_HEIGHT: '36px',
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
  // Live recording waveform: a new amplitude bar is appended at this rate
  // and the strip scrolls left by one bar each time.
  RECORDING_WAVEFORM_SAMPLE_INTERVAL_MS: 50,
  RECORDING_WAVEFORM_BAR_WIDTH_PX: 2,
  RECORDING_WAVEFORM_BAR_GAP_PX: 2,
  RECORDING_WAVEFORM_HEIGHT_PX: 28,
  // Bars never shrink below this so silence still reads as a flat line.
  RECORDING_WAVEFORM_MIN_BAR_HEIGHT_PX: 2,
  // Typical speech peaks well below full scale; amplitudes are scaled by this
  // factor so a normal speaking voice fills most of the strip height.
  RECORDING_WAVEFORM_GAIN: 3,
  // Smaller FFT sizes give lower-latency time-domain samples for the meter.
  RECORDING_WAVEFORM_FFT_SIZE: 512,
  // Copy button timeout in milliseconds (2 seconds)
  COPY_TIMEOUT_MS: 2000,
  // Gap between a message's overflow menu trigger and the dropdown
  OVERFLOW_MENU_OFFSET_PX: 4,
  // Minimum distance kept between an overflow menu and the viewport edges
  OVERFLOW_MENU_VIEWPORT_MARGIN_PX: 8,
  // Maximum width for table columns in pixels
  TABLE_COLUMN_MAX_WIDTH_PX: 300,
  // Sidebar widths
  CHAT_SIDEBAR_WIDTH_PX: 300,
  CHAT_SIDEBAR_COLLAPSED_WIDTH_PX: 48,
  MOBILE_SIDEBAR_WIDTH: '85vw',
  // Sidebar geometry and the adjacent chat area share one transition.
  SIDEBAR_LAYOUT_TRANSITION_CLASS_NAME:
    'transition-[transform,left,right] duration-200 ease-in-out motion-reduce:transition-none',
  // How long the dimmed "forking" overlay stays up after the fork lands
  // so a fast fork still reads as an action instead of a flicker.
  FORK_OVERLAY_MIN_VISIBLE_MS: 600,
  // Grace period before a hover-opened account menu closes once the pointer
  // leaves it, so brushing past the gap between trigger and panel doesn't
  // dismiss it.
  SIDEBAR_MENU_HOVER_CLOSE_DELAY_MS: 400,
  // How far outside the trigger/panel the pointer may wander before the
  // hover-opened account menu starts its close countdown.
  SIDEBAR_MENU_HOVER_TOLERANCE_PX: 48,
  // Recent chats listed in the search modal before a term is typed.
  SEARCH_RECENT_CHAT_COUNT: 8,
  // Height of a pinned sidebar section header (Projects/Chats). The Chats
  // header offsets by this amount so it stacks below the pinned Projects
  // header while scrolling.
  SIDEBAR_PINNED_HEADER_OFFSET_PX: 44,
  // Vertical gap between floating sidebar section cards (matches mt-2).
  SIDEBAR_SECTION_GAP_PX: 8,
  // Duration of a sidebar section expand/collapse animation (seconds),
  // shared by the Projects and Chats height animations.
  SIDEBAR_SECTION_ANIMATION_S: 0.2,
  // How long the sidebar scrollbar stays hidden while sections animate.
  // Slightly longer than the animation so the scrollbar reappears only
  // once the scroll height has settled, instead of flickering as it
  // changes mid-animation.
  SIDEBAR_SECTION_SCROLLBAR_HIDE_MS: 300,
  SETTINGS_SIDEBAR_WIDTH_PX: 345,
  VERIFIER_SIDEBAR_WIDTH_PX: 345,
  ASK_SIDEBAR_WIDTH_PX: 420,
  ARTIFACT_SIDEBAR_WIDTH_PX: 420,
  ARTIFACT_SIDEBAR_MIN_WIDTH_PX: 360,
  ARTIFACT_SIDEBAR_MAX_WIDTH_PX: 840,
  ARTIFACT_SIDEBAR_RESIZE_STEP_PX: 40,
  // Placeholder for the input before a conversation has started
  INPUT_PLACEHOLDER: 'How can I help you today?',
  // Placeholder once a conversation has started
  REPLY_PLACEHOLDER: 'Reply to Al...',
  // Base document title used when no chat title is meaningful
  BASE_DOCUMENT_TITLE: 'Tinfoil Chat',
  // Row bounds for the in-place message edit textarea
  EDIT_TEXTAREA_MIN_ROWS: 3,
  EDIT_TEXTAREA_MAX_ROWS: 10,
} as const
