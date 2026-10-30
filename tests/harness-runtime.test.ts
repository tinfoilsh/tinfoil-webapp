import type { HarnessClient } from '@/services/harness/client'
import {
  activateAPI,
  getView,
  HarnessAPI,
  publish,
} from '@/services/harness/runtime'
import { expect, it } from 'vitest'

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
