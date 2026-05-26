import { AUTH_ACTIVE_USER_ID } from '@/constants/storage-keys'
import { CloudStorageService } from '@/services/cloud/cloud-storage'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockGetAuthHeaders = vi.fn()
const mockIsAuthenticated = vi.fn()
const mockIsInitialized = vi.fn()
const mockWaitForInit = vi.fn()
const mockGetKey = vi.fn()
const mockGetAllKeys = vi.fn()
const mockGetKeyBytesOrThrow = vi.fn()
const mockGetAlternativeKeyBytes = vi.fn()
const mockEnclavePush = vi.fn()
const mockListStatus = vi.fn()
const mockAttachmentPut = vi.fn()
const mockAttachmentGet = vi.fn()

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
    getKey: (...args: any[]) => mockGetKey(...args),
    getAllKeys: (...args: any[]) => mockGetAllKeys(...args),
    getKeyBytesOrThrow: (...args: any[]) => mockGetKeyBytesOrThrow(...args),
    getAlternativeKeyBytes: (...args: any[]) =>
      mockGetAlternativeKeyBytes(...args),
  },
}))

vi.mock('@/services/sync-enclave/sync-api', async () => {
  const actual: any = await vi.importActual('@/services/sync-enclave/sync-api')
  return {
    ...actual,
    push: (...args: any[]) => mockEnclavePush(...args),
    listStatus: (...args: any[]) => mockListStatus(...args),
    attachmentPut: (...args: any[]) => mockAttachmentPut(...args),
    attachmentGet: (...args: any[]) => mockAttachmentGet(...args),
  }
})

describe('CloudStorageService auth readiness', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    mockGetAuthHeaders.mockResolvedValue({ Authorization: 'Bearer token' })
    mockIsAuthenticated.mockResolvedValue(true)
    mockIsInitialized.mockReturnValue(true)
    mockWaitForInit.mockResolvedValue(true)
    // Real keys are `key_<base36-encoded 32-byte CEK>` per
    // encryption-service. Mock the shape end-to-end so the helpers
    // in `cek-encoding.ts` resolve to predictable bytes without
    // re-implementing the base36 decoder in the test.
    const TEST_KEY = `key_${'a'.repeat(64)}`
    const TEST_BYTES = new Uint8Array(32)
    mockGetKey.mockReturnValue(TEST_KEY)
    mockGetAllKeys.mockReturnValue({
      primary: TEST_KEY,
      alternatives: [TEST_KEY],
    })
    mockGetKeyBytesOrThrow.mockReturnValue(TEST_BYTES)
    mockGetAlternativeKeyBytes.mockReturnValue(TEST_BYTES)
    mockEnclavePush.mockResolvedValue({ ok: true, etag: '1', keyId: 'kid' })
    mockListStatus.mockResolvedValue({ updates: [], deletes: [] })
    mockAttachmentPut.mockResolvedValue({
      ok: true,
      id: 'att-v2',
      att_key: 'k',
    })
    mockAttachmentGet.mockResolvedValue(new Uint8Array([1, 2, 3]))
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
    expect(mockListStatus).toHaveBeenCalledWith({
      scope: 'chat',
      cursor: undefined,
      limit: 100,
      direction: 'desc',
    })
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

  it('marks restore uploads so the enclave can clear stale tombstones', async () => {
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

    expect(mockEnclavePush).toHaveBeenCalledTimes(1)
    const pushArg = mockEnclavePush.mock.calls[0][0]
    expect(pushArg.scope).toBe('chat')
    expect(pushArg.id).toBe('chat-1')
    expect(pushArg.metadata).toMatchObject({ restoreDeleted: true })
  })

  it('reuses stable attachment idempotency keys across upload retries', async () => {
    const service = new CloudStorageService()
    const chat = {
      id: 'chat-1',
      title: 'Local chat',
      messages: [
        {
          role: 'user',
          content: 'hi',
          attachments: [
            {
              id: 'local-att',
              type: 'image',
              fileName: 'image.png',
              base64: 'AQID',
            },
          ],
        },
      ],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      lastAccessedAt: 0,
    } as any

    await service.uploadChat(chat, { idempotencyKey: 'upload-idem-1' })
    const firstKey = mockAttachmentPut.mock.calls[0][0].idempotencyKey

    chat.messages[0].attachments[0].id = 'local-att'
    chat.messages[0].attachments[0].base64 = 'AQID'
    chat.messages[0].attachments[0].encryptionKey = undefined
    await service.uploadChat(chat, { idempotencyKey: 'upload-idem-1' })

    expect(mockAttachmentPut).toHaveBeenCalledTimes(2)
    expect(mockAttachmentPut.mock.calls[1][0].idempotencyKey).toBe(firstKey)
  })

  it('does not re-upload attachments that already have enclave keys', async () => {
    const service = new CloudStorageService()
    const chat = {
      id: 'chat-1',
      title: 'Local chat',
      messages: [
        {
          role: 'user',
          content: 'hi',
          attachments: [
            {
              id: 'att-v2',
              type: 'image',
              fileName: 'image.png',
              base64: 'AQID',
              encryptionKey: 'existing-key',
            },
          ],
        },
      ],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      lastAccessedAt: 0,
    } as any

    await service.uploadChat(chat, { idempotencyKey: 'upload-idem-1' })

    expect(mockAttachmentPut).not.toHaveBeenCalled()
  })

  it('uploads attachments before chat push so retries reuse enclave-minted ids', async () => {
    mockEnclavePush.mockRejectedValueOnce(new Error('push failed'))
    const service = new CloudStorageService()
    const chat = {
      id: 'chat-1',
      title: 'Local chat',
      messages: [
        {
          role: 'user',
          content: 'hi',
          attachments: [
            {
              id: 'local-att',
              type: 'image',
              fileName: 'image.png',
              base64: 'AQID',
            },
          ],
        },
      ],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      lastAccessedAt: 0,
    } as any

    await expect(
      service.uploadChat(chat, { idempotencyKey: 'upload-idem-1' }),
    ).rejects.toThrow('push failed')

    expect(mockAttachmentPut).toHaveBeenCalledTimes(1)
    // The caller's chat object is intentionally NOT mutated; rewrites
    // travel as a side channel and are applied by finalizeUpload.
    expect(chat.messages[0].attachments[0]).toMatchObject({
      id: 'local-att',
    })
  })

  it('does not downgrade v2 attachment reads to legacy fetch on enclave failure', async () => {
    mockAttachmentGet.mockRejectedValueOnce(new Error('attestation failed'))
    const service = new CloudStorageService()
    const images = await service.loadChatImages('chat-1', [
      {
        role: 'user',
        content: 'image',
        attachments: [
          {
            id: 'att-v2',
            type: 'image',
            encryptionKey: 'att-key',
          },
        ],
      },
    ] as any)

    expect(images).toEqual({})
    expect(mockAttachmentGet).toHaveBeenCalledWith({
      id: 'att-v2',
      attKeyB64: 'att-key',
    })
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })
})
