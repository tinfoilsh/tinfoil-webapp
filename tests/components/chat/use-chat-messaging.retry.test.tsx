import { ArtifactRetryError } from '@/components/chat/genui/retry'
import { useChatMessaging } from '@/components/chat/hooks/use-chat-messaging'
import {
  IDLE_STREAM_STATUS,
  type ChatStreamStatus,
} from '@/components/chat/hooks/use-chat-streams'
import type { Chat, Message } from '@/components/chat/types'
import type { BaseModel } from '@/config/models'
import type { ChatChunk } from '@/services/inference/chat-stream'
import { sendChatStream } from '@/services/inference/inference-client'
import { chatStorage } from '@/services/storage/chat-storage'
import { sessionChatStorage } from '@/services/storage/session-storage'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useState, type Dispatch, type SetStateAction } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const abortMock = vi.fn()
const patchStatusMock = vi.fn()
const resetStatusMock = vi.fn()
const moveStatusMock = vi.fn()
const registerControllerMock = vi.fn()
const clearControllerMock = vi.fn()
const streamStatuses: Record<string, ChatStreamStatus> = {}
const TEST_MODEL: BaseModel = {
  modelName: 'gpt-oss-120b',
  name: 'GPT-OSS',
  nameShort: 'GPT-OSS',
  description: '',
  image: '',
  type: 'chat',
}
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
      statusByChat: streamStatuses,
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
  sendChatStream: vi.fn(async function* (): AsyncGenerator<ChatChunk> {
    yield { choices: [{ delta: { content: 'Retried answer' } }] }
    yield { choices: [{ delta: {}, finish_reason: 'stop' }] }
  }),
}))

vi.mock('@/services/inference/title', () => ({
  generateTitle: vi.fn(() => Promise.resolve('Title')),
}))

vi.mock('@/services/inference/tinfoil-client', () => ({
  createStreamUsageTracker: () => () => undefined,
  getRateLimitInfo: vi.fn(() => null),
  refreshRateLimit: vi.fn(),
  snapshotAndDecrementRemaining: vi.fn(),
}))

vi.mock('@/services/storage/chat-storage', () => ({
  chatStorage: {
    saveChatAndSync: vi.fn(async (chat: Chat) => chat),
    saveChat: vi.fn(async (chat: Chat) => chat),
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
    vi.resetAllMocks()
    for (const chatId of Object.keys(streamStatuses))
      delete streamStatuses[chatId]
  })

  it('calls handleQuery directly instead of going through regenerateMessage guards', async () => {
    const chat = createChatWithUserMessage('chat-a')
    streamStatuses[chat.id] = {
      ...IDLE_STREAM_STATUS,
      loadingState: 'loading',
      isStreaming: true,
    }

    const { result, rerender } = renderHook(() => {
      const [currentChat, setCurrentChat] = useState(chat)
      const [chats, setChats] = useState([chat])
      const messaging = useChatMessaging({
        systemPrompt: '',
        rules: '',
        storeHistory: false,
        models: [TEST_MODEL],
        selectedModel: TEST_MODEL.modelName,
        chats,
        currentChat,
        setChats,
        setCurrentChat,
      })
      return { messaging, currentChat }
    })

    const retryAfterFailure = result.current.messaging.retryLastMessage
    streamStatuses[chat.id] = IDLE_STREAM_STATUS
    rerender()

    act(() => {
      retryAfterFailure()
    })

    expect(patchStatusMock).toHaveBeenCalledWith('chat-a', {
      streamError: null,
    })

    expect(resetStatusMock).toHaveBeenCalledWith('chat-a', {
      loadingState: 'loading',
      isWaitingForResponse: true,
      isStreaming: true,
    })
    await waitFor(() => {
      expect(sessionChatStorage.saveChat).toHaveBeenLastCalledWith(
        expect.objectContaining({
          messages: [
            expect.objectContaining({ role: 'user', content: 'Hello' }),
            expect.objectContaining({
              role: 'assistant',
              content: 'Retried answer',
            }),
          ],
        }),
      )
    })
    expect(sendChatStream).toHaveBeenCalledOnce()
    expect(vi.mocked(sendChatStream).mock.calls[0][0].updatedMessages).toEqual([
      expect.objectContaining({ role: 'user', content: 'Hello' }),
    ])
    expect(
      result.current.currentChat.messages.map(({ content }) => content),
    ).toEqual(['Hello', 'Retried answer'])
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
    const model = TEST_MODEL

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
        (savedChat) =>
          new Promise<Chat>((resolve) => {
            releaseFirstSave = () => resolve(savedChat)
          }),
      )
      .mockImplementation(async (savedChat) => savedChat)
    const model = TEST_MODEL

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
