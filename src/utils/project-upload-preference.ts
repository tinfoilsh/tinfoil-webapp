import { USER_PREFS_PROJECT_UPLOAD } from '@/constants/storage-keys'

export type ProjectUploadPreference = 'project' | 'chat'

export function getProjectUploadPreference(): ProjectUploadPreference | null {
  if (typeof window === 'undefined') return null
  try {
    const value = localStorage.getItem(USER_PREFS_PROJECT_UPLOAD)
    if (value === 'project' || value === 'chat') {
      return value
    }
    return null
  } catch {
    return null
  }
}

export function setProjectUploadPreference(
  preference: ProjectUploadPreference,
): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(USER_PREFS_PROJECT_UPLOAD, preference)
    window.dispatchEvent(
      new CustomEvent('projectUploadPreferenceChanged', {
        detail: preference,
      }),
    )
  } catch {
    // Storage unavailable (e.g., Safari private mode) - silently fail
  }
}

export function clearProjectUploadPreference(): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.removeItem(USER_PREFS_PROJECT_UPLOAD)
    window.dispatchEvent(
      new CustomEvent('projectUploadPreferenceChanged', {
        detail: null,
      }),
    )
  } catch {
    // Storage unavailable - silently fail
  }
}
