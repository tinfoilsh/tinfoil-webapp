import {
  canToggleTemporaryChat,
  resolveWebSearchEnabled,
} from '@/components/chat/hooks/chat-operations'
import type { Chat } from '@/components/chat/types'
import { describe, expect, it } from 'vitest'

const createChat = (overrides: Partial<Chat> = {}): Chat => ({
  id: 'chat-1',
  title: 'Chat',
  messages: [],
  createdAt: new Date(),
  ...overrides,
})

describe('canToggleTemporaryChat', () => {
  it('allows temporary mode for a new blank chat', () => {
    expect(canToggleTemporaryChat(createChat({ isBlankChat: true }))).toBe(true)
  })

  it('hides temporary mode for an existing chat', () => {
    expect(canToggleTemporaryChat(createChat({ isBlankChat: false }))).toBe(
      false,
    )
  })

  it('hides temporary mode for legacy existing chats without a blank flag', () => {
    expect(canToggleTemporaryChat(createChat())).toBe(false)
  })

  it('shows the temporary mode toggle for an active temporary chat', () => {
    expect(
      canToggleTemporaryChat(
        createChat({ isBlankChat: false, isTemporary: true }),
      ),
    ).toBe(true)
  })
})

describe('resolveWebSearchEnabled', () => {
  it('enables web search by default when it is available', () => {
    expect(resolveWebSearchEnabled(true)).toBe(true)
  })

  it('preserves an existing chat override', () => {
    expect(resolveWebSearchEnabled(true, false)).toBe(false)
  })

  it('disables web search when it is unavailable', () => {
    expect(resolveWebSearchEnabled(false, true)).toBe(false)
  })
})
