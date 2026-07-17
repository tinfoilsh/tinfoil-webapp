import {
  ingestRemoteChats,
  syncRemoteDeletions,
} from '@/services/cloud/chat-ingestion'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockGetDeletedChatsSince = vi.fn()
const mockGetChat = vi.fn()
const mockDeleteChatIfUnchanged = vi.fn()
const mockApplyRemoteChatIfFresh = vi.fn()
const mockProcessRemoteChat = vi.fn()
const mockIsDeleted = vi.fn()
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
    deleteChatIfUnchanged: (...args: any[]) =>
      mockDeleteChatIfUnchanged(...args),
    applyRemoteChatIfFresh: (...args: any[]) =>
      mockApplyRemoteChatIfFresh(...args),
  },
}))

vi.mock('@/services/storage/deleted-chats-tracker', () => ({
  deletedChatsTracker: {
    markAsDeleted: (...args: any[]) => mockMarkAsDeleted(...args),
    isDeleted: (...args: any[]) => mockIsDeleted(...args),
  },
}))

vi.mock('@/services/storage/chat-events', () => ({
  chatEvents: {
    emit: (...args: any[]) => mockEmit(...args),
  },
}))

vi.mock('@/services/cloud/chat-codec', () => ({
  processRemoteChat: (...args: any[]) => mockProcessRemoteChat(...args),
}))

describe('syncRemoteDeletions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDeleteChatIfUnchanged.mockResolvedValue(true)
    mockApplyRemoteChatIfFresh.mockResolvedValue({ applied: true })
    mockIsDeleted.mockReturnValue(false)
  })

  it('preserves local-only chats when their cloud copy was deleted', async () => {
    mockGetDeletedChatsSince.mockResolvedValue({
      deletedIds: ['local-chat', 'cloud-chat'],
    })
    mockGetChat.mockImplementation(async (id: string) => {
      if (id === 'local-chat') return { id, isLocalOnly: true }
      if (id === 'cloud-chat') {
        return {
          id,
          isLocalOnly: false,
          updatedAt: '2026-01-02T00:00:00.000Z',
        }
      }
      return null
    })

    await syncRemoteDeletions('2026-01-01T00:00:00.000Z', 'test')

    expect(mockDeleteChatIfUnchanged).toHaveBeenCalledTimes(1)
    expect(mockDeleteChatIfUnchanged).toHaveBeenCalledWith(
      'cloud-chat',
      '2026-01-02T00:00:00.000Z',
      expect.any(Function),
    )
    expect(mockMarkAsDeleted).toHaveBeenCalledTimes(1)
    expect(mockMarkAsDeleted).toHaveBeenCalledWith('cloud-chat')
    expect(mockEmit).toHaveBeenCalledWith({
      reason: 'sync',
      ids: ['cloud-chat'],
    })
  })

  it('records the tombstone for chats already absent locally without emitting', async () => {
    mockGetDeletedChatsSince.mockResolvedValue({
      deletedIds: ['already-gone'],
    })
    mockGetChat.mockResolvedValue(null)

    await syncRemoteDeletions('2026-01-01T00:00:00.000Z', 'test')

    expect(mockDeleteChatIfUnchanged).not.toHaveBeenCalled()
    expect(mockMarkAsDeleted).toHaveBeenCalledWith('already-gone')
    expect(mockEmit).not.toHaveBeenCalled()
  })

  it('does not apply deletions after the account generation changes', async () => {
    let current = true
    mockGetDeletedChatsSince.mockImplementation(async () => {
      current = false
      return { deletedIds: ['old-account-chat'] }
    })

    await syncRemoteDeletions('2026-01-01T00:00:00.000Z', 'test', () => current)

    expect(mockGetChat).not.toHaveBeenCalled()
    expect(mockDeleteChatIfUnchanged).not.toHaveBeenCalled()
    expect(mockEmit).not.toHaveBeenCalled()
  })

  it('does not publish a deletion after the account generation changes', async () => {
    let current = true
    mockGetDeletedChatsSince.mockResolvedValue({
      deletedIds: ['old-account-chat'],
    })
    mockGetChat.mockResolvedValue({
      id: 'old-account-chat',
      isLocalOnly: false,
      updatedAt: '2026-01-02T00:00:00.000Z',
    })
    mockDeleteChatIfUnchanged.mockImplementation(async () => {
      current = false
      return true
    })

    await syncRemoteDeletions('2026-01-01T00:00:00.000Z', 'test', () => current)

    expect(mockMarkAsDeleted).not.toHaveBeenCalled()
    expect(mockEmit).not.toHaveBeenCalled()
  })

  it('does not emit earlier deletions after a later iteration is invalidated', async () => {
    let current = true
    mockGetDeletedChatsSince.mockResolvedValue({
      deletedIds: ['deleted-chat', 'stale-chat'],
    })
    mockGetChat.mockResolvedValue({
      isLocalOnly: false,
      updatedAt: '2026-01-02T00:00:00.000Z',
    })
    mockDeleteChatIfUnchanged
      .mockResolvedValueOnce(true)
      .mockImplementationOnce(async () => {
        current = false
        return false
      })

    await syncRemoteDeletions('2026-01-01T00:00:00.000Z', 'test', () => current)

    expect(mockMarkAsDeleted).toHaveBeenCalledWith('deleted-chat')
    expect(mockEmit).not.toHaveBeenCalled()
  })
})

describe('ingestRemoteChats', () => {
  it('carries the generation predicate into the queued storage write', async () => {
    const isCurrent = vi.fn(() => true)
    mockGetChat.mockResolvedValue(null)
    mockProcessRemoteChat.mockResolvedValue({
      chat: {
        id: 'remote-chat',
        title: 'Remote',
        messages: [{ role: 'user', content: 'hello' }],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
        syncVersion: 3,
      },
    })
    mockApplyRemoteChatIfFresh.mockResolvedValue({ applied: true })

    await ingestRemoteChats(
      [
        {
          id: 'remote-chat',
          content: 'encoded',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-02T00:00:00.000Z',
          syncVersion: 3,
        },
      ],
      { isCurrent },
    )

    expect(mockApplyRemoteChatIfFresh).toHaveBeenCalledWith(
      expect.objectContaining({ isCurrent }),
    )
  })
})
