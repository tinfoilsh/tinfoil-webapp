import { authTokenManager } from '@/services/auth'
import {
  deleteSharedChat,
  fetchSharedChat,
  getShareStatus,
  SHARE_FORMAT_VERSION,
  SHARE_STORAGE_FORMAT_HEADER,
  SHARE_STORAGE_FORMAT_VERSION,
  SharedChatNotFoundError,
  UnsupportedShareFormatError,
} from '@/services/share-api'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/services/auth', () => ({
  authTokenManager: { getAuthHeaders: vi.fn() },
}))

describe('fetchSharedChat', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('accepts storage format 1 as binary', async () => {
    const binary = new Uint8Array([1, 2, 3]).buffer
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(binary, {
        headers: {
          [SHARE_STORAGE_FORMAT_HEADER]: SHARE_STORAGE_FORMAT_VERSION,
        },
      }),
    )

    await expect(fetchSharedChat('chat-id')).resolves.toEqual({
      formatVersion: SHARE_FORMAT_VERSION,
      binary,
    })
    expect(fetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/shares\/chat-id$/),
      { method: 'GET', cache: 'no-store' },
    )
  })

  it.each([null, '0', '2', '1.0', 'invalid'])(
    'rejects storage format %s',
    async (formatVersion) => {
      const headers = new Headers()
      if (formatVersion !== null) {
        headers.set(SHARE_STORAGE_FORMAT_HEADER, formatVersion)
      }
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('{}', { headers }),
      )

      await expect(fetchSharedChat('chat-id')).rejects.toBeInstanceOf(
        UnsupportedShareFormatError,
      )
    },
  )

  it('classifies missing shares', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 404 }),
    )

    await expect(fetchSharedChat('chat-id')).rejects.toBeInstanceOf(
      SharedChatNotFoundError,
    )
  })
})

describe('share management', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.mocked(authTokenManager.getAuthHeaders).mockResolvedValue({
      Authorization: 'Bearer owner-token',
    })
  })

  it.each([true, false])(
    'reads authoritative shared=%s status with authentication',
    async (shared) => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ shared }))
      await expect(getShareStatus('chat-id')).resolves.toBe(shared)
      expect(fetch).toHaveBeenCalledWith(
        expect.stringMatching(/\/api\/shares\/chat-id\/status$/),
        { headers: { Authorization: 'Bearer owner-token' }, cache: 'no-store' },
      )
    },
  )

  it.each([null, {}, { shared: 'false' }, { shared: 0 }])(
    'rejects malformed status %j',
    async (data) => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(data))
      await expect(getShareStatus('chat-id')).rejects.toThrow(
        'Invalid share status response',
      )
    },
  )

  it('deletes only through an authenticated request', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 204 }),
    )
    await deleteSharedChat('chat-id')
    expect(fetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/shares\/chat-id$/),
      { method: 'DELETE', headers: { Authorization: 'Bearer owner-token' } },
    )
  })

  it.each([401, 403, 404, 500])(
    'does not treat HTTP %s as private or revoked',
    async (status) => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(
        async () => new Response(null, { status }),
      )
      await expect(getShareStatus('chat-id')).rejects.toThrow()
      await expect(deleteSharedChat('chat-id')).rejects.toThrow()
    },
  )

  it('propagates network and authentication failures', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new TypeError('Offline'))
    await expect(deleteSharedChat('chat-id')).rejects.toThrow('Offline')
    await expect(getShareStatus('chat-id')).rejects.toThrow('Offline')
    fetchMock.mockClear()
    vi.mocked(authTokenManager.getAuthHeaders).mockRejectedValue(
      new Error('Signed out'),
    )
    await expect(deleteSharedChat('chat-id')).rejects.toThrow('Signed out')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
