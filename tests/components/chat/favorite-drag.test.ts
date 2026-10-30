import { consumeFavoriteDrop } from '@/components/chat/favorite-drag'
import { describe, expect, it, vi } from 'vitest'

describe('consumeFavoriteDrop', () => {
  it('leaves stale favorite sources for other drop handlers', () => {
    const onRemoveFavorite = vi.fn()

    expect(
      consumeFavoriteDrop({
        source: 'favorites',
        chatId: 'chat-a',
        pinnedChatIds: [],
        onRemoveFavorite,
      }),
    ).toBe(false)
    expect(onRemoveFavorite).not.toHaveBeenCalled()
  })
})
