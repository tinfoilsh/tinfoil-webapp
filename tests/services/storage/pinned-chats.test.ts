import { USER_PREFS_PINNED_CHAT_IDS } from '@/constants/storage-keys'
import {
  addPinnedChatId,
  canRequestChatPin,
  isResolvedFavoriteChat,
  loadPinnedChatIds,
  MAX_PINNED_CHATS,
  normalizePinnedChatIds,
  removePinnedChatIds,
  savePinnedChatIds,
} from '@/services/storage/pinned-chats'
import { beforeEach, describe, expect, it } from 'vitest'

describe('pinned chats storage', () => {
  beforeEach(() => localStorage.clear())

  it('preserves absent and explicit-empty states', () => {
    expect(loadPinnedChatIds()).toBeUndefined()

    savePinnedChatIds([])

    expect(loadPinnedChatIds()).toEqual([])
    expect(localStorage.getItem(USER_PREFS_PINNED_CHAT_IDS)).toBe('[]')
  })

  it('puts the newest pin first, deduplicates, and caps new pins', () => {
    const existing = Array.from(
      { length: MAX_PINNED_CHATS },
      (_, index) => `chat-${index}`,
    )

    expect(addPinnedChatId(existing, 'chat-new')).toEqual([
      'chat-new',
      ...existing.slice(0, MAX_PINNED_CHATS - 1),
    ])
    expect(addPinnedChatId(existing, 'chat-3')).toEqual([
      'chat-3',
      ...existing.slice(0, 3),
      ...existing.slice(4),
    ])
  })

  it('sanitizes malformed ids and removes confirmed deletions', () => {
    expect(
      normalizePinnedChatIds([
        'chat-a',
        '',
        '   ',
        3,
        'chat-a',
        ' chat-b ',
        'chat-b',
      ]),
    ).toEqual(['chat-a', 'chat-b'])
    expect(removePinnedChatIds(['chat-a', 'chat-b'], ['chat-a'])).toEqual([
      'chat-b',
    ])
  })

  it('treats malformed storage as unmanaged without losing explicit clears', () => {
    localStorage.setItem(USER_PREFS_PINNED_CHAT_IDS, '{broken')
    expect(loadPinnedChatIds()).toBeUndefined()

    localStorage.setItem(
      USER_PREFS_PINNED_CHAT_IDS,
      JSON.stringify({ ids: [] }),
    )
    expect(loadPinnedChatIds()).toBeUndefined()

    localStorage.setItem(USER_PREFS_PINNED_CHAT_IDS, '[]')
    expect(loadPinnedChatIds()).toEqual([])
  })

  it('allows local conversion actions but never resolves local or corrupted favorites', () => {
    expect(canRequestChatPin({ id: 'local', isLocalOnly: true })).toBe(true)
    expect(isResolvedFavoriteChat({ id: 'local', isLocalOnly: true })).toBe(
      false,
    )
    expect(canRequestChatPin({ id: 'lost', dataCorrupted: true })).toBe(false)
    expect(isResolvedFavoriteChat({ id: 'lost', dataCorrupted: true })).toBe(
      false,
    )
  })
})
