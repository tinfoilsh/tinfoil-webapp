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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/utils/error-handling', () => ({
  logInfo: vi.fn(),
  logError: vi.fn(),
}))

describe('Chat Codec - processRemoteChat', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })
  afterEach(() => vi.restoreAllMocks())

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
      expect(result.chat.messages).toEqual([
        { role: 'user', content: 'Hello', attachments: undefined },
      ])
      expect(result.chat.decryptionFailed).toBeUndefined()
      expect(result.chat.dataCorrupted).toBeUndefined()
    })

    it('preserves assistant model display names', async () => {
      const result = await processRemoteChat({
        ...baseRemoteChat,
        plaintext: basePlaintext({
          messages: [
            {
              role: 'assistant',
              content: 'Hello',
              modelDisplayName: 'GPT-OSS 120B',
            },
          ],
        }),
      })

      expect(result.chat.messages[0].modelDisplayName).toBe('GPT-OSS 120B')
    })

    it('sets sync metadata on decoded chat', async () => {
      const now = 1_700_000_000_000
      vi.spyOn(Date, 'now').mockReturnValue(now)
      const result = await processRemoteChat({
        ...baseRemoteChat,
        plaintext: basePlaintext({ messages: [] }),
      })

      expect(result.chat.syncedAt).toBe(now)
      expect(result.chat.lastAccessedAt).toBe(now)
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

    it('does not trust a plaintext clock without a server row version', async () => {
      const result = await processRemoteChat({
        ...baseRemoteChat,
        plaintext: basePlaintext({
          clock: 7,
          writer: 'device-a',
          clockVersion: 5,
        }),
      })

      expect(result.chat.clockVersion).toBeUndefined()
    })

    it('preserves a clock version when the server row is versioned', async () => {
      const result = await processRemoteChat({
        ...baseRemoteChat,
        syncVersion: 5,
        plaintext: basePlaintext({
          clock: 7,
          writer: 'device-a',
          clockVersion: 5,
        }),
      })

      expect(result.chat.clockVersion).toBe(5)
    })

    it('uses remote ID over plaintext ID', async () => {
      const result = await processRemoteChat({
        ...baseRemoteChat,
        plaintext: basePlaintext({ id: 'different-id', messages: [] }),
      })

      expect(result.chat.id).toBe('remote-chat-1')
    })

    it('sanitizes malformed and empty imported attachments', async () => {
      const result = await processRemoteChat({
        ...baseRemoteChat,
        plaintext: basePlaintext({
          messages: [
            {
              role: 'user',
              content: 'Malformed collection',
              attachments: { invalid: true },
            },
            {
              role: 'user',
              content: 'Mixed entries',
              attachments: [
                null,
                {},
                { id: '', type: 'document', fileName: 'missing.pdf' },
                {
                  id: 'empty-text',
                  type: 'document',
                  fileName: 'empty.txt',
                  textContent: '   ',
                },
                {
                  id: 'empty-pages',
                  type: 'document',
                  fileName: 'empty.pdf',
                  pages: [],
                },
                {
                  id: 'valid-document',
                  type: 'document',
                  fileName: 'notes.txt',
                  textContent: 'notes',
                },
                {
                  id: 'legacy-image',
                  type: 'image',
                  fileName: 'legacy.png',
                  key: 'legacy-key',
                },
                {
                  id: 'offloaded-document',
                  type: 'document',
                  fileName: 'report.pdf',
                  encryptionKey: 'doc-key',
                },
              ],
            },
          ],
        }),
      })

      expect(result.chat.messages[0].attachments).toBeUndefined()
      expect(result.chat.messages[1].attachments).toEqual([
        expect.objectContaining({ id: 'valid-document' }),
        expect.objectContaining({ id: 'legacy-image', key: 'legacy-key' }),
        expect.objectContaining({
          id: 'offloaded-document',
          encryptionKey: 'doc-key',
        }),
      ])
    })

    it('accepts null imported timestamps using remote metadata', async () => {
      const result = await processRemoteChat({
        ...baseRemoteChat,
        createdAt: null,
        plaintext: basePlaintext({ createdAt: null, updatedAt: null }),
      })

      expect(result.chat.createdAt).toBe('2024-01-02T00:00:00.000Z')
      expect(result.chat.updatedAt).toBe('2024-01-02T00:00:00.000Z')
    })
  })

  describe('No content handling', () => {
    it.each([null, undefined])(
      'returns no_content status when plaintext is null',
      async (plaintext) => {
        const remoteChat: RemoteChatData = {
          id: 'empty-chat',
          plaintext,
          formatVersion: 2,
          createdAt: '2024-01-01T00:00:00.000Z',
        }

        const result = await processRemoteChat(remoteChat)

        expect(result.status).toBe('no_content')
        expect(result.chat.title).toBe('Encrypted')
        expect(result.chat.decryptionFailed).toBe(false)
      },
    )

    it('rejects empty plaintext as malformed v2 envelope', async () => {
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
    it('uses localChat projectId when no explicit projectId', async () => {
      const localChat = {
        id: 'remote-chat-1',
        projectId: 'local-project',
        decryptionFailed: false,
        locallyModified: false,
        syncedAt: 0,
        updatedAt: '2024-01-01T00:00:00.000Z',
      }

      const result = await processRemoteChat(baseRemoteChat, { localChat })

      expect(result.chat.projectId).toBe('local-project')
    })

    it.each([undefined, { projectId: 'local-project' }])(
      'prefers explicit projectId over localChat projectId',
      async (localChat) => {
        const result = await processRemoteChat(baseRemoteChat, {
          localChat,
          projectId: 'explicit-project',
        })

        expect(result.chat.projectId).toBe('explicit-project')
      },
    )

    it('preserves an explicit project deletion', async () => {
      const result = await processRemoteChat(baseRemoteChat, {
        localChat: { projectId: 'local-project' },
        projectId: null,
      })

      expect(result.chat.projectId).toBeUndefined()
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
