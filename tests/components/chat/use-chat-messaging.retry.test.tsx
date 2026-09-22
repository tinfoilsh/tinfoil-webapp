import { ArtifactRetryError } from '@/components/chat/genui/retry'
import { useChatMessaging } from '@/components/chat/hooks/use-chat-messaging'
import type { Chat, Message } from '@/components/chat/types'
import type { BaseModel } from '@/config/models'
import { chatStorage } from '@/services/storage/chat-storage'
import { act, renderHook, waitFor } from '@testing-library/react'
import { type Dispatch, type SetStateAction, useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const abortMock = vi.fn()
const patchStatusMock = vi.fn()
const resetStatusMock = vi.fn()
const moveStatusMock = vi.fn()
const registerControllerMock = vi.fn()
const clearControllerMock = vi.fn()
const { regenerateToolCallArgumentsMock } = vi.hoisted(() => ({
  regenerateToolCallArgumentsMock: vi.fn(),
}))

vi.mock('@/components/chat/genui/retry', async () => {
  const actual = await vi.importActual<
    typeof import('@/components/chat/genui/retry')
  >('@/components/chat/genui/retry')
  return {
    ...actual,
    regenerateToolCallArguments: regenerateToolCallArgumentsMock,
  }
})

vi.mock('@clerk/react', () => ({
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
    beginPendingStream: vi.fn(),
    endPendingStream: vi.fn(),
    isStreamingOrPending: vi.fn(() => false),
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
      ownsController: () => true,
      hasActiveController: () => false,
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
  snapshotAndDecrementRemaining: vi.fn(),
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
    saveStreamingDraft: vi.fn(),
    clearStreamingDraft: vi.fn(),
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
        models: [{ modelName: 'test-model' } as BaseModel],
        selectedModel: 'test-model',
        chats: [chat],
        currentChat: chat,
        setChats: noopSetChats,
        setCurrentChat: noopSetCurrentChat,
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

  it('preserves typed artifact retry failures for the renderer', async () => {
    const chat = createChatWithUserMessage('chat-a')
    const timestamp = new Date()
    chat.messages.push({
      role: 'assistant',
      content: '',
      timestamp,
      timeline: [
        {
          type: 'tool_call',
          id: 'block-1',
          toolCallId: 'call-1',
          name: 'render_chart',
          arguments: '{"type":"bar"',
        },
      ],
      toolCalls: [
        {
          id: 'call-1',
          name: 'render_chart',
          arguments: '{"type":"bar"',
        },
      ],
    })
    const retryError = new ArtifactRetryError('incomplete_replacement')
    regenerateToolCallArgumentsMock.mockRejectedValueOnce(retryError)
    const model = { modelName: 'gpt-oss-120b' } as BaseModel

    const { result } = renderHook(() =>
      useChatMessaging({
        systemPrompt: '',
        storeHistory: false,
        models: [model],
        selectedModel: model.modelName,
        chats: [chat],
        currentChat: chat,
        setChats: noopSetChats,
        setCurrentChat: noopSetCurrentChat,
      }),
    )

    await act(async () => {
      await expect(result.current.retryToolCall(1, 'call-1')).rejects.toBe(
        retryError,
      )
    })
  })

  it('persists concurrent widget repairs from the latest composed chat', async () => {
    const chat = createChatWithUserMessage('chat-a')
    chat.messages.push({
      role: 'assistant',
      content: '',
      timestamp: new Date(),
      turnId: 'turn-1',
      timeline: [
        {
          type: 'tool_call',
          id: 'block-1',
          toolCallId: 'call-1',
          name: 'render_chart',
          arguments: '{"type":"bar"',
        },
        {
          type: 'tool_call',
          id: 'block-2',
          toolCallId: 'call-2',
          name: 'render_stat_cards',
          arguments: '{"stats":',
        },
      ],
      toolCalls: [
        {
          id: 'call-1',
          name: 'render_chart',
          arguments: '{"type":"bar"',
        },
        {
          id: 'call-2',
          name: 'render_stat_cards',
          arguments: '{"stats":',
        },
      ],
    })
    regenerateToolCallArgumentsMock.mockImplementation(
      ({ toolName }: { toolName: string }) =>
        Promise.resolve(
          toolName === 'render_chart'
            ? '{"type":"bar","data":[]}'
            : '{"stats":[]}',
        ),
    )
    let releaseFirstSave: (() => void) | undefined
    vi.mocked(chatStorage.saveChatAndSync)
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            releaseFirstSave = resolve
          }),
      )
      .mockResolvedValue(undefined)
    const model = { modelName: 'gpt-oss-120b' } as BaseModel

    const { result } = renderHook(() => {
      const [chats, setChats] = useState([chat])
      const [currentChat, setCurrentChat] = useState(chat)
      return useChatMessaging({
        systemPrompt: '',
        storeHistory: true,
        models: [model],
        selectedModel: model.modelName,
        chats,
        currentChat,
        setChats,
        setCurrentChat,
      })
    })

    let firstRetry!: Promise<boolean>
    act(() => {
      firstRetry = result.current.retryToolCall(1, 'call-1')
    })
    await waitFor(() =>
      expect(chatStorage.saveChatAndSync).toHaveBeenCalledTimes(1),
    )

    let secondRetry!: Promise<boolean>
    act(() => {
      secondRetry = result.current.retryToolCall(1, 'call-2')
    })
    releaseFirstSave?.()
    await act(async () => {
      await Promise.all([firstRetry, secondRetry])
    })

    await waitFor(() =>
      expect(chatStorage.saveChatAndSync).toHaveBeenCalledTimes(2),
    )
    const latestSavedChat = vi.mocked(chatStorage.saveChatAndSync).mock
      .calls[1][0]
    expect(latestSavedChat.messages[1].toolCalls).toEqual([
      expect.objectContaining({ arguments: '{"type":"bar","data":[]}' }),
      expect.objectContaining({ arguments: '{"stats":[]}' }),
    ])
  })
})
