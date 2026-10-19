import {
  SETTINGS_CLOUD_SYNC_ENABLED,
  SETTINGS_CLOUD_SYNC_EXPLICITLY_DISABLED,
  SETTINGS_LOCAL_ONLY_MODE_ENABLED,
} from '@/constants/storage-keys'

export const CLOUD_SYNC_SETTING_CHANGED_EVENT = 'cloudSyncSettingChanged'

/**
 * Record a user's explicit choice to turn cloud sync on or off. The
 * explicit-disable marker stops the sign-in path from auto-enabling
 * sync for an account that has an encryption key but opted out.
 */
export function recordCloudSyncPreference(enabled: boolean): void {
  if (typeof window === 'undefined') return
  try {
    if (enabled) {
      localStorage.removeItem(SETTINGS_CLOUD_SYNC_EXPLICITLY_DISABLED)
    } else {
      localStorage.setItem(SETTINGS_CLOUD_SYNC_EXPLICITLY_DISABLED, 'true')
    }
  } catch {
    // Storage unavailable (e.g., Safari private mode) - silently fail
  }
  setCloudSyncEnabled(enabled)
}

export function isCloudSyncEnabled(): boolean {
  if (typeof window === 'undefined') return false
  try {
    const setting =
      localStorage.getItem(SETTINGS_CLOUD_SYNC_ENABLED) ??
      localStorage.getItem('cloudSyncEnabled')
    return setting === 'true'
  } catch {
    return false
  }
}

export function setCloudSyncEnabled(enabled: boolean): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(SETTINGS_CLOUD_SYNC_ENABLED, enabled.toString())
    // Dispatch event to notify listeners of the change
    window.dispatchEvent(new Event(CLOUD_SYNC_SETTING_CHANGED_EVENT))
  } catch {
    // Storage unavailable (e.g., Safari private mode) - silently fail
  }
}

export function isLocalOnlyModeEnabled(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return localStorage.getItem(SETTINGS_LOCAL_ONLY_MODE_ENABLED) === 'true'
  } catch {
    return false
  }
}

export function setLocalOnlyModeEnabled(enabled: boolean): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(SETTINGS_LOCAL_ONLY_MODE_ENABLED, enabled.toString())
    window.dispatchEvent(new Event('localOnlyModeChanged'))
  } catch {
    // Storage unavailable (e.g., Safari private mode) - silently fail
  }
}

/**
 * Returns true if the user has explicitly set the local-only mode
 * preference (i.e. the key exists in localStorage).
 */
export function hasUserSetLocalOnlyPreference(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return localStorage.getItem(SETTINGS_LOCAL_ONLY_MODE_ENABLED) !== null
  } catch {
    return false
  }
}
