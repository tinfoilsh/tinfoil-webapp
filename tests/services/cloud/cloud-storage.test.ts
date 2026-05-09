import { AUTH_ACTIVE_USER_ID } from '@/constants/storage-keys'
import { CloudStorageService } from '@/services/cloud/cloud-storage'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockGetAuthHeaders = vi.fn()
const mockIsAuthenticated = vi.fn()
const mockIsInitialized = vi.fn()
const mockWaitForInit = vi.fn()
const mockEncryptV1 = vi.fn()

vi.mock('@/services/auth', () => ({
  authTokenManager: {
    getAuthHeaders: (...args: any[]) => mockGetAuthHeaders(...args),
    isAuthenticated: (...args: any[]) => mockIsAuthenticated(...args),
    isInitialized: (...args: any[]) => mockIsInitialized(...args),
    waitForInit: (...args: any[]) => mockWaitForInit(...args),
  },
}))

vi.mock('@/services/encryption/encryption-service', () => ({
  encryptionService: {
    encryptV1: (...args: any[]) => mockEncryptV1(...args),
  },
}))

describe('CloudStorageService auth readiness', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    mockGetAuthHeaders.mockResolvedValue({ Authorization: 'Bearer token' })
    mockIsAuthenticated.mockResolvedValue(true)
    mockIsInitialized.mockReturnValue(true)
    mockWaitForInit.mockResolvedValue(true)
    mockEncryptV1.mockResolvedValue(new Uint8Array([1, 2, 3]))
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          conversations: [],
          hasMore: false,
        }),
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('waits for auth token manager initialization before listing chats', async () => {
    mockIsInitialized.mockReturnValue(false)
    localStorage.setItem(AUTH_ACTIVE_USER_ID, 'user_123')

    const service = new CloudStorageService()
    await service.listChats()

    expect(mockWaitForInit).toHaveBeenCalledWith(3000)
    expect(mockGetAuthHeaders).toHaveBeenCalledTimes(1)
  })

  it('waits for auth token manager initialization before checking auth state', async () => {
    mockIsInitialized.mockReturnValue(false)
    localStorage.setItem(AUTH_ACTIVE_USER_ID, 'user_123')

    const service = new CloudStorageService()
    const isAuthenticated = await service.isAuthenticated()

    expect(isAuthenticated).toBe(true)
    expect(mockWaitForInit).toHaveBeenCalledWith(3000)
    expect(mockIsAuthenticated).toHaveBeenCalledTimes(1)
  })

  it('marks restore uploads so the backend can clear stale tombstones', async () => {
    const service = new CloudStorageService()
    await service.uploadChat(
      {
        id: 'chat-1',
        title: 'Local chat',
        messages: [{ role: 'user', content: 'hi' }],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        lastAccessedAt: 0,
      } as any,
      { restoreDeleted: true },
    )

    const fetchCall = vi.mocked(fetch).mock.calls[0]
    expect(fetchCall?.[1]?.headers).toMatchObject({
      'X-Restore-Deleted-Chat': 'true',
    })
  })
})
