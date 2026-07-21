/**
 * Sync Predicates Tests
 *
 * Tests for the sync eligibility predicates in sync-predicates.ts.
 *
 * A chat is uploadable if it meets ALL of these conditions:
 * - isLocalOnly !== true
 * - isBlankChat !== true
 * - decryptionFailed !== true
 * - not currently streaming
 */

import {
  isUploadableChat,
  remoteWins,
  remoteWinsLastWrite,
  shouldIngestRemoteChat,
  trustedChatClock,
} from '@/services/cloud/sync-predicates'
import type { StoredChat } from '@/services/storage/indexed-db'
import { describe, expect, it } from 'vitest'

// Helper type for tests - matches StoredChat but allows partial construction
type TestChat = Partial<StoredChat> & {
  id: string
  createdAt: string
  updatedAt: string
}

describe('Sync Predicates', () => {
  const baseChat = {
    id: 'test-chat-1',
    title: 'Test Chat',
    messages: [{ role: 'user', content: 'hello' }],
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    lastAccessedAt: Date.now(),
    isBlankChat: false,
    isLocalOnly: false,
    decryptionFailed: false,
    syncVersion: 1,
  } as StoredChat

  describe('isUploadableChat', () => {
    it('returns true for a normal cloud chat', () => {
      expect(isUploadableChat(baseChat)).toBe(true)
    })

    it('returns false for local-only chats', () => {
      const localOnlyChat = { ...baseChat, isLocalOnly: true }
      expect(isUploadableChat(localOnlyChat)).toBe(false)
    })

    it('returns false for blank chats', () => {
      const blankChat = { ...baseChat, isBlankChat: true }
      expect(isUploadableChat(blankChat)).toBe(false)
    })

    it('returns false for chats that failed decryption', () => {
      const failedChat = { ...baseChat, decryptionFailed: true }
      expect(isUploadableChat(failedChat)).toBe(false)
    })

    it('returns false for chats currently streaming', () => {
      const isStreaming = (id: string) => id === 'test-chat-1'
      expect(isUploadableChat(baseChat, isStreaming)).toBe(false)
    })

    it('returns true for non-streaming chats when other chats are streaming', () => {
      const isStreaming = (id: string) => id === 'other-chat'
      expect(isUploadableChat(baseChat, isStreaming)).toBe(true)
    })

    it('handles undefined/missing optional fields', () => {
      const minimalChat = {
        id: 'minimal',
        title: 'Minimal',
        messages: [],
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        lastAccessedAt: Date.now(),
        // No optional fields set
      } as StoredChat
      expect(isUploadableChat(minimalChat)).toBe(true)
    })

    it('handles false vs undefined for boolean flags', () => {
      const explicitFalse = {
        ...baseChat,
        isLocalOnly: false,
        isBlankChat: false,
        decryptionFailed: false,
      } as StoredChat
      expect(isUploadableChat(explicitFalse)).toBe(true)
    })
  })

  describe('shouldIngestRemoteChat', () => {
    // Note: The predicate compares remote.updatedAt with local.syncedAt
    // (not local.updatedAt) because syncedAt represents when we last
    // got data from the server

    it('returns true when no local chat exists', () => {
      const remote = {
        id: 'new-chat',
        updatedAt: '2024-01-01T00:00:00.000Z',
      }
      expect(shouldIngestRemoteChat(remote, undefined)).toBe(true)
    })

    it('returns true when local chat is null', () => {
      const remote = {
        id: 'new-chat',
        updatedAt: '2024-01-01T00:00:00.000Z',
      }
      expect(shouldIngestRemoteChat(remote, null)).toBe(true)
    })

    it('returns true when local chat failed decryption', () => {
      const remote = {
        id: 'test-chat-1',
        updatedAt: '2024-01-01T00:00:00.000Z',
      }
      const local = { ...baseChat, decryptionFailed: true } as StoredChat
      expect(shouldIngestRemoteChat(remote, local)).toBe(true)
    })

    it('returns true when remote updatedAt is newer than local syncedAt', () => {
      const remote = {
        id: 'test-chat-1',
        updatedAt: '2024-01-02T00:00:00.000Z', // Newer than syncedAt
      }
      const local = {
        ...baseChat,
        syncedAt: new Date('2024-01-01T00:00:00.000Z').getTime(),
      } as StoredChat
      expect(shouldIngestRemoteChat(remote, local)).toBe(true)
    })

    it('returns false when local syncedAt is newer than remote', () => {
      const remote = {
        id: 'test-chat-1',
        updatedAt: '2024-01-01T00:00:00.000Z',
      }
      const local = {
        ...baseChat,
        syncedAt: new Date('2024-01-02T00:00:00.000Z').getTime(), // Newer
      } as StoredChat
      expect(shouldIngestRemoteChat(remote, local)).toBe(false)
    })

    it('returns false when timestamps are equal', () => {
      const timestamp = new Date('2024-01-01T00:00:00.000Z').getTime()
      const remote = {
        id: 'test-chat-1',
        updatedAt: '2024-01-01T00:00:00.000Z',
      }
      const local = {
        ...baseChat,
        syncedAt: timestamp, // Same as remote
      } as StoredChat
      expect(shouldIngestRemoteChat(remote, local)).toBe(false)
    })

    it('returns true when local has no syncedAt (treated as 0)', () => {
      // When syncedAt is undefined, it's treated as 0, so any valid remote timestamp wins
      const remote = {
        id: 'test-chat-1',
        updatedAt: '2024-01-01T00:00:00.000Z',
      }
      const local = {
        ...baseChat,
        syncedAt: undefined,
      } as StoredChat
      expect(shouldIngestRemoteChat(remote, local)).toBe(true)
    })

    it('returns false when local chat has unsynced modifications', () => {
      const remote = {
        id: 'test-chat-1',
        updatedAt: '2024-01-02T00:00:00.000Z',
      }
      const local = {
        ...baseChat,
        locallyModified: true,
        syncedAt: new Date('2024-01-01T00:00:00.000Z').getTime(),
      } as StoredChat
      expect(shouldIngestRemoteChat(remote, local)).toBe(false)
    })

    it('returns true when local chat has no unsynced modifications and remote is newer', () => {
      const remote = {
        id: 'test-chat-1',
        updatedAt: '2024-01-02T00:00:00.000Z',
      }
      const local = {
        ...baseChat,
        locallyModified: false,
        syncedAt: new Date('2024-01-01T00:00:00.000Z').getTime(),
      } as StoredChat
      expect(shouldIngestRemoteChat(remote, local)).toBe(true)
    })

    it('returns true for decryption-failed chat even if locallyModified', () => {
      const remote = {
        id: 'test-chat-1',
        updatedAt: '2024-01-01T00:00:00.000Z',
      }
      const local = {
        ...baseChat,
        decryptionFailed: true,
        locallyModified: true,
      } as StoredChat
      expect(shouldIngestRemoteChat(remote, local)).toBe(true)
    })
  })

  describe('remoteWinsLastWrite', () => {
    const older = '2024-01-01T00:00:00.000Z'
    const newer = '2024-01-02T00:00:00.000Z'

    it('lets remote win when it is strictly newer', () => {
      expect(remoteWinsLastWrite(older, newer)).toBe(true)
    })

    it('lets local win when it is strictly newer', () => {
      expect(remoteWinsLastWrite(newer, older)).toBe(false)
    })

    it('lets local win on a timestamp tie', () => {
      expect(remoteWinsLastWrite(older, older)).toBe(false)
    })

    it('lets remote win when local has no timestamp', () => {
      expect(remoteWinsLastWrite(undefined, newer)).toBe(true)
      expect(remoteWinsLastWrite(null, newer)).toBe(true)
    })

    it('lets remote win when local timestamp is unparseable', () => {
      expect(remoteWinsLastWrite('not-a-date', newer)).toBe(true)
    })

    it('lets local win when remote has no usable timestamp', () => {
      expect(remoteWinsLastWrite(older, undefined)).toBe(false)
      expect(remoteWinsLastWrite(older, 'not-a-date')).toBe(false)
    })
  })

  describe('remoteWins', () => {
    const older = '2024-01-01T00:00:00.000Z'
    const newer = '2024-01-02T00:00:00.000Z'

    it('prefers the higher clock counter over wall-clock time', () => {
      // Remote has an older timestamp but a higher logical clock; the
      // clock must win so wall-clock skew cannot decide the outcome.
      expect(
        remoteWins({
          localClock: { v: 1, w: 'a' },
          remoteClock: { v: 2, w: 'a' },
          localUpdatedAt: newer,
          remoteUpdatedAt: older,
        }),
      ).toBe(true)
    })

    it('lets local win when its clock counter is higher', () => {
      expect(
        remoteWins({
          localClock: { v: 5, w: 'a' },
          remoteClock: { v: 4, w: 'b' },
        }),
      ).toBe(false)
    })

    it('breaks an equal counter by writer id deterministically', () => {
      expect(
        remoteWins({
          localClock: { v: 3, w: 'aaa' },
          remoteClock: { v: 3, w: 'bbb' },
        }),
      ).toBe(true)
      expect(
        remoteWins({
          localClock: { v: 3, w: 'bbb' },
          remoteClock: { v: 3, w: 'aaa' },
        }),
      ).toBe(false)
    })

    it('treats an identical clock as the same write (no overwrite)', () => {
      expect(
        remoteWins({
          localClock: { v: 7, w: 'a' },
          remoteClock: { v: 7, w: 'a' },
        }),
      ).toBe(false)
    })

    it('falls back to updatedAt when a clock is missing', () => {
      expect(
        remoteWins({
          localClock: { v: 9, w: 'a' },
          remoteClock: undefined,
          localUpdatedAt: older,
          remoteUpdatedAt: newer,
        }),
      ).toBe(true)
      expect(
        remoteWins({
          localClock: undefined,
          remoteClock: { v: 9, w: 'a' },
          localUpdatedAt: newer,
          remoteUpdatedAt: older,
        }),
      ).toBe(false)
    })
  })

  describe('Combined scenarios', () => {
    it('a failed-decryption chat is not uploadable', () => {
      const failedChat = {
        ...baseChat,
        decryptionFailed: true,
      }

      // Should not upload (would overwrite server data with placeholder)
      expect(isUploadableChat(failedChat)).toBe(false)
    })

    it('local-only chats are never uploadable regardless of other flags', () => {
      const localOnlyWithMessages = {
        ...baseChat,
        isLocalOnly: true,
        messages: [
          { role: 'user', content: 'important message' },
          { role: 'assistant', content: 'response' },
        ],
      }

      expect(isUploadableChat(localOnlyWithMessages)).toBe(false)
    })

    it('blank chats are never uploadable even if explicitly cloud-enabled', () => {
      const blankCloudChat = {
        ...baseChat,
        isBlankChat: true,
        isLocalOnly: false,
        messages: [],
      }

      expect(isUploadableChat(blankCloudChat)).toBe(false)
    })
  })

  describe('trustedChatClock', () => {
    it('accepts a version-bound positive safe clock', () => {
      expect(
        trustedChatClock({
          clock: 4,
          writer: 'writer-a',
          clockVersion: 3,
          syncVersion: 3,
        }),
      ).toEqual({ v: 4, w: 'writer-a' })
    })

    it.each([Number.NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
      'rejects malformed clock value %s',
      (clock) => {
        expect(
          trustedChatClock({
            clock,
            writer: 'writer-a',
            clockVersion: 3,
            syncVersion: 3,
          }),
        ).toBeUndefined()
      },
    )

    it('rejects an empty writer identifier', () => {
      for (const writer of ['', '   ']) {
        expect(
          trustedChatClock({
            clock: 4,
            writer,
            clockVersion: 3,
            syncVersion: 3,
          }),
        ).toBeUndefined()
      }
    })
  })
})
