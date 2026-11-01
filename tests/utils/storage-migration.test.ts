import { loadLocalProfile } from '@/services/harness/local-profile'
import {
  enableCloudSyncForExistingKey,
  isCloudSyncEnabled,
} from '@/utils/cloud-sync-settings'
import { migrateStorageKeys } from '@/utils/storage-migration'
import { expect, it } from 'vitest'

it('keeps the settings a browser stored under their old names', () => {
  localStorage.setItem('tinfoil-encryption-key', 'key_old')
  localStorage.setItem('cloudSyncEnabled', 'false')
  localStorage.setItem('cloudSyncExplicitlyDisabled', 'true')
  localStorage.setItem('themeMode', 'dark')
  localStorage.setItem('userNickname', 'Ada')
  sessionStorage.setItem('sidebarOpen', 'true')

  migrateStorageKeys()
  enableCloudSyncForExistingKey()

  expect(isCloudSyncEnabled()).toBe(false)
  expect(loadLocalProfile()).toMatchObject({
    themeMode: 'dark',
    nickname: 'Ada',
  })
  expect(sessionStorage.getItem('tinfoil-ui-sidebar-open')).toBe('true')
  expect(localStorage.getItem('themeMode')).toBeNull()
})

it('removes retired project upload preferences', () => {
  localStorage.setItem('projectUploadPreference', 'ask')
  localStorage.setItem('tinfoil-user-prefs-project-upload', 'always')

  migrateStorageKeys()

  expect(localStorage.getItem('projectUploadPreference')).toBeNull()
  expect(localStorage.getItem('tinfoil-user-prefs-project-upload')).toBeNull()
})
