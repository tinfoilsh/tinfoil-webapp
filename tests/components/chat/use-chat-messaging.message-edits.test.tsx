import { CONSTANTS } from '@/components/chat/constants'
import { useChatMessaging } from '@/components/chat/hooks/use-chat-messaging'
import type { Chat } from '@/components/chat/types'
import type { ChatChunk } from '@/services/inference/chat-stream'
import { act, renderHook } from '@testing-library/react'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  patchStatusMock,
  sendChatStreamMock,
  sessionSaveMock,
  streamControllers,
  streamingChats,
  pendingStreams,
} = vi.hoisted(() => ({
  patchStatusMock: vi.fn(),
  sendChatStreamMock: vi.fn(),
  sessionSaveMock: vi.fn(),
  streamControllers: new Map<string, AbortController>(),
  streamingChats: new Set<string>(),
  pendingStreams: new Set<string>(),
}))

vi.mock('@clerk/nextjs', () => ({
  useAuth: () => ({ isSignedIn: false, userId: undefined }),
}))

vi.mock('@/components/project', () => ({
  useProject: () => ({ isProjectMode: false, activeProject: null }),
}))

vi.mock('@/config/models', () => ({
  getKnownModelDisplayName: () => 'Test Model',
  resolveModelSelection: () => ({
    model: { modelName: 'test-model', name: 'Test Model' },
    autoCandidates: undefined,
  }),
}))

vi.mock('@/services/cloud/streaming-tracker', () => ({
  streamingTracker: {
    startStreaming: (chatId: string) => streamingChats.add(chatId),
    endStreaming: (chatId: string) => streamingChats.delete(chatId),
    isStreaming: (chatId: string) => streamingChats.has(chatId),
    beginPendingStream: (chatId: string) => pendingStreams.add(chatId),
    endPendingStream: (chatId: string) => pendingStreams.delete(chatId),
    isStreamingOrPending: (chatId: string) =>
      streamingChats.has(chatId) || pendingStreams.has(chatId),
  },
}))

vi.mock('@/components/chat/hooks/use-chat-streams', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@/components/chat/hooks/use-chat-streams')
  >()),
  useChatStreams: () => ({
    statusByChat: {},
    patchStatus: patchStatusMock,
    resetStatus: vi.fn(),
    moveStatus: vi.fn(),
    registerController: (chatId: string, controller: AbortController) => {
      streamControllers.set(chatId, controller)
    },
    clearController: (chatId: string, controller: AbortController) => {
      if (streamControllers.get(chatId) === controller) {
        streamControllers.delete(chatId)
      }
    },
    ownsController: (chatId: string, controller: AbortController) =>
      streamControllers.get(chatId) === controller,
    hasActiveController: (chatId: string) => streamControllers.has(chatId),
    abort: (chatId: string) => {
      const controller = streamControllers.get(chatId)
      if (!controller) return false
      controller.abort()
      streamControllers.delete(chatId)
      return true
    },
  }),
}))

vi.mock('@/services/inference/chat-recovery', () => ({
  abandonChatRecoveryAttempt: vi.fn(),
  cancelChatRecovery: vi.fn(async () => false),
  completeLiveChatRecovery: vi.fn(),
  markChatRecoveryTurnCancelled: vi.fn(),
  markChatRecoveryTurnSettled: vi.fn(),
  persistChatRecoveryToken: vi.fn(),
  releaseActiveChatRecovery: vi.fn(),
  scanPendingChatRecoveries: vi.fn(),
  startChatRecoveryAttempt: vi.fn(),
}))

vi.mock('@/services/inference/inference-client', () => ({
  sendChatStream: (...args: unknown[]) => sendChatStreamMock(...args),
}))

vi.mock('@/services/inference/chat-recovery-sync', () => ({
  persistInterruptedAssistant: vi.fn(async () => undefined),
}))

vi.mock('@/services/inference/tinfoil-client', () => ({
  createStreamUsageTracker: () => () => undefined,
  getRateLimitInfo: () => null,
  isChatRecoveryAvailable: () => false,
  refreshRateLimit: vi.fn(),
  snapshotAndDecrementRemaining: vi.fn(),
}))

vi.mock('@/services/inference/title', () => ({
  generateTitle: vi.fn(async () => 'Untitled'),
  getTitleContent: (message: { content: string }) => message.content,
}))

vi.mock('@/services/storage/chat-storage', () => ({
  chatStorage: {
    saveChat: vi.fn(async (chat: unknown) => chat),
    saveChatAndSync: vi.fn(async (chat: unknown) => chat),
  },
}))

vi.mock('@/services/storage/session-storage', () => ({
  sessionChatStorage: {
    getAllChats: vi.fn(() => []),
    saveChat: sessionSaveMock,
    saveStreamingDraft: vi.fn(),
    clearStreamingDraft: vi.fn(),
  },
}))

vi.mock('@/services/exec-snapshot/access-token', () => ({
  generateCodeExecutionAccessToken: () => 'token',
}))

vi.mock('@/services/exec-snapshot/use-exec-snapshot', () => ({
  getCodeExecutionContainerAuthTokenForChat: vi.fn(async () => null),
}))

vi.mock('@/utils/cloud-sync-settings', () => ({
  isCloudSyncEnabled: () => false,
}))

vi.mock('@/utils/error-handling', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarning: vi.fn(),
}))

function createOpenStream() {
  const chunks: ChatChunk[] = []
  let resume: (() => void) | undefined
  let closed = false
  const stream = (async function* () {
    while (!closed || chunks.length > 0) {
      if (chunks.length === 0) {
        await new Promise<void>((resolve) => {
          resume = resolve
        })
        continue
      }
      yield chunks.shift() as ChatChunk
    }
  })()
  return {
    stream,
    send: (event: ChatChunk) => {
      chunks.push(event)
      resume?.()
      resume = undefined
    },
    close: () => {
      closed = true
      resume?.()
    },
  }
}

function makeChat(): Chat {
  return {
    id: 'chat-1',
    title: 'Existing chat',
    createdAt: new Date(),
    messages: [
      { role: 'user', content: 'First question', timestamp: new Date(1) },
      {
        role: 'assistant',
        content: 'First answer',
        timestamp: new Date(2),
        turnId: 'turn-1',
        timeline: [
          { type: 'content', id: 'content-0', content: 'First answer' },
        ],
      },
      { role: 'user', content: 'Second question', timestamp: new Date(3) },
      {
        role: 'assistant',
        content: 'Second answer that got cut',
        timestamp: new Date(4),
        turnId: 'turn-2',
        timeline: [
          {
            type: 'content',
            id: 'content-0',
            content: 'Second answer that got cut',
          },
        ],
      },
    ],
  }
}

function renderMessaging(initialChat: Chat) {
  return renderHook(() => {
    const [currentChat, setCurrentChat] = useState(initialChat)
    const [chats, setChats] = useState([initialChat])
    const messaging = useChatMessaging({
      systemPrompt: '',
      storeHistory: false,
      models: [{} as never],
      selectedModel: 'test-model',
      chats,
      currentChat,
      setChats,
      setCurrentChat,
    })
    return { currentChat, messaging }
  })
}

describe('useChatMessaging message edits', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    streamControllers.clear()
    streamingChats.clear()
    pendingStreams.clear()
  })

  it('deletes a single message and persists the shortened history', () => {
    const { result } = renderMessaging(makeChat())

    act(() => {
      result.current.messaging.deleteMessage(1)
    })

    expect(result.current.currentChat.messages.map((m) => m.content)).toEqual([
      'First question',
      'Second question',
      'Second answer that got cut',
    ])
    expect(sessionSaveMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: 'chat-1',
        messages: expect.not.arrayContaining([
          expect.objectContaining({ content: 'First answer' }),
        ]),
      }),
    )
    expect(sendChatStreamMock).not.toHaveBeenCalled()
  })

  it('rewrites an assistant response in place without touching later messages', () => {
    const { result } = renderMessaging(makeChat())

    act(() => {
      result.current.messaging.editAssistantMessage(1, 'Corrected answer')
    })

    const messages = result.current.currentChat.messages
    expect(messages).toHaveLength(4)
    expect(messages[1]).toMatchObject({
      role: 'assistant',
      content: 'Corrected answer',
      turnId: 'turn-1',
      timeline: [
        { type: 'content', id: 'content-0', content: 'Corrected answer' },
      ],
    })
    expect(messages[3].content).toBe('Second answer that got cut')
    expect(sendChatStreamMock).not.toHaveBeenCalled()
  })

  it('ignores assistant edits aimed at user messages', () => {
    const { result } = renderMessaging(makeChat())

    act(() => {
      result.current.messaging.editAssistantMessage(0, 'nope')
    })

    expect(result.current.currentChat.messages[0].content).toBe(
      'First question',
    )
    expect(sessionSaveMock).not.toHaveBeenCalled()
  })

  it('continues a response by appending streamed text into the same message', async () => {
    const stream = createOpenStream()
    sendChatStreamMock.mockResolvedValue(stream.stream)
    const { result } = renderMessaging(makeChat())

    act(() => {
      result.current.messaging.continueAssistantMessage(3)
    })
    await vi.waitFor(() => expect(sendChatStreamMock).toHaveBeenCalled())

    const request = sendChatStreamMock.mock.calls[0][0] as {
      updatedMessages: Chat['messages']
      trailingInstruction?: string
    }
    expect(request.updatedMessages.map((m) => m.content)).toEqual([
      'First question',
      'First answer',
      'Second question',
      'Second answer that got cut',
    ])
    expect(request.trailingInstruction).toBe(
      CONSTANTS.CONTINUE_RESPONSE_INSTRUCTION,
    )

    stream.send({ choices: [{ delta: { content: ' now complete.' } }] })
    await vi.waitFor(() =>
      expect(result.current.currentChat.messages.at(-1)?.content).toBe(
        'Second answer that got cut now complete.',
      ),
    )
    stream.send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
    stream.close()
    await vi.waitFor(() =>
      expect(patchStatusMock).toHaveBeenCalledWith(
        'chat-1',
        expect.objectContaining({ loadingState: 'idle', isStreaming: false }),
      ),
    )
    // The final save is the last step of the lifecycle.
    await vi.waitFor(() =>
      expect(sessionSaveMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          messages: expect.arrayContaining([
            expect.objectContaining({
              content: 'Second answer that got cut now complete.',
            }),
          ]),
        }),
      ),
    )

    const messages = result.current.currentChat.messages
    expect(messages).toHaveLength(4)
    expect(messages[3]).toMatchObject({
      role: 'assistant',
      content: 'Second answer that got cut now complete.',
      turnId: 'turn-2',
      timeline: [
        {
          type: 'content',
          id: 'content-0',
          content: 'Second answer that got cut now complete.',
        },
      ],
    })
    expect(
      request.updatedMessages.some((m) =>
        m.content.includes(CONSTANTS.CONTINUE_RESPONSE_INSTRUCTION),
      ),
    ).toBe(false)
    expect(
      messages.some((m) =>
        m.content.includes(CONSTANTS.CONTINUE_RESPONSE_INSTRUCTION),
      ),
    ).toBe(false)
  })

  it('drops messages after the continued response', async () => {
    const stream = createOpenStream()
    sendChatStreamMock.mockResolvedValue(stream.stream)
    const { result } = renderMessaging(makeChat())

    act(() => {
      result.current.messaging.continueAssistantMessage(1)
    })
    await vi.waitFor(() => expect(sendChatStreamMock).toHaveBeenCalled())

    const request = sendChatStreamMock.mock.calls[0][0] as {
      updatedMessages: Chat['messages']
    }
    expect(request.updatedMessages.map((m) => m.content)).toEqual([
      'First question',
      'First answer',
    ])
    expect(result.current.currentChat.messages.map((m) => m.content)).toEqual([
      'First question',
      'First answer',
    ])

    stream.send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
    stream.close()
    await vi.waitFor(() =>
      expect(patchStatusMock).toHaveBeenCalledWith(
        'chat-1',
        expect.objectContaining({ loadingState: 'idle', isStreaming: false }),
      ),
    )
  })

  it('refuses to delete the only remaining message', () => {
    const { result } = renderMessaging({
      ...makeChat(),
      messages: [
        { role: 'user', content: 'Only message', timestamp: new Date(1) },
      ],
    })

    act(() => {
      result.current.messaging.deleteMessage(0)
    })

    expect(result.current.currentChat.messages).toHaveLength(1)
    expect(sessionSaveMock).not.toHaveBeenCalled()
  })
})
