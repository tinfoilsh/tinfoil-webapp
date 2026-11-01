import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockIsAuthenticated = vi.fn()
const mockGetAuthHeaders = vi.fn()

vi.mock('@/services/auth', () => ({
  authTokenManager: {
    isAuthenticated: (...args: unknown[]) => mockIsAuthenticated(...args),
    getAuthHeaders: (...args: unknown[]) => mockGetAuthHeaders(...args),
  },
}))

import { fetchLegacyPasskeyCredentials } from '@/services/passkey/legacy-passkey-credentials'

describe('fetchLegacyPasskeyCredentials', () => {
  beforeEach(() => {
    mockIsAuthenticated.mockReset().mockResolvedValue(true)
    mockGetAuthHeaders.mockReset().mockResolvedValue({ Authorization: 'test' })
  })

  it('propagates fetch failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))

    await expect(fetchLegacyPasskeyCredentials()).rejects.toThrow(
      'network down',
    )
  })
})
