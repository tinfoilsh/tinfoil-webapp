// ---------------------------------------------------------------------------
// Centralized storage key constants for localStorage and sessionStorage.
// All keys use lowercase dash-case with a semantic prefix.
// ---------------------------------------------------------------------------

// --- localStorage: Sensitive values (encryption keys, passkey data) --------
export const USER_ENCRYPTION_KEY = 'tinfoil-user-personal-encryption-key'
export const USER_ENCRYPTION_KEY_HISTORY =
  'tinfoil-user-personal-encryption-key-history'
export const LEGACY_ENCRYPTION_KEY = 'tinfoil-encryption-key'
export const LEGACY_ENCRYPTION_KEY_HISTORY = 'tinfoil-encryption-key-history'
export const SECRET_PASSKEY_PRF_OUTPUT = 'tinfoil-secret-passkey-prf-output'
export const SECRET_PASSKEY_BACKED_UP = 'tinfoil-secret-passkey-backed-up'
export const PASSKEY_SYNC_VERSION = 'tinfoil-passkey-sync-version'
export const PASSKEY_BUNDLE_VERSION = 'tinfoil-passkey-bundle-version'
export const SECRET_CLOUD_KEY_AUTHORIZATION_PREFIX =
  'tinfoil-secret-cloud-key-authorization-'

// --- localStorage: Auth ----------------------------------------------------
export const AUTH_ACTIVE_USER_ID = 'tinfoil-auth-active-user-id'

// --- localStorage: App settings --------------------------------------------
export const SETTINGS_CLOUD_SYNC_ENABLED = 'tinfoil-settings-cloud-sync-enabled'
export const SETTINGS_CLOUD_SYNC_EXPLICITLY_DISABLED =
  'tinfoil-settings-cloud-sync-explicitly-disabled'
export const SETTINGS_HAS_SEEN_CLOUD_SYNC_MODAL =
  'tinfoil-settings-has-seen-cloud-sync-modal'
export const SETTINGS_SELECTED_MODEL = 'tinfoil-settings-selected-model'
export const SETTINGS_REASONING_EFFORT = 'tinfoil-settings-reasoning-effort'
export const SETTINGS_THINKING_ENABLED = 'tinfoil-settings-thinking-enabled'
export const SETTINGS_MAX_PROMPT_MESSAGES =
  'tinfoil-settings-max-prompt-messages'
export const SETTINGS_WEB_SEARCH_ENABLED = 'tinfoil-settings-web-search-enabled'
export const SETTINGS_CODE_EXECUTION_ENABLED =
  'tinfoil-settings-code-execution-enabled'
export const SETTINGS_PII_CHECK_ENABLED = 'tinfoil-settings-pii-check-enabled'
export const SETTINGS_THEME_MODE = 'tinfoil-settings-theme-mode'
export const SETTINGS_THEME = 'tinfoil-settings-theme'
export const SETTINGS_CHAT_FONT = 'tinfoil-settings-chat-font'
export const SETTINGS_CACHED_SUBSCRIPTION_STATUS =
  'tinfoil-settings-cached-subscription-status'
export const SETTINGS_HAS_SEEN_WEB_SEARCH_INTRO =
  'tinfoil-settings-has-seen-web-search-intro'
export const SETTINGS_LOCAL_ONLY_MODE_ENABLED =
  'tinfoil-settings-local-only-mode-enabled'
// Persists across sessions: set when the user explicitly dismisses the
// recovery / setup-failed warning after a cancelled passkey recovery attempt.
// While set, the recovery modal is not auto-opened on page load so the user
// isn't pestered on every reload. Cleared when they successfully unlock via
// passkey or manual backup.
export const SETTINGS_PASSKEY_RECOVERY_DISMISSED =
  'tinfoil-settings-passkey-recovery-dismissed'
// Persists across sessions: set when the brand-new-user first-time setup
// prompt was dismissed via "Not Now". While set, the prompt is not
// auto-opened on page load so the user isn't pestered on every new tab.
// Cleared automatically when the user signs in as a different user, or
// when they explicitly re-enable cloud sync from settings.
export const SETTINGS_PASSKEY_FIRST_TIME_PROMPT_DISMISSED =
  'tinfoil-settings-passkey-first-time-prompt-dismissed'
// Persists across sessions: set when the user dismisses the
// "Unlock Your Chats" / manual-recovery warning while in a state where there
// is no passkey credential to retry against (e.g. orphan remote data left
// over from a pre-account session). While set, the manual-recovery prompt
// is not auto-opened on page load. Cleared automatically when the user
// successfully recovers a key, signs in as a different user, or explicitly
// re-enables cloud sync from settings.
export const SETTINGS_MANUAL_RECOVERY_DISMISSED =
  'tinfoil-settings-manual-recovery-dismissed'
// Persists across sessions: set when the user dismisses the sidebar
// "your chats aren't being backed up" warning. Cleared automatically when
// the underlying state clears (passkey backup is set up, key is recovered,
// or the user signs in as a different user) so the warning can resurface
// for genuinely new warning conditions later.
export const SETTINGS_BACKUP_WARNING_DISMISSED =
  'tinfoil-settings-backup-warning-dismissed'

// --- sessionStorage: Passkey setup failure ---------------------------------
// Tracks whether the user has dismissed the "passkey backup failed" warning
// during the current session so we don't re-prompt on every re-init.
export const SETTINGS_PASSKEY_SETUP_WARNING_DISMISSED =
  'tinfoil-settings-passkey-setup-warning-dismissed'

// --- localStorage: User personalization preferences ------------------------
export const USER_PREFS_NICKNAME = 'tinfoil-user-prefs-nickname'
export const USER_PREFS_PROFESSION = 'tinfoil-user-prefs-profession'
export const USER_PREFS_TRAITS = 'tinfoil-user-prefs-traits'
export const USER_PREFS_ADDITIONAL_CONTEXT =
  'tinfoil-user-prefs-additional-context'
export const USER_PREFS_LANGUAGE = 'tinfoil-user-prefs-language'
export const USER_PREFS_PERSONALIZATION_ENABLED =
  'tinfoil-user-prefs-personalization-enabled'
export const USER_PREFS_CUSTOM_PROMPT_ENABLED =
  'tinfoil-user-prefs-custom-prompt-enabled'
export const USER_PREFS_CUSTOM_SYSTEM_PROMPT =
  'tinfoil-user-prefs-custom-system-prompt'
export const USER_PREFS_CUSTOM_PROMPT_PRESETS =
  'tinfoil-user-prefs-custom-prompt-presets'
export const USER_PREFS_PROJECT_UPLOAD = 'tinfoil-user-prefs-project-upload'

// --- localStorage: Sync/data state -----------------------------------------
export const SYNC_CHATS = 'tinfoil-sync-chats'
export const SYNC_CHAT_STATUS = 'tinfoil-sync-chat-status'
export const SYNC_ALL_CHATS_STATUS = 'tinfoil-sync-all-chats-status'
export const SYNC_PROJECT_CHAT_STATUS_PREFIX =
  'tinfoil-sync-project-chat-status-'
export const SYNC_PROFILE_STATUS = 'tinfoil-sync-profile-status'
export const SYNC_PROFILE_DIRTY = 'tinfoil-sync-profile-dirty'

// --- localStorage: Development ---------------------------------------------
export const DEV_ENABLE_DEBUG_LOGS = 'tinfoil-dev-enable-debug-logs'

// --- sessionStorage: UI state ----------------------------------------------
export const UI_SIDEBAR_OPEN = 'tinfoil-ui-sidebar-open'
export const UI_SIDEBAR_ACTIVE_TAB = 'tinfoil-ui-sidebar-active-tab'
export const UI_SIDEBAR_PROJECTS_EXPANDED =
  'tinfoil-ui-sidebar-projects-expanded'
export const UI_SIDEBAR_CHAT_HISTORY_EXPANDED =
  'tinfoil-ui-sidebar-chat-history-expanded'
export const UI_SIDEBAR_EXPAND_SECTION = 'tinfoil-ui-sidebar-expand-section'
export const UI_EXPAND_PROJECTS_ON_MOUNT = 'tinfoil-ui-expand-projects-on-mount'
export const UI_EXPAND_PROJECT_DOCUMENTS = 'tinfoil-ui-expand-project-documents'

// --- sessionStorage: Sync --------------------------------------------------
export const SYNC_SESSION_CHATS = 'tinfoil-sync-session-chats'
export const SYNC_DELETED_CHATS = 'tinfoil-sync-deleted-chats'

// --- sessionStorage: Message queue -----------------------------------------
export const MESSAGE_QUEUE_PREFIX = 'tinfoil-message-queue:'
