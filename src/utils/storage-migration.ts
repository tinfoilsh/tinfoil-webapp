// ---------------------------------------------------------------------------
// One-time migration of localStorage/sessionStorage keys from legacy names
// to the new standardized dash-case names with semantic prefixes.
// ---------------------------------------------------------------------------

const MIGRATION_FLAG = 'tinfoil-storage-migrated'
const RETIRED_LOCAL_STORAGE_KEYS = [
  'projectUploadPreference',
  'tinfoil-user-prefs-project-upload',
]

const LOCAL_STORAGE_KEY_MAP: Record<string, string> = {
  // Sensitive
  'tinfoil-encryption-key': 'tinfoil-user-personal-encryption-key',
  'tinfoil-encryption-key-history':
    'tinfoil-user-personal-encryption-key-history',
  'tinfoil-passkey-prf-cache': 'tinfoil-secret-passkey-prf-output',
  'tinfoil-passkey-backed-up': 'tinfoil-secret-passkey-backed-up',

  // Auth
  'tinfoil-active-user-id': 'tinfoil-auth-active-user-id',
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

export function migrateStorageKeys(): void {
  if (typeof window === 'undefined') return

  try {
    for (const key of RETIRED_LOCAL_STORAGE_KEYS) {
      localStorage.removeItem(key)
    }

    if (localStorage.getItem(MIGRATION_FLAG) === 'true') return

    migrateStorage(localStorage, LOCAL_STORAGE_KEY_MAP)

    localStorage.setItem(MIGRATION_FLAG, 'true')
  } catch {
    // best-effort — don't break the app if storage is unavailable
  }
}
