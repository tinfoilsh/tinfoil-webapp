import { migrateStorageKeys } from '@/utils/storage-migration'
import { beforeEach, describe, expect, it } from 'vitest'

describe('migrateStorageKeys', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
  })

  it('removes retired project upload preferences for migrated users', () => {
    localStorage.setItem('tinfoil-storage-migrated', 'true')
    localStorage.setItem('projectUploadPreference', 'project')
    localStorage.setItem('tinfoil-user-prefs-project-upload', 'project')
    localStorage.setItem('unrelated-preference', 'keep')

    migrateStorageKeys()

    expect(localStorage.getItem('projectUploadPreference')).toBeNull()
    expect(localStorage.getItem('tinfoil-user-prefs-project-upload')).toBeNull()
    expect(localStorage.getItem('unrelated-preference')).toBe('keep')
  })
})
