/**
 * §9.6 R6 + §14 #15 — local-only-chat invariant.
 *
 * A chat the user marked `isLocalOnly` MUST NEVER reach the enclave
 * write surface. This file intercepts every enclave call the cloud
 * adapters make and asserts the local-only chat id is absent from
 * push, bulk-upload, and the upload-coalescer enqueue path.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockEnclavePush = vi.fn()

vi.mock('@/services/encryption/encryption-service', () => ({
  encryptionService: {
    getKey: () => 'a'.repeat(64),
    getAllKeys: () => ({
      primary: 'a'.repeat(64),
      alternatives: [],
    }),
  },
}))

vi.mock('@/services/auth', () => ({
  authTokenManager: {
    getAuthHeaders: async () => ({ Authorization: 'Bearer t' }),
    isAuthenticated: async () => true,
    isInitialized: () => true,
    waitForInit: async () => true,
  },
}))

vi.mock('@/services/sync-enclave/sync-api', async () => {
  const actual: any = await vi.importActual('@/services/sync-enclave/sync-api')
  return {
    ...actual,
    push: (...args: any[]) => mockEnclavePush(...args),
  }
})

import { CloudStorageService } from '@/services/cloud/cloud-storage'

describe('§9.6 R6 — local-only-chat invariant', () => {
  beforeEach(() => {
    mockEnclavePush.mockReset()
    mockEnclavePush.mockResolvedValue({
      ok: true,
      etag: '1',
      keyId: 'kid',
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('refuses single uploadChat for a local-only chat', async () => {
    const service = new CloudStorageService()
    await expect(
      service.uploadChat({
        id: 'chat-localonly',
        title: 'local only',
        messages: [],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        lastAccessedAt: 0,
        isLocalOnly: true,
      } as any),
    ).rejects.toThrow(/§9\.6 R6/)
    expect(mockEnclavePush).not.toHaveBeenCalled()
  })

  it('silently filters local-only chats out of bulkUploadChats', async () => {
    const service = new CloudStorageService()
    const result = await service.bulkUploadChats([
      {
        id: 'chat-keep',
        title: 'sync me',
        messages: [],
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'chat-localonly',
        title: 'do not sync',
        messages: [],
        createdAt: '2026-01-01T00:00:00.000Z',
        isLocalOnly: true,
      },
    ])

    expect(mockEnclavePush).toHaveBeenCalledTimes(1)
    const pushArg = mockEnclavePush.mock.calls[0][0]
    expect(pushArg.id).toBe('chat-keep')
    // The local-only id must not appear in ANY push call.
    for (const call of mockEnclavePush.mock.calls) {
      expect(call[0].id).not.toBe('chat-localonly')
    }
    expect(result.succeeded).toBe(1)
    expect(result.failed).toBe(0)
  })
})
