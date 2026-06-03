import { syncRemoteDeletions } from '@/services/cloud/chat-ingestion'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockGetDeletedChatsSince = vi.fn()
const mockGetChat = vi.fn()
const mockDeleteChat = vi.fn()
const mockMarkAsDeleted = vi.fn()
const mockEmit = vi.fn()

vi.mock('@/utils/error-handling', () => ({
  logError: vi.fn(),
}))

vi.mock('@/services/cloud/cloud-storage', () => ({
  cloudStorage: {
    getDeletedChatsSince: (...args: any[]) => mockGetDeletedChatsSince(...args),
  },
}))

vi.mock('@/services/storage/indexed-db', () => ({
  indexedDBStorage: {
    getChat: (...args: any[]) => mockGetChat(...args),
    deleteChat: (...args: any[]) => mockDeleteChat(...args),
  },
}))

vi.mock('@/services/storage/deleted-chats-tracker', () => ({
  deletedChatsTracker: {
    markAsDeleted: (...args: any[]) => mockMarkAsDeleted(...args),
  },
}))

vi.mock('@/services/storage/chat-events', () => ({
  chatEvents: {
    emit: (...args: any[]) => mockEmit(...args),
  },
}))

vi.mock('@/services/cloud/chat-codec', () => ({
  processRemoteChat: vi.fn(),
}))

describe('syncRemoteDeletions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDeleteChat.mockResolvedValue(undefined)
  })

  it('preserves local-only chats when their cloud copy was deleted', async () => {
    mockGetDeletedChatsSince.mockResolvedValue({
      deletedIds: ['local-chat', 'cloud-chat'],
    })
    mockGetChat.mockImplementation(async (id: string) => {
      if (id === 'local-chat') return { id, isLocalOnly: true }
      if (id === 'cloud-chat') return { id, isLocalOnly: false }
      return null
    })

    await syncRemoteDeletions('2026-01-01T00:00:00.000Z', 'test')

    expect(mockDeleteChat).toHaveBeenCalledTimes(1)
    expect(mockDeleteChat).toHaveBeenCalledWith('cloud-chat')
    expect(mockMarkAsDeleted).toHaveBeenCalledTimes(1)
    expect(mockMarkAsDeleted).toHaveBeenCalledWith('cloud-chat')
    expect(mockEmit).toHaveBeenCalledWith({
      reason: 'sync',
      ids: ['cloud-chat'],
    })
  })

  it('skips chats already absent locally so repeated passes are event-free', async () => {
    mockGetDeletedChatsSince.mockResolvedValue({
      deletedIds: ['already-gone'],
    })
    mockGetChat.mockResolvedValue(null)

    await syncRemoteDeletions('2026-01-01T00:00:00.000Z', 'test')

    expect(mockDeleteChat).not.toHaveBeenCalled()
    expect(mockMarkAsDeleted).not.toHaveBeenCalled()
    expect(mockEmit).not.toHaveBeenCalled()
  })
})
