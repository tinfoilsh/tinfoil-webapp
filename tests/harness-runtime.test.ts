import type { HarnessClient } from '@/services/harness/client'
import {
  activateAPI,
  getView,
  HarnessAPI,
  publish,
} from '@/services/harness/runtime'
import { expect, it, vi } from 'vitest'

it('rejects a response from an account that has been replaced', async () => {
  let resolve!: (value: unknown) => void
  const api = new HarnessAPI(
    {
      post: () =>
        new Promise((r) => {
          resolve = r
        }),
    } as unknown as HarnessClient,
    null,
  )
  activateAPI(api)
  const request = api.post('/v1/session', {}, undefined, false)
  activateAPI(new HarnessAPI({} as HarnessClient, null))
  resolve({ private: 'old account' })
  await expect(request).rejects.toMatchObject({ name: 'AbortError' })
  expect(getView().profile).toEqual({})
})
it('rejects content responses and clears the profile when the key changes', async () => {
  let resolve!: (value: unknown) => void
  const api = new HarnessAPI(
    {
      post: () =>
        new Promise((r) => {
          resolve = r
        }),
    } as unknown as HarnessClient,
    null,
  )
  activateAPI(api)
  publish({ profile: { nickname: 'private' }, keyReady: true })
  const request = api.post('/v1/profile/get')
  api.invalidateKey()
  resolve({ nickname: 'old key' })
  await expect(request).rejects.toMatchObject({ name: 'AbortError' })
  expect(getView()).toMatchObject({ profile: {}, keyReady: false })
})
it('merges rapid anonymous preference changes in order', async () => {
  const client = { post: vi.fn() }
  const api = new HarnessAPI(client as unknown as HarnessClient, null)
  activateAPI(api)
  await Promise.all([
    api.updateProfile({ language: 'French' }),
    api.updateProfile({ themeMode: 'dark' }),
  ])
  expect(getView().profile).toEqual({ language: 'French', themeMode: 'dark' })
  expect(client.post).not.toHaveBeenCalled()
})
