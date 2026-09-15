import {
  AUTH_ACTIVE_USER_ID,
  USER_ENCRYPTION_KEY,
} from '@/constants/storage-keys'
import { getView, harnessAPI, publish } from '@/services/harness/runtime'
import {
  performSignoutCleanup,
  performUserSwitchCleanup,
} from '@/utils/signout-cleanup'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, expect, it, vi } from 'vitest'
vi.mock('@/utils/error-handling', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
}))
beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  sessionStorage.clear()
})
it('aborts the old harness and removes account data on account switch', async () => {
  const api = harnessAPI()
  publish({ profile: { nickname: 'Private' } })
  localStorage.setItem(AUTH_ACTIVE_USER_ID, 'alice')
  localStorage.setItem(USER_ENCRYPTION_KEY, 'key_private')
  sessionStorage.setItem('harness-run:alice', 'routing')
  await performUserSwitchCleanup('bob')
  expect(api.lifetime.signal.aborted).toBe(true)
  expect(getView().profile).toEqual({})
  expect(localStorage.getItem(USER_ENCRYPTION_KEY)).toBeNull()
  expect(sessionStorage.length).toBe(0)
})
it('keeps a manually held encryption key when the signout flow requests it', async () => {
  localStorage.setItem(USER_ENCRYPTION_KEY, 'key_private')
  await performSignoutCleanup({ preserveEncryptionKey: true })
  expect(localStorage.getItem(USER_ENCRYPTION_KEY)).toBe('key_private')
})
