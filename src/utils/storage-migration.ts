// ---------------------------------------------------------------------------
// One-time migration of localStorage/sessionStorage keys from legacy names
// to the new standardized dash-case names with semantic prefixes.
// ---------------------------------------------------------------------------

const MIGRATION_FLAG = 'tinfoil-storage-migrated'

const LOCAL_STORAGE_KEY_MAP: Record<string, string> = {
  // Sensitive
  'tinfoil-encryption-key': 'tinfoil-user-personal-encryption-key',
  'tinfoil-encryption-key-history':
    'tinfoil-user-personal-encryption-key-history',
  'tinfoil-passkey-prf-cache': 'tinfoil-secret-passkey-prf-output',
  'tinfoil-passkey-backed-up': 'tinfoil-secret-passkey-backed-up',

  // Auth
  'tinfoil-active-user-id': 'tinfoil-auth-active-user-id',

  // Settings
  cloudSyncEnabled: 'tinfoil-settings-cloud-sync-enabled',
  cloudSyncExplicitlyDisabled:
    'tinfoil-settings-cloud-sync-explicitly-disabled',
  hasSeenCloudSyncModal: 'tinfoil-settings-has-seen-cloud-sync-modal',
  selectedModel: 'tinfoil-settings-selected-model',
  reasoningEffort: 'tinfoil-settings-reasoning-effort',
  webSearchEnabled: 'tinfoil-settings-web-search-enabled',
  piiCheckEnabled: 'tinfoil-settings-pii-check-enabled',
  themeMode: 'tinfoil-settings-theme-mode',
  theme: 'tinfoil-settings-theme',
  chatFont: 'tinfoil-settings-chat-font',
  has_seen_web_search_intro: 'tinfoil-settings-has-seen-web-search-intro',
  cached_subscription_status: 'tinfoil-settings-cached-subscription-status',
  enableDebugLogs: 'tinfoil-dev-enable-debug-logs',

  // User preferences
  userNickname: 'tinfoil-user-prefs-nickname',
  userProfession: 'tinfoil-user-prefs-profession',
  userTraits: 'tinfoil-user-prefs-traits',
  userAdditionalContext: 'tinfoil-user-prefs-additional-context',
  userLanguage: 'tinfoil-user-prefs-language',
  isUsingPersonalization: 'tinfoil-user-prefs-personalization-enabled',
  isUsingCustomPrompt: 'tinfoil-user-prefs-custom-prompt-enabled',
  customSystemPrompt: 'tinfoil-user-prefs-custom-system-prompt',
  projectUploadPreference: 'tinfoil-user-prefs-project-upload',

  // Sync/data
  chats: 'tinfoil-sync-chats',
  'tinfoil-chat-sync-status': 'tinfoil-sync-chat-status',
  'tinfoil-all-chats-sync-status': 'tinfoil-sync-all-chats-status',
  'tinfoil-profile-sync-status': 'tinfoil-sync-profile-status',
}

const SESSION_STORAGE_KEY_MAP: Record<string, string> = {
  tinfoil_session_chats: 'tinfoil-sync-session-chats',
  'tinfoil-deleted-chats': 'tinfoil-sync-deleted-chats',
  sidebarOpen: 'tinfoil-ui-sidebar-open',
  chatSidebarActiveTab: 'tinfoil-ui-sidebar-active-tab',
  sidebarProjectsExpanded: 'tinfoil-ui-sidebar-projects-expanded',
  sidebarChatHistoryExpanded: 'tinfoil-ui-sidebar-chat-history-expanded',
  sidebarExpandSection: 'tinfoil-ui-sidebar-expand-section',
  expandProjectsOnMount: 'tinfoil-ui-expand-projects-on-mount',
  expandProjectDocuments: 'tinfoil-ui-expand-project-documents',
}

const LOCAL_STORAGE_PREFIX_MAP: Record<string, string> = {
  'tinfoil-project-chat-sync-status-': 'tinfoil-sync-project-chat-status-',
}

function migrateStorage(
  storage: Storage,
  keyMap: Record<string, string>,
): void {
  for (const [oldKey, newKey] of Object.entries(keyMap)) {
    const value = storage.getItem(oldKey)
    if (value !== null && storage.getItem(newKey) === null) {
      storage.setItem(newKey, value)
    }
    if (value !== null) {
      storage.removeItem(oldKey)
    }
  }
}

function migratePrefixedKeys(
  storage: Storage,
  prefixMap: Record<string, string>,
): void {
  for (const [oldPrefix, newPrefix] of Object.entries(prefixMap)) {
    const keysToMigrate: string[] = []
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i)
      if (key?.startsWith(oldPrefix)) {
        keysToMigrate.push(key)
      }
    }
    for (const oldKey of keysToMigrate) {
      const suffix = oldKey.slice(oldPrefix.length)
      const newKey = newPrefix + suffix
      const value = storage.getItem(oldKey)
      if (value !== null && storage.getItem(newKey) === null) {
        storage.setItem(newKey, value)
      }
      if (value !== null) {
        storage.removeItem(oldKey)
      }
    }
  }
}

export function migrateStorageKeys(): void {
  if (typeof window === 'undefined') return

  try {
    if (localStorage.getItem(MIGRATION_FLAG) === 'true') return

    migrateStorage(localStorage, LOCAL_STORAGE_KEY_MAP)
    migratePrefixedKeys(localStorage, LOCAL_STORAGE_PREFIX_MAP)
    migrateStorage(sessionStorage, SESSION_STORAGE_KEY_MAP)

    localStorage.setItem(MIGRATION_FLAG, 'true')
  } catch {
    // best-effort — don't break the app if storage is unavailable
  }
}
