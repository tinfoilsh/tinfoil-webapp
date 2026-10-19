import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockIsAuthenticated = vi.fn()
const mockGetAuthHeaders = vi.fn()
const mockLogError = vi.fn()

vi.mock('@/services/auth', () => ({
  authTokenManager: {
    isAuthenticated: (...args: unknown[]) => mockIsAuthenticated(...args),
    getAuthHeaders: (...args: unknown[]) => mockGetAuthHeaders(...args),
  },
}))

vi.mock('@/utils/error-handling', () => ({
  logError: (...args: unknown[]) => mockLogError(...args),
}))

import { fetchLegacyPasskeyCredentials } from '@/services/passkey/legacy-passkey-credentials'

describe('fetchLegacyPasskeyCredentials', () => {
  beforeEach(() => {
    mockIsAuthenticated.mockReset().mockResolvedValue(true)
    mockGetAuthHeaders.mockReset().mockResolvedValue({ Authorization: 'test' })
    mockLogError.mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('propagates abort without logging an expected fetch failure', async () => {
    const fetchMock = vi.fn((_: string, init?: RequestInit) => {
      return new Promise((_, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(init.signal?.reason),
          { once: true },
        )
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()

    const request = fetchLegacyPasskeyCredentials(controller.signal)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    controller.abort()

    await expect(request).rejects.toMatchObject({ name: 'AbortError' })
    expect(mockLogError).not.toHaveBeenCalled()
  })

  it('logs and propagates non-abort fetch failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))

    await expect(fetchLegacyPasskeyCredentials()).rejects.toThrow(
      'network down',
    )
    expect(mockLogError).toHaveBeenCalledOnce()
  })
})
