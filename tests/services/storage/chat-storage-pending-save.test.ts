import type { Chat } from '@/components/chat/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const saveChatSpy = vi.fn(async (chat: unknown) => chat)
const getChatSpy = vi.fn(async () => null as unknown)
const getAllChatsSpy = vi.fn(async () => [] as unknown[])
const backupChatSpy = vi.fn(async () => {})

vi.mock('@/services/storage/indexed-db', () => ({
  indexedDBStorage: {
    initialize: vi.fn(async () => {}),
    getChat: (...args: unknown[]) => getChatSpy(...args),
    saveChat: (...args: unknown[]) => saveChatSpy(...args),
    getAllChats: (...args: unknown[]) => getAllChatsSpy(...args),
  },
}))
vi.mock('@/services/cloud/cloud-sync', () => ({
  cloudSync: { backupChat: (...args: unknown[]) => backupChatSpy(...args) },
}))
vi.mock('@/services/cloud/cloud-storage', () => ({ cloudStorage: {} }))
vi.mock('@/services/cloud/streaming-tracker', () => ({
  streamingTracker: { isStreaming: vi.fn(() => false) },
}))
vi.mock('@/services/storage/chat-events', () => ({
  chatEvents: { emit: vi.fn() },
}))
vi.mock('@/services/storage/deleted-chats-tracker', () => ({
  deletedChatsTracker: {
    markAsDeleted: vi.fn(),
    isDeleted: vi.fn(() => false),
  },
}))
vi.mock('@/utils/cloud-sync-settings', () => ({
  isCloudSyncEnabled: vi.fn(() => true),
}))

import { chatStorage } from '@/services/storage/chat-storage'

function makeChat(overrides: Partial<Chat> = {}): Chat {
  return {
    id: 'rev_123_abc',
    title: 'Initial Message Test',
    messages: [],
    createdAt: new Date('2026-06-02T09:00:00Z'),
    isBlankChat: false,
    isLocalOnly: false,
    pendingSave: true,
    ...overrides,
  }
}

describe('chatStorage pendingSave is not persisted', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('strips pendingSave before writing a chat to storage', async () => {
    await chatStorage.saveChat(makeChat(), true)

    expect(saveChatSpy).toHaveBeenCalledTimes(1)
    const persisted = saveChatSpy.mock.calls[0][0] as Record<string, unknown>
    expect('pendingSave' in persisted).toBe(false)
    expect(persisted.id).toBe('rev_123_abc')
  })

  it('drops a stale persisted pendingSave when listing chats', async () => {
    getAllChatsSpy.mockResolvedValueOnce([
      {
        id: 'rev_123_abc',
        title: 'Initial Message Test',
        messages: [],
        createdAt: new Date('2026-06-02T09:00:00Z').toISOString(),
        isBlankChat: false,
        isLocalOnly: false,
        pendingSave: true,
      },
    ])

    const chats = await chatStorage.getAllChats()

    expect(chats).toHaveLength(1)
    expect('pendingSave' in chats[0]).toBe(false)
  })

  it('drops a stale persisted pendingSave in the sync-status listing', async () => {
    getAllChatsSpy.mockResolvedValueOnce([
      {
        id: 'rev_123_abc',
        title: 'Initial Message Test',
        messages: [],
        createdAt: new Date('2026-06-02T09:00:00Z').toISOString(),
        isBlankChat: false,
        isLocalOnly: false,
        pendingSave: true,
      },
    ])

    const chats = await chatStorage.getAllChatsWithSyncStatus()

    expect('pendingSave' in chats[0]).toBe(false)
  })
})
