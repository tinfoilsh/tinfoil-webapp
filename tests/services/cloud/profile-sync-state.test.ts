import {
  clearProfileSyncState,
  loadLocalProfileMetadata,
  loadProfileBaseline,
  saveLocalProfileMetadata,
  saveProfileBaseline,
} from '@/services/cloud/profile-sync-state'
import { beforeEach, describe, expect, it } from 'vitest'

describe('profile sync state', () => {
  beforeEach(() => {
    clearProfileSyncState()
  })

  it('persists the merge baseline separately from local metadata', () => {
    saveProfileBaseline('user-1', { nickname: 'Remote', version: 7 })
    saveLocalProfileMetadata('user-1', {
      nickname: 'Local',
      version: 7,
      fieldClocks: { nickname: { v: 2, w: 'device' } },
      clockVersion: 7,
    })

    expect(loadProfileBaseline('user-1')).toMatchObject({
      nickname: 'Remote',
      version: 7,
    })
    expect(loadLocalProfileMetadata('user-1')).toMatchObject({
      nickname: 'Local',
      fieldClocks: { nickname: { v: 2, w: 'device' } },
    })
  })

  it('does not load another account’s baseline', () => {
    saveProfileBaseline('user-1', { nickname: 'Private', version: 3 })

    expect(loadProfileBaseline('user-2')).toBeNull()
  })
})
