/**
 * Chat Codec Tests
 *
 * The codec now only decodes v2 plaintext returned by the sync
 * enclave. Legacy v0/v1 client-side decryption has been removed; the
 * tests below pin down the v2 contract and the no-content placeholder.
 */

import {
  processRemoteChat,
  type RemoteChatData,
} from '@/services/cloud/chat-codec'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/utils/error-handling', () => ({
  logInfo: vi.fn(),
  logError: vi.fn(),
}))

describe('Chat Codec - processRemoteChat', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const basePlaintext = (overrides: Record<string, unknown> = {}) =>
    JSON.stringify({
      id: 'remote-chat-1',
      title: 'My Chat',
      messages: [{ role: 'user', content: 'Hello' }],
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-02T00:00:00.000Z',
      ...overrides,
    })

  const baseRemoteChat: RemoteChatData = {
    id: 'remote-chat-1',
    plaintext: basePlaintext(),
    formatVersion: 2,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-02T00:00:00.000Z',
  }

  describe('Successful decode', () => {
    it('returns decoded chat with correct status', async () => {
      const result = await processRemoteChat(baseRemoteChat)

      expect(result.status).toBe('decrypted')
      expect(result.chat.title).toBe('My Chat')
      expect(result.chat.messages).toHaveLength(1)
      expect(result.chat.decryptionFailed).toBeUndefined()
    })

    it('sets sync metadata on decoded chat', async () => {
      const result = await processRemoteChat({
        ...baseRemoteChat,
        plaintext: basePlaintext({ messages: [] }),
      })

      expect(result.chat.syncedAt).toBeGreaterThan(0)
      expect(result.chat.lastAccessedAt).toBeGreaterThan(0)
      expect(result.chat.locallyModified).toBe(false)
      expect(result.chat.syncVersion).toBe(1)
      expect(result.chat.formatVersion).toBe(2)
    })

    it('preserves syncVersion from plaintext if present', async () => {
      const result = await processRemoteChat({
        ...baseRemoteChat,
        plaintext: basePlaintext({ syncVersion: 5, messages: [] }),
      })

      expect(result.chat.syncVersion).toBe(5)
    })

    it('uses remote ID over plaintext ID', async () => {
      const result = await processRemoteChat({
        ...baseRemoteChat,
        plaintext: basePlaintext({ id: 'different-id', messages: [] }),
      })

      expect(result.chat.id).toBe('remote-chat-1')
    })
  })

  describe('No content handling', () => {
    it('returns no_content status when plaintext is null', async () => {
      const remoteChat: RemoteChatData = {
        id: 'empty-chat',
        plaintext: null,
        formatVersion: 2,
        createdAt: '2024-01-01T00:00:00.000Z',
      }

      const result = await processRemoteChat(remoteChat)

      expect(result.status).toBe('no_content')
      expect(result.chat.title).toBe('Encrypted')
      expect(result.chat.decryptionFailed).toBe(false)
    })

    it('returns no_content status when plaintext is undefined', async () => {
      const remoteChat: RemoteChatData = {
        id: 'empty-chat',
        formatVersion: 2,
        createdAt: '2024-01-01T00:00:00.000Z',
      }

      const result = await processRemoteChat(remoteChat)

      expect(result.status).toBe('no_content')
    })

    it('rejects empty plaintext as malformed v2 envelope', async () => {
      const remoteChat: RemoteChatData = {
        id: 'empty-v2-chat',
        plaintext: '',
        formatVersion: 2,
        createdAt: '2024-01-01T00:00:00.000Z',
      }

      const result = await processRemoteChat(remoteChat)
      expect(result.status).toBe('no_content')
    })

    it('throws v2_plaintext_invalid on malformed JSON', async () => {
      const remoteChat: RemoteChatData = {
        id: 'broken-v2-chat',
        plaintext: 'not valid json',
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
      const result = await processRemoteChat(baseRemoteChat, {
        projectId: 'project-123',
      })

      expect(result.chat.projectId).toBe('project-123')
    })

    it('uses localChat projectId when no explicit projectId', async () => {
      const localChat = {
        id: 'remote-chat-1',
        projectId: 'local-project',
      } as any

      const result = await processRemoteChat(baseRemoteChat, { localChat })

      expect(result.chat.projectId).toBe('local-project')
    })

    it('prefers explicit projectId over localChat projectId', async () => {
      const localChat = {
        id: 'remote-chat-1',
        projectId: 'local-project',
      } as any

      const result = await processRemoteChat(baseRemoteChat, {
        localChat,
        projectId: 'explicit-project',
      })

      expect(result.chat.projectId).toBe('explicit-project')
    })
  })

  describe('Timestamp handling', () => {
    it('uses plaintext timestamps when available', async () => {
      const result = await processRemoteChat({
        ...baseRemoteChat,
        plaintext: basePlaintext({
          createdAt: '2023-06-15T00:00:00.000Z',
          updatedAt: '2023-06-16T00:00:00.000Z',
        }),
      })

      expect(result.chat.createdAt).toBe('2023-06-15T00:00:00.000Z')
      expect(result.chat.updatedAt).toBe('2023-06-16T00:00:00.000Z')
    })

    it('falls back to remote createdAt for updatedAt when missing', async () => {
      const remoteChat: RemoteChatData = {
        id: 'chat-1',
        plaintext: JSON.stringify({
          id: 'chat-1',
          title: 'Test',
          messages: [],
        }),
        formatVersion: 2,
        createdAt: '2024-01-01T00:00:00.000Z',
      }

      const result = await processRemoteChat(remoteChat)

      expect(result.chat.updatedAt).toBe('2024-01-01T00:00:00.000Z')
    })
  })
})
