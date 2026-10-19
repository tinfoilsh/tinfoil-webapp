import { AUTH_ACTIVE_USER_ID } from '@/constants/storage-keys'
import { HarnessAPI, harnessAPI } from '@/services/harness/runtime'
import { expect, it, vi } from 'vitest'

// The shared setup activates a harness before each test. A test file's mock
// of a module the harness runtime uses must still reach the runtime.
vi.mock('@/services/encryption/encryption-service', () => ({
  encryptionService: {
    getCurrentKeyBytes: () => new Uint8Array([1, 2, 3]),
  },
}))

it("reads the content key through a test file's mock of the encryption service", () => {
  localStorage.setItem(AUTH_ACTIVE_USER_ID, 'alice')
  const api = new HarnessAPI(harnessAPI().client, 'alice')

  expect(api.key()).toBe('AQID')
})
