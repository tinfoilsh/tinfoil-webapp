// ---------------------------------------------------------------------------
// Removes localStorage keys that earlier clients wrote and nothing reads.
// ---------------------------------------------------------------------------

const RETIRED_LOCAL_STORAGE_KEYS = [
  'projectUploadPreference',
  'tinfoil-user-prefs-project-upload',
]

export function migrateStorageKeys(): void {
  if (typeof window === 'undefined') return

  try {
    for (const key of RETIRED_LOCAL_STORAGE_KEYS) {
      localStorage.removeItem(key)
    }
  } catch {
    // best-effort — don't break the app if storage is unavailable
  }
}
