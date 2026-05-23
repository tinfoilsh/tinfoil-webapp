/**
 * Chat Codec Tests
 *
 * Tests for the processRemoteChat() function that handles decryption
 * and placeholder creation for remote chats.
 */

import {
  processRemoteChat,
  type RemoteChatData,
} from '@/services/cloud/chat-codec'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock encryption service
const mockDecrypt = vi.fn()

vi.mock('@/services/encryption/encryption-service', () => ({
  encryptionService: {
    decrypt: (...args: any[]) => mockDecrypt(...args),
    decryptWithFallbackInfo: async (...args: any[]) => ({
      data: await mockDecrypt(...args),
      usedFallbackKey: false,
    }),
    decryptV1: (...args: any[]) => mockDecrypt(...args),
    decryptV1WithFallbackInfo: async (...args: any[]) => ({
      data: await mockDecrypt(...args),
      usedFallbackKey: false,
    }),
  },
}))

vi.mock('@/utils/error-handling', () => ({
  logInfo: vi.fn(),
  logError: vi.fn(),
}))

describe('Chat Codec - processRemoteChat', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const baseRemoteChat: RemoteChatData = {
    id: 'remote-chat-1',
    content: JSON.stringify({ iv: 'test-iv', data: 'test-data' }),
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-02T00:00:00.000Z',
  }

  describe('Successful decryption', () => {
    it('returns decrypted chat with correct status', async () => {
      const decryptedData = {
        id: 'remote-chat-1',
        title: 'My Chat',
        messages: [{ role: 'user', content: 'Hello' }],
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-02T00:00:00.000Z',
      }

      mockDecrypt.mockResolvedValue(decryptedData)

      const result = await processRemoteChat(baseRemoteChat)

      expect(result.status).toBe('decrypted')
      expect(result.chat.title).toBe('My Chat')
      expect(result.chat.messages).toHaveLength(1)
      expect(result.chat.decryptionFailed).toBeUndefined()
      expect(result.chat.encryptedData).toBeUndefined()
      expect(result.encryptedData).toBeUndefined()
    })

    it('sets sync metadata on decrypted chat', async () => {
      mockDecrypt.mockResolvedValue({
        id: 'remote-chat-1',
        title: 'Test',
        messages: [],
      })

      const result = await processRemoteChat(baseRemoteChat)

      expect(result.chat.syncedAt).toBeGreaterThan(0)
      expect(result.chat.lastAccessedAt).toBeGreaterThan(0)
      expect(result.chat.locallyModified).toBe(false)
      expect(result.chat.syncVersion).toBe(1)
    })

    it('preserves syncVersion from decrypted data if present', async () => {
      mockDecrypt.mockResolvedValue({
        id: 'remote-chat-1',
        title: 'Test',
        messages: [],
        syncVersion: 5,
      })

      const result = await processRemoteChat(baseRemoteChat)

      expect(result.chat.syncVersion).toBe(5)
    })

    it('uses remote ID over decrypted ID', async () => {
      mockDecrypt.mockResolvedValue({
        id: 'different-id',
        title: 'Test',
        messages: [],
      })

      const result = await processRemoteChat(baseRemoteChat)

      expect(result.chat.id).toBe('remote-chat-1')
    })
  })

  describe('Decryption failure', () => {
    it('creates placeholder with decryption_failed status', async () => {
      mockDecrypt.mockRejectedValue(new Error('Decryption failed: wrong key'))

      const result = await processRemoteChat(baseRemoteChat)

      expect(result.status).toBe('decryption_failed')
      expect(result.chat.title).toBe('Encrypted')
      expect(result.chat.messages).toEqual([])
      expect(result.chat.decryptionFailed).toBe(true)
      expect(result.chat.dataCorrupted).toBe(false)
      expect(result.chat.encryptedData).toBe(baseRemoteChat.content)
      expect(result.encryptedData).toBe(baseRemoteChat.content)
    })

    it('detects corrupted data and sets dataCorrupted flag', async () => {
      mockDecrypt.mockRejectedValue(
        new Error('DATA_CORRUPTED: Failed to decompress'),
      )

      const result = await processRemoteChat(baseRemoteChat)

      expect(result.status).toBe('corrupted')
      expect(result.chat.decryptionFailed).toBe(true)
      expect(result.chat.dataCorrupted).toBe(true)
    })

    it('preserves encrypted data for retry', async () => {
      mockDecrypt.mockRejectedValue(new Error('Wrong key'))

      const result = await processRemoteChat(baseRemoteChat)

      expect(result.chat.encryptedData).toBe(baseRemoteChat.content)
      expect(result.encryptedData).toBe(baseRemoteChat.content)
    })
  })

  describe('No content handling', () => {
    it('returns no_content status when content is null', async () => {
      const remoteChat: RemoteChatData = {
        id: 'empty-chat',
        content: null,
        createdAt: '2024-01-01T00:00:00.000Z',
      }

      const result = await processRemoteChat(remoteChat)

      expect(result.status).toBe('no_content')
      expect(result.chat.title).toBe('Encrypted')
      expect(result.chat.decryptionFailed).toBe(false)
      expect(mockDecrypt).not.toHaveBeenCalled()
    })

    it('returns no_content status when content is undefined', async () => {
      const remoteChat: RemoteChatData = {
        id: 'empty-chat',
        createdAt: '2024-01-01T00:00:00.000Z',
      }

      const result = await processRemoteChat(remoteChat)

      expect(result.status).toBe('no_content')
    })

    it('rejects empty v2 plaintext instead of creating a placeholder', async () => {
      const remoteChat: RemoteChatData = {
        id: 'empty-v2-chat',
        plaintext: '',
        formatVersion: 2,
        createdAt: '2024-01-01T00:00:00.000Z',
      }

      await expect(processRemoteChat(remoteChat)).rejects.toThrow(
        /v2_plaintext_invalid/,
      )
    })
  })

  describe('Project ID handling', () => {
    it('uses explicit projectId option', async () => {
      mockDecrypt.mockResolvedValue({
        id: 'chat-1',
        title: 'Test',
        messages: [],
      })

      const result = await processRemoteChat(baseRemoteChat, {
        projectId: 'project-123',
      })

      expect(result.chat.projectId).toBe('project-123')
    })

    it('uses localChat projectId when no explicit projectId', async () => {
      mockDecrypt.mockResolvedValue({
        id: 'chat-1',
        title: 'Test',
        messages: [],
      })

      const localChat = {
        id: 'chat-1',
        projectId: 'local-project',
      } as any

      const result = await processRemoteChat(baseRemoteChat, { localChat })

      expect(result.chat.projectId).toBe('local-project')
    })

    it('prefers explicit projectId over localChat projectId', async () => {
      mockDecrypt.mockResolvedValue({
        id: 'chat-1',
        title: 'Test',
        messages: [],
      })

      const localChat = {
        id: 'chat-1',
        projectId: 'local-project',
      } as any

      const result = await processRemoteChat(baseRemoteChat, {
        localChat,
        projectId: 'explicit-project',
      })

      expect(result.chat.projectId).toBe('explicit-project')
    })

    it('preserves projectId on decryption failure placeholder', async () => {
      mockDecrypt.mockRejectedValue(new Error('Wrong key'))

      const result = await processRemoteChat(baseRemoteChat, {
        projectId: 'project-456',
      })

      expect(result.chat.projectId).toBe('project-456')
    })
  })

  describe('Timestamp handling', () => {
    it('uses remote timestamps when decrypted data has none', async () => {
      mockDecrypt.mockResolvedValue({
        id: 'chat-1',
        title: 'Test',
        messages: [],
        // No createdAt or updatedAt
      })

      const result = await processRemoteChat(baseRemoteChat)

      expect(result.chat.createdAt).toBe('2024-01-01T00:00:00.000Z')
      expect(result.chat.updatedAt).toBe('2024-01-02T00:00:00.000Z')
    })

    it('uses decrypted timestamps when available', async () => {
      mockDecrypt.mockResolvedValue({
        id: 'chat-1',
        title: 'Test',
        messages: [],
        createdAt: '2023-06-15T00:00:00.000Z',
        updatedAt: '2023-06-16T00:00:00.000Z',
      })

      const result = await processRemoteChat(baseRemoteChat)

      expect(result.chat.createdAt).toBe('2023-06-15T00:00:00.000Z')
      expect(result.chat.updatedAt).toBe('2023-06-16T00:00:00.000Z')
    })

    it('falls back to createdAt for updatedAt when missing', async () => {
      const remoteChat: RemoteChatData = {
        id: 'chat-1',
        content: JSON.stringify({ iv: 'x', data: 'y' }),
        createdAt: '2024-01-01T00:00:00.000Z',
        // No updatedAt
      }

      mockDecrypt.mockResolvedValue({
        id: 'chat-1',
        title: 'Test',
        messages: [],
      })

      const result = await processRemoteChat(remoteChat)

      expect(result.chat.updatedAt).toBe('2024-01-01T00:00:00.000Z')
    })
  })

  describe('JSON parsing errors', () => {
    it('treats invalid JSON as decryption failure (graceful handling)', async () => {
      const remoteChat: RemoteChatData = {
        id: 'bad-json',
        content: 'not valid json',
        createdAt: '2024-01-01T00:00:00.000Z',
      }

      // Invalid JSON is caught and treated as decryption failure
      // This is intentional - we don't want to crash on malformed data
      const result = await processRemoteChat(remoteChat)

      expect(result.status).toBe('decryption_failed')
      expect(result.chat.decryptionFailed).toBe(true)
      expect(result.chat.encryptedData).toBe('not valid json')
    })
  })
})
