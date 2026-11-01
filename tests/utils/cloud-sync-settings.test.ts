import { SETTINGS_CLOUD_SYNC_EXPLICITLY_DISABLED } from '@/constants/storage-keys'
import {
  isCloudSyncEnabled,
  recordCloudSyncPreference,
} from '@/utils/cloud-sync-settings'
import { describe, expect, it } from 'vitest'

describe('recordCloudSyncPreference', () => {
  it('clears the opt-out marker when sync is turned back on', () => {
    recordCloudSyncPreference(false)
    recordCloudSyncPreference(true)

    expect(isCloudSyncEnabled()).toBe(true)
    expect(
      localStorage.getItem(SETTINGS_CLOUD_SYNC_EXPLICITLY_DISABLED),
    ).toBeNull()
  })
})
