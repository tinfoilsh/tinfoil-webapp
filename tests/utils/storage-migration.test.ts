import { migrateStorageKeys } from '@/utils/storage-migration'
import { expect, it } from 'vitest'

it('removes retired project upload preferences', () => {
  localStorage.setItem('projectUploadPreference', 'ask')
  localStorage.setItem('tinfoil-user-prefs-project-upload', 'always')

  migrateStorageKeys()

  expect(localStorage.getItem('projectUploadPreference')).toBeNull()
  expect(localStorage.getItem('tinfoil-user-prefs-project-upload')).toBeNull()
})
