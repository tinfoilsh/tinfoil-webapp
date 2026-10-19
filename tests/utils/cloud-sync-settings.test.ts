import {
  SETTINGS_CLOUD_SYNC_ENABLED,
  SETTINGS_CLOUD_SYNC_EXPLICITLY_DISABLED,
} from '@/constants/storage-keys'
import {
  CLOUD_SYNC_SETTING_CHANGED_EVENT,
  isCloudSyncEnabled,
  recordCloudSyncPreference,
} from '@/utils/cloud-sync-settings'
import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('recordCloudSyncPreference', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('marks an explicit opt-out so sign-in does not auto-enable sync', () => {
    const listener = vi.fn()
    window.addEventListener(CLOUD_SYNC_SETTING_CHANGED_EVENT, listener)

    recordCloudSyncPreference(false)

    expect(isCloudSyncEnabled()).toBe(false)
    expect(localStorage.getItem(SETTINGS_CLOUD_SYNC_ENABLED)).toBe('false')
    expect(localStorage.getItem(SETTINGS_CLOUD_SYNC_EXPLICITLY_DISABLED)).toBe(
      'true',
    )
    expect(listener).toHaveBeenCalledTimes(1)
    window.removeEventListener(CLOUD_SYNC_SETTING_CHANGED_EVENT, listener)
  })

  it('clears the opt-out marker when sync is turned back on', () => {
    recordCloudSyncPreference(false)
    recordCloudSyncPreference(true)

    expect(isCloudSyncEnabled()).toBe(true)
    expect(
      localStorage.getItem(SETTINGS_CLOUD_SYNC_EXPLICITLY_DISABLED),
    ).toBeNull()
  })
})
