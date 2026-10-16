import { DeletedChatsTracker } from '@/services/storage/deleted-chats-tracker'
import { beforeEach, describe, expect, it } from 'vitest'

describe('DeletedChatsTracker', () => {
  beforeEach(() => {
    sessionStorage.clear()
  })

  it('keeps local tombstones for a tracker loaded later in the session', () => {
    const writer = new DeletedChatsTracker()
    writer.markAsDeleted('chat-1')
    const reader = new DeletedChatsTracker()

    expect(reader.isDeleted('chat-1')).toBe(true)
  })
})
