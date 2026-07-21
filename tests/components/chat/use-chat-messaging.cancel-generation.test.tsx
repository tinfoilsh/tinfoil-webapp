import { useChatMessaging } from '@/components/chat/hooks/use-chat-messaging'
import type { Chat } from '@/components/chat/types'
import { act, renderHook } from '@testing-library/react'
import {
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useLayoutEffect,
} from 'react'
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
  },
}))

vi.mock('@/services/inference/chat-recovery', () => ({
  abandonChatRecoveryAttempt: vi.fn(),
  cancelChatRecovery: vi.fn(async () => undefined),
  completeLiveChatRecovery: vi.fn(),
  persistChatRecoveryToken: vi.fn(),
  releaseActiveChatRecovery: vi.fn(),
  scanPendingChatRecoveries: vi.fn(),
  startChatRecoveryAttempt: vi.fn(),
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

function createChat(id: string): Chat {
  return {
    id,
    title: `Chat ${id}`,
    messages: [],
    createdAt: new Date(),
    isBlankChat: false,
  }
}

const noopSetChats: Dispatch<SetStateAction<Chat[]>> = (_value) => undefined
const noopSetCurrentChat: Dispatch<SetStateAction<Chat>> = (_value) => undefined
const messagesEndRef = { current: null } as RefObject<HTMLDivElement | null>

type HookProps = {
  currentChat: Chat
  triggerCancelOnLayout: boolean
}

function useChatMessagingHarness({
  currentChat,
  triggerCancelOnLayout,
}: HookProps) {
  const messaging = useChatMessaging({
    systemPrompt: '',
    rules: '',
    storeHistory: false,
    models: [],
    selectedModel: 'test-model',
    chats: [currentChat],
    currentChat,
    setChats: noopSetChats,
    setCurrentChat: noopSetCurrentChat,
    messagesEndRef,
  })
  const { cancelGeneration } = messaging

  useLayoutEffect(() => {
    if (triggerCancelOnLayout) {
      void cancelGeneration()
    }
  }, [triggerCancelOnLayout, cancelGeneration])

  return messaging
}

describe('useChatMessaging cancelGeneration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('targets the latest rendered chat during a chat switch', () => {
    const firstChat = createChat('chat-a')
    const secondChat = createChat('chat-b')

    const { rerender } = renderHook(useChatMessagingHarness, {
      initialProps: {
        currentChat: firstChat,
        triggerCancelOnLayout: false,
      },
    })

    act(() => {
      rerender({
        currentChat: secondChat,
        triggerCancelOnLayout: true,
      })
    })

    expect(abortMock).toHaveBeenCalledWith('chat-b')
    expect(patchStatusMock).toHaveBeenCalledWith(
      'chat-b',
      expect.objectContaining({
        loadingState: 'idle',
        retryInfo: null,
        isThinking: false,
        isWaitingForResponse: false,
        isStreaming: false,
      }),
    )
  })
})
