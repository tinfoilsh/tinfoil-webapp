import { useChatMessaging } from '@/components/chat/hooks/use-chat-messaging'
import type { Chat, Message } from '@/components/chat/types'
import { act, renderHook } from '@testing-library/react'
import { type Dispatch, type RefObject, type SetStateAction } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const abortMock = vi.fn()
const patchStatusMock = vi.fn()
const resetStatusMock = vi.fn()
const moveStatusMock = vi.fn()
const registerControllerMock = vi.fn()
const clearControllerMock = vi.fn()

vi.mock('@clerk/nextjs', () => ({
  useAuth: () => ({
    isSignedIn: false,
  }),
}))

vi.mock('@/components/project', () => ({
  useProject: () => ({
    isProjectMode: false,
    activeProject: null,
  }),
}))

vi.mock('@/services/cloud/streaming-tracker', () => ({
  streamingTracker: {
    isStreaming: vi.fn(() => false),
    endStreaming: vi.fn(),
    startStreaming: vi.fn(),
    onStreamEnd: vi.fn(),
  },
}))

vi.mock('@/components/chat/hooks/use-chat-streams', async () => {
  const actual = await vi.importActual<
    typeof import('@/components/chat/hooks/use-chat-streams')
  >('@/components/chat/hooks/use-chat-streams')

  return {
    ...actual,
    useChatStreams: () => ({
      statusByChat: {},
      patchStatus: patchStatusMock,
      resetStatus: resetStatusMock,
      moveStatus: moveStatusMock,
      registerController: registerControllerMock,
      clearController: clearControllerMock,
      abort: abortMock,
    }),
  }
})

vi.mock('@/services/inference/inference-client', () => ({
  sendChatStream: vi.fn(async function* () {
    yield { type: 'content', text: 'ok' }
  }),
}))

vi.mock('@/services/inference/title', () => ({
  generateTitle: vi.fn(() => Promise.resolve('Title')),
}))

vi.mock('@/services/inference/tinfoil-client', () => ({
  getRateLimitInfo: vi.fn(() => null),
  refreshRateLimit: vi.fn(),
}))

vi.mock('@/services/storage/chat-storage', () => ({
  chatStorage: {
    saveChatAndSync: vi.fn(() => Promise.resolve()),
    saveChat: vi.fn(() => Promise.resolve()),
  },
}))

vi.mock('@/services/storage/session-storage', () => ({
  sessionChatStorage: {
    saveChat: vi.fn(),
  },
}))

vi.mock('@/utils/cloud-sync-settings', () => ({
  isCloudSyncEnabled: vi.fn(() => false),
}))

vi.mock('@/utils/error-handling', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarning: vi.fn(),
}))

vi.mock('@/utils/reverse-id', () => ({
  generateReverseId: vi.fn(() => ({
    id: 'test-id',
    timestamp: Date.now(),
  })),
}))

vi.mock('@/services/exec-snapshot/access-token', () => ({
  generateCodeExecutionAccessToken: vi.fn(() => 'token'),
}))

vi.mock('@/services/exec-snapshot/use-exec-snapshot', () => ({
  getCodeExecutionContainerAuthTokenForChat: vi.fn(() => Promise.resolve(null)),
}))

function createChatWithUserMessage(id: string): Chat {
  const userMessage: Message = {
    role: 'user',
    content: 'Hello',
    timestamp: new Date(),
  }
  return {
    id,
    title: `Chat ${id}`,
    messages: [userMessage],
    createdAt: new Date(),
    isBlankChat: false,
  }
}

const noopSetChats: Dispatch<SetStateAction<Chat[]>> = (_value) => undefined
const noopSetCurrentChat: Dispatch<SetStateAction<Chat>> = (_value) => undefined
const messagesEndRef = { current: null } as RefObject<HTMLDivElement | null>

describe('useChatMessaging retryLastMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('calls handleQuery directly instead of going through regenerateMessage guards', () => {
    const chat = createChatWithUserMessage('chat-a')

    const { result } = renderHook(() =>
      useChatMessaging({
        systemPrompt: '',
        rules: '',
        storeHistory: false,
        models: [],
        selectedModel: 'test-model',
        chats: [chat],
        currentChat: chat,
        setChats: noopSetChats,
        setCurrentChat: noopSetCurrentChat,
        messagesEndRef,
      }),
    )

    act(() => {
      result.current.retryLastMessage()
    })

    expect(patchStatusMock).toHaveBeenCalledWith('chat-a', {
      streamError: null,
    })

    expect(resetStatusMock).toHaveBeenCalledWith('chat-a', {
      loadingState: 'loading',
      isWaitingForResponse: true,
      isStreaming: true,
    })
  })
})
