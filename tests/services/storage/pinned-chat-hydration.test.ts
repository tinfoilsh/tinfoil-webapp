import type { StoredChat } from '@/services/storage/indexed-db'
import { hydratePinnedChatById } from '@/services/storage/pinned-chat-hydration'
import { describe, expect, it } from 'vitest'

function remoteChat(overrides: Partial<StoredChat> = {}): StoredChat {
  return {
    id: 'chat-a',
    title: 'Remote title',
    messages: [],
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    lastAccessedAt: 0,
    ...overrides,
  }
}

describe('hydratePinnedChatById', () => {
  it('keeps an ambiguous null download unavailable instead of pruning it', async () => {
    const result = await hydratePinnedChatById('chat-a', {
      downloadChat: async () => null,
    })

    expect(result.status).toBe('unavailable')
  })

  it('returns downloaded chats for memory-only rendering', async () => {
    const result = await hydratePinnedChatById('chat-a', {
      downloadChat: async () => remoteChat(),
    })

    expect(result).toMatchObject({
      status: 'ready',
      chat: { id: 'chat-a', title: 'Remote title' },
    })
    if (result.status === 'ready') {
      expect(result.chat.createdAt).toBeInstanceOf(Date)
    }
  })

  it('keeps unavailable chats pinned and rejects corrupted chats', async () => {
    const unavailable = await hydratePinnedChatById('chat-a', {
      downloadChat: async () => remoteChat({ decryptionFailed: true }),
    })
    expect(unavailable.status).toBe('unavailable')

    const corrupted = await hydratePinnedChatById('chat-a', {
      downloadChat: async () => remoteChat({ dataCorrupted: true }),
    })
    expect(corrupted.status).toBe('invalid')
  })
})
