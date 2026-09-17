import {
  canToggleTemporaryChat,
  createBlankChat,
  createTemporaryChat,
  resolveWebSearchEnabled,
  upsertChatById,
} from '@/components/chat/hooks/chat-operations'
import type { Chat } from '@/components/chat/types'
import { USER_PREFS_DEFAULT_PROMPT_PRESET_ID } from '@/constants/storage-keys'
import { beforeEach, describe, expect, it } from 'vitest'

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

describe('createBlankChat', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('starts without a preset when no default is configured', () => {
    expect(createBlankChat().presetId).toBeUndefined()
  })

  it('stamps the configured default preset onto the new chat', () => {
    localStorage.setItem(USER_PREFS_DEFAULT_PROMPT_PRESET_ID, 'user:abc')
    expect(createBlankChat().presetId).toBe('user:abc')
    expect(createBlankChat(true).presetId).toBe('user:abc')
  })
})

describe('createTemporaryChat', () => {
  it('creates a backend-valid stable identity immediately', () => {
    const chat = createTemporaryChat({
      webSearchEnabled: false,
      isLocalOnly: true,
    })

    expect(chat.id).toMatch(/^\d{13}_[0-9a-f-]{36}$/)
    expect(chat).toMatchObject({
      isBlankChat: true,
      isTemporary: true,
      isLocalOnly: true,
      webSearchEnabled: false,
    })
  })
})

describe('upsertChatById', () => {
  it('replaces every stale copy of the same chat identity', () => {
    const replacement = createChat({ title: 'Permanent', isTemporary: false })
    const chats = [
      createChat({ title: 'Temporary', isTemporary: true }),
      createChat({ title: 'Duplicate', isTemporary: true }),
      createChat({ id: 'chat-2' }),
    ]

    const result = upsertChatById(chats, replacement)

    expect(result.filter((chat) => chat.id === replacement.id)).toEqual([
      replacement,
    ])
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
