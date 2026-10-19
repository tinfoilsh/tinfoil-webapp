import { SYNC_DELETED_CHATS } from '@/constants/storage-keys'
import { DeletedChatsTracker } from '@/services/storage/deleted-chats-tracker'
import { beforeEach, describe, expect, it } from 'vitest'

describe('DeletedChatsTracker', () => {
  beforeEach(() => {
    sessionStorage.clear()
  })

  it('keeps a later local deletion when an upsert clears the remote deletion', () => {
    const tracker = new DeletedChatsTracker()
    tracker.markAsRemoteDeleted('chat-1')
    tracker.markAsDeleted('chat-1')

    expect(tracker.removeRemoteDeletion('chat-1')).toBe(false)
    expect(tracker.isDeleted('chat-1')).toBe(true)
  })

  it('keeps legacy string tombstones until an authoritative upsert', () => {
    sessionStorage.setItem(SYNC_DELETED_CHATS, JSON.stringify(['chat-1']))
    const tracker = new DeletedChatsTracker()

    expect(tracker.isDeleted('chat-1')).toBe(true)
    expect(tracker.removeRemoteDeletion('chat-1')).toBe(true)
    expect(tracker.isDeleted('chat-1')).toBe(false)
  })

  it('does not lift persisted source-aware local tombstones', () => {
    const writer = new DeletedChatsTracker()
    writer.markAsDeleted('chat-1')
    const reader = new DeletedChatsTracker()

    expect(reader.isDeleted('chat-1')).toBe(true)
    expect(reader.removeRemoteDeletion('chat-1')).toBe(false)
    expect(reader.isDeleted('chat-1')).toBe(true)
  })

  it('keeps a remote tombstone when a local deletion rolls back', () => {
    const tracker = new DeletedChatsTracker()
    tracker.markAsRemoteDeleted('chat-1')
    tracker.markAsDeleted('chat-1')

    expect(tracker.removeLocalDeletion('chat-1')).toBe(true)
    expect(tracker.isDeleted('chat-1')).toBe(true)
    expect(tracker.removeRemoteDeletion('chat-1')).toBe(true)
    expect(tracker.isDeleted('chat-1')).toBe(false)
  })
})
