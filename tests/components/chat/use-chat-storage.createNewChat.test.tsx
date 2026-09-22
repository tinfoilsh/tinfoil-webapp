import { useChatStorage } from '@/components/chat/hooks/use-chat-storage'
import {
  USER_PREFS_CUSTOM_PROMPT_PRESETS,
  USER_PREFS_DEFAULT_PROMPT_PRESET_ID,
} from '@/constants/storage-keys'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockLoadChats } = vi.hoisted(() => ({
  mockLoadChats: vi.fn(),
}))

vi.mock('@clerk/nextjs', () => ({
  useAuth: () => ({
    isSignedIn: true,
    getToken: vi.fn(),
  }),
}))

vi.mock('@/components/chat/hooks/chat-operations', async () => {
  const actual = await vi.importActual<
    typeof import('@/components/chat/hooks/chat-operations')
  >('@/components/chat/hooks/chat-operations')
  return {
    ...actual,
    loadChats: mockLoadChats,
  }
})

vi.mock('@/services/cloud/streaming-tracker', () => ({
  streamingTracker: {
    isStreaming: vi.fn().mockReturnValue(false),
    isStreamingOrPending: vi.fn().mockReturnValue(false),
  },
}))

vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: vi.fn() }),
}))

const DEFAULT_PRESET = {
  id: 'user:proofreader',
  name: 'Proofreader',
  description: '',
  systemPrompt: '<system>\nFix typos.\n</system>',
  createdAt: 1,
  updatedAt: 1,
  model: 'gpt-oss-120b',
  webSearchEnabled: false,
}

describe('useChatStorage.createNewChat', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    mockLoadChats.mockResolvedValue([])
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('reapplies the default preset settings when reusing a blank chat', async () => {
    localStorage.setItem(
      USER_PREFS_CUSTOM_PROMPT_PRESETS,
      JSON.stringify([DEFAULT_PRESET]),
    )
    localStorage.setItem(USER_PREFS_DEFAULT_PROMPT_PRESET_ID, DEFAULT_PRESET.id)

    const { result } = renderHook(() => useChatStorage({ storeHistory: true }))
    await waitFor(() => expect(result.current.isInitialLoad).toBe(false))

    // Simulate the user overriding both settings on the blank chat.
    act(() => {
      result.current.updateChatModel('other-model')
    })
    act(() => {
      const blank = result.current.currentChat
      const toggled = { ...blank, webSearchEnabled: true }
      result.current.setCurrentChat(toggled)
      result.current.setChats((prev) =>
        prev.map((c) => (c === blank ? toggled : c)),
      )
    })
    expect(result.current.currentChat.model).toBe('other-model')

    act(() => {
      result.current.createNewChat(false)
    })

    expect(result.current.currentChat).toMatchObject({
      isBlankChat: true,
      presetId: DEFAULT_PRESET.id,
      model: DEFAULT_PRESET.model,
      webSearchEnabled: DEFAULT_PRESET.webSearchEnabled,
    })
  })
})
