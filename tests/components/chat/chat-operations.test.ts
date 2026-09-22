import {
  applyPresetSettingsToChat,
  canToggleTemporaryChat,
  createBlankChat,
  createTemporaryChat,
  resolveWebSearchEnabled,
  upsertChatById,
} from '@/components/chat/hooks/chat-operations'
import type { Chat } from '@/components/chat/types'
import type { BaseModel } from '@/config/models'
import {
  USER_PREFS_CUSTOM_PROMPT_PRESETS,
  USER_PREFS_DEFAULT_PROMPT_PRESET_ID,
} from '@/constants/storage-keys'
import { beforeEach, describe, expect, it } from 'vitest'

const chatModel = (modelName: string): BaseModel => ({
  modelName,
  image: '',
  name: modelName,
  nameShort: modelName,
  description: '',
  type: 'chat',
  chat: true,
})

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

  it('carries the default preset model and web search choice onto the chat', () => {
    localStorage.setItem(USER_PREFS_DEFAULT_PROMPT_PRESET_ID, 'user:abc')
    localStorage.setItem(
      USER_PREFS_CUSTOM_PROMPT_PRESETS,
      JSON.stringify([
        {
          id: 'user:abc',
          name: 'Proofreader',
          description: '',
          systemPrompt: '<system>\nFix typos.\n</system>',
          createdAt: 1,
          updatedAt: 1,
          model: 'gpt-oss-120b',
          webSearchEnabled: false,
        },
      ]),
    )

    const chat = createBlankChat()

    expect(chat.model).toBe('gpt-oss-120b')
    expect(chat.webSearchEnabled).toBe(false)
  })

  it('leaves model and web search untouched for a default preset without settings', () => {
    localStorage.setItem(USER_PREFS_DEFAULT_PROMPT_PRESET_ID, 'builtin:tutor')

    const chat = createBlankChat()

    expect(chat.model).toBeUndefined()
    expect(chat.webSearchEnabled).toBeUndefined()
  })
})

describe('applyPresetSettingsToChat', () => {
  const chat = createChat({ model: 'existing-model', webSearchEnabled: true })

  it('returns the chat unchanged when the preset carries no settings', () => {
    expect(applyPresetSettingsToChat(chat, null)).toBe(chat)
    expect(applyPresetSettingsToChat(chat, {})).toEqual(chat)
  })

  it('overrides only the settings the preset defines', () => {
    expect(
      applyPresetSettingsToChat(chat, { webSearchEnabled: false }),
    ).toEqual({ ...chat, webSearchEnabled: false })
    expect(applyPresetSettingsToChat(chat, { model: 'gpt-oss-120b' })).toEqual({
      ...chat,
      model: 'gpt-oss-120b',
    })
  })

  it('skips a model that is not in the catalog', () => {
    const result = applyPresetSettingsToChat(
      chat,
      { model: 'retired-model', webSearchEnabled: false },
      [chatModel('gpt-oss-120b')],
    )

    expect(result.model).toBe('existing-model')
    expect(result.webSearchEnabled).toBe(false)
  })

  it('applies the model when it is in the catalog', () => {
    const result = applyPresetSettingsToChat(chat, { model: 'gpt-oss-120b' }, [
      chatModel('gpt-oss-120b'),
    ])

    expect(result.model).toBe('gpt-oss-120b')
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
