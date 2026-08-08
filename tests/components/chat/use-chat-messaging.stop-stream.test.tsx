import { useChatMessaging } from '@/components/chat/hooks/use-chat-messaging'
import type { Chat } from '@/components/chat/types'
import type {
  ChatChunk,
  ChatChunkStream,
} from '@/services/inference/chat-stream'
import { act, renderHook } from '@testing-library/react'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  authState,
  cancelChatRecoveryMock,
  completeLiveChatRecoveryMock,
  containerAuthTokenMock,
  generateTitleMock,
  initialSaveMock,
  persistInterruptedAssistantMock,
  saveChatMock,
  sendChatStreamMock,
  sessionGetAllChatsMock,
  sessionSaveMock,
  pendingStreams,
  streamControllers,
  streamingChats,
  recoveryAvailableState,
} = vi.hoisted(() => ({
  authState: {
    isSignedIn: false,
    userId: undefined as string | undefined,
  },
  cancelChatRecoveryMock: vi.fn(async (..._args: unknown[]) => false),
  completeLiveChatRecoveryMock: vi.fn(
    async (...args: unknown[]): Promise<Chat> => {
      const input = args[0] as {
        chatId: string
        assistantMessage: Chat['messages'][number]
        chatPatch?: Partial<Chat>
      }
      return {
        id: input.chatId,
        title: input.chatPatch?.title ?? 'Untitled',
        titleState: input.chatPatch?.titleState ?? 'placeholder',
        createdAt: new Date(),
        messages: [input.assistantMessage],
        isBlankChat: false,
      }
    },
  ),
  containerAuthTokenMock: vi.fn(async (..._args: unknown[]) => null),
  generateTitleMock: vi.fn(async () => 'Untitled'),
  initialSaveMock: vi.fn(async (chat: unknown) => chat),
  persistInterruptedAssistantMock: vi.fn(
    async (..._args: unknown[]) => undefined,
  ),
  saveChatMock: vi.fn(async (chat: unknown) => chat),
  sendChatStreamMock: vi.fn(),
  sessionGetAllChatsMock: vi.fn(() => [] as Chat[]),
  sessionSaveMock: vi.fn(),
  pendingStreams: new Set<string>(),
  streamControllers: new Map<string, AbortController>(),
  streamingChats: new Set<string>(),
  recoveryAvailableState: { available: false },
}))

vi.mock('@clerk/nextjs', () => ({
  useAuth: () => authState,
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
    patchStatus: vi.fn(),
    resetStatus: vi.fn(),
    moveStatus: (fromId: string, toId: string) => {
      const controller = streamControllers.get(fromId)
      if (controller) {
        streamControllers.delete(fromId)
        streamControllers.set(toId, controller)
      }
    },
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
  cancelChatRecovery: (...args: unknown[]) => cancelChatRecoveryMock(...args),
  completeLiveChatRecovery: (...args: unknown[]) =>
    completeLiveChatRecoveryMock(...args),
  markChatRecoveryTurnCancelled: vi.fn(),
  persistChatRecoveryToken: vi.fn(),
  releaseActiveChatRecovery: vi.fn(),
  scanPendingChatRecoveries: vi.fn(),
  startChatRecoveryAttempt: vi.fn(),
}))

vi.mock('@/services/inference/inference-client', () => ({
  sendChatStream: (...args: unknown[]) => sendChatStreamMock(...args),
}))

vi.mock('@/services/inference/chat-recovery-sync', () => ({
  persistInterruptedAssistant: (...args: unknown[]) =>
    persistInterruptedAssistantMock(...args),
}))

vi.mock('@/services/inference/tinfoil-client', () => ({
  getRateLimitInfo: () => null,
  isChatRecoveryAvailable: () => recoveryAvailableState.available,
  refreshRateLimit: vi.fn(),
}))

vi.mock('@/services/inference/title', () => ({
  generateTitle: generateTitleMock,
  getTitleContent: (message: { content: string }) => message.content,
}))

vi.mock('@/services/storage/chat-storage', () => ({
  chatStorage: {
    saveChat: saveChatMock,
    saveChatAndSync: initialSaveMock,
    saveChatAndWaitForSync: vi.fn(async (chat) => chat),
  },
}))

vi.mock('@/services/storage/session-storage', () => ({
  sessionChatStorage: {
    getAllChats: sessionGetAllChatsMock,
    saveChat: sessionSaveMock,
  },
}))

vi.mock('@/services/exec-snapshot/access-token', () => ({
  generateCodeExecutionAccessToken: () => 'token',
}))

vi.mock('@/services/exec-snapshot/use-exec-snapshot', () => ({
  getCodeExecutionContainerAuthTokenForChat: (...args: unknown[]) =>
    containerAuthTokenMock(...args),
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

describe('useChatMessaging stopped streams', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    initialSaveMock.mockImplementation(async (chat: unknown) => chat)
    persistInterruptedAssistantMock.mockResolvedValue(undefined)
    containerAuthTokenMock.mockResolvedValue(null)
    generateTitleMock.mockResolvedValue('Untitled')
    sessionGetAllChatsMock.mockReturnValue([])
    authState.isSignedIn = false
    authState.userId = undefined
    recoveryAvailableState.available = false
    streamControllers.clear()
    streamingChats.clear()
    pendingStreams.clear()
  })

  it('keeps and persists the assistant response at the stop point', async () => {
    const initialChat: Chat = {
      id: 'chat-1',
      title: 'Existing chat',
      createdAt: new Date(),
      messages: [
        { role: 'user', content: 'Earlier', timestamp: new Date() },
        { role: 'assistant', content: 'Earlier reply', timestamp: new Date() },
      ],
    }
    const stream = createOpenStream()
    sendChatStreamMock.mockResolvedValue(stream.stream)

    const { result } = renderHook(() => {
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

    let query!: Promise<unknown>
    act(() => {
      query = result.current.messaging.handleQuery(
        'New prompt',
      ) as Promise<unknown>
    })
    await vi.waitFor(() => expect(sendChatStreamMock).toHaveBeenCalled())

    stream.send({
      choices: [{ delta: { reasoning_content: 'Partial reasoning' } }],
    })
    await vi.waitFor(() =>
      expect(result.current.currentChat.messages.at(-1)?.thoughts).toBe(
        'Partial reasoning',
      ),
    )

    await act(async () => {
      await result.current.messaging.cancelGeneration()
    })
    stream.close()
    await act(async () => {
      await query
    })

    const stoppedMessage = result.current.currentChat.messages.at(-1)
    expect(stoppedMessage).toMatchObject({
      role: 'assistant',
      thoughts: 'Partial reasoning',
      isThinking: false,
      turnId: expect.any(String),
    })
    expect(sessionSaveMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: 'assistant',
            thoughts: 'Partial reasoning',
            isThinking: false,
            turnId: expect.any(String),
          }),
        ]),
      }),
    )
    expect(cancelChatRecoveryMock).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({ thoughts: 'Partial reasoning' }),
      expect.any(String),
    )
  })

  it('waits for first-turn persistence before saving the stopped response', async () => {
    const initialChat: Chat = {
      id: '',
      title: 'New chat',
      createdAt: new Date(),
      messages: [],
      isBlankChat: true,
      isLocalOnly: true,
    }
    let finishInitialSave!: () => void
    initialSaveMock.mockImplementationOnce(
      (chat: unknown) =>
        new Promise((resolve) => {
          finishInitialSave = () => resolve(chat)
        }),
    )
    const stream = createOpenStream()
    sendChatStreamMock.mockResolvedValue(stream.stream)

    const { result } = renderHook(() => {
      const [currentChat, setCurrentChat] = useState(initialChat)
      const [chats, setChats] = useState([initialChat])
      const messaging = useChatMessaging({
        systemPrompt: '',
        storeHistory: true,
        models: [{} as never],
        selectedModel: 'test-model',
        chats,
        currentChat,
        setChats,
        setCurrentChat,
      })
      return { currentChat, messaging }
    })

    let query!: Promise<unknown>
    act(() => {
      query = result.current.messaging.handleQuery(
        'First prompt',
      ) as Promise<unknown>
    })
    await vi.waitFor(() => expect(sendChatStreamMock).toHaveBeenCalled())
    stream.send({ choices: [{ delta: { content: 'Partial answer' } }] })
    await vi.waitFor(() =>
      expect(result.current.currentChat.messages.at(-1)?.content).toBe(
        'Partial answer',
      ),
    )

    let cancellation!: Promise<void>
    act(() => {
      cancellation = result.current.messaging.cancelGeneration()
    })
    await Promise.resolve()
    expect(persistInterruptedAssistantMock).not.toHaveBeenCalled()

    finishInitialSave()
    await act(async () => {
      await cancellation
    })

    expect(persistInterruptedAssistantMock).toHaveBeenCalledWith(
      result.current.currentChat.id,
      expect.any(String),
      expect.objectContaining({ content: 'Partial answer' }),
    )

    stream.close()
    await act(async () => {
      await query
    })
  })

  it('preserves a successor prompt while cancellation persistence finishes', async () => {
    let finishRecoveryCancellation!: (persisted: boolean) => void
    cancelChatRecoveryMock.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          finishRecoveryCancellation = resolve
        }),
    )
    const initialChat: Chat = {
      id: 'chat-1',
      title: 'Existing chat',
      createdAt: new Date(),
      messages: [],
    }
    const stream = createOpenStream()
    sendChatStreamMock.mockResolvedValue(stream.stream)

    const { result } = renderHook(() => {
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

    let query!: Promise<unknown>
    act(() => {
      query = result.current.messaging.handleQuery(
        'First prompt',
      ) as Promise<unknown>
    })
    await vi.waitFor(() => expect(sendChatStreamMock).toHaveBeenCalled())
    stream.send({ choices: [{ delta: { content: 'Partial answer' } }] })
    await vi.waitFor(() =>
      expect(result.current.currentChat.messages.at(-1)?.content).toBe(
        'Partial answer',
      ),
    )

    let cancellation!: Promise<void>
    act(() => {
      cancellation = result.current.messaging.cancelGeneration()
    })
    await vi.waitFor(() => expect(cancelChatRecoveryMock).toHaveBeenCalled())
    const successorMessage: Chat['messages'][number] = {
      role: 'user',
      content: 'Successor prompt',
      timestamp: new Date(),
      turnId: 'turn-2',
    }
    sessionGetAllChatsMock.mockReturnValue([
      {
        ...result.current.currentChat,
        messages: [...result.current.currentChat.messages, successorMessage],
      },
    ])

    finishRecoveryCancellation(false)
    await act(async () => {
      await cancellation
    })

    expect(sessionSaveMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({ content: 'Partial answer' }),
          expect.objectContaining({ content: 'Successor prompt' }),
        ]),
      }),
    )

    stream.close()
    await act(async () => {
      await query
    })
  })

  it('does not start stream tracking after pre-stream cancellation', async () => {
    const initialChat: Chat = {
      id: 'chat-1',
      title: 'Existing chat',
      createdAt: new Date(),
      messages: [
        { role: 'user', content: 'Earlier', timestamp: new Date() },
        { role: 'assistant', content: 'Earlier reply', timestamp: new Date() },
      ],
    }
    let finishContainerAuth!: () => void
    containerAuthTokenMock.mockImplementationOnce(
      () =>
        new Promise<null>((resolve) => {
          finishContainerAuth = () => resolve(null)
        }),
    )

    const { result } = renderHook(() => {
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
        codeExecutionEnabled: true,
      })
      return { messaging }
    })

    let query!: Promise<unknown>
    act(() => {
      query = result.current.messaging.handleQuery(
        'New prompt',
      ) as Promise<unknown>
    })
    await vi.waitFor(() => expect(containerAuthTokenMock).toHaveBeenCalled())

    await act(async () => {
      await result.current.messaging.cancelGeneration()
    })
    finishContainerAuth()
    await act(async () => {
      await query
    })

    expect(sendChatStreamMock).not.toHaveBeenCalled()
    expect(streamingChats).toEqual(new Set())
    expect(pendingStreams).toEqual(new Set())
  })

  it('keeps a temporary chat identity and live metadata when saved mid-stream', async () => {
    const temporaryChat: Chat = {
      id: '0000000000001_12345678-1234-4234-8234-123456789abc',
      title: 'Temporary Chat',
      titleState: 'placeholder',
      createdAt: new Date(),
      messages: [],
      isBlankChat: true,
      isTemporary: true,
    }
    const stream = createOpenStream()
    sendChatStreamMock.mockResolvedValue(stream.stream)

    const { result } = renderHook(() => {
      const [currentChat, setCurrentChat] = useState(temporaryChat)
      const [chats, setChats] = useState<Chat[]>([])
      const messaging = useChatMessaging({
        systemPrompt: '',
        storeHistory: true,
        models: [{} as never],
        selectedModel: 'test-model',
        chats,
        currentChat,
        setChats,
        setCurrentChat,
        codeExecutionEnabled: true,
      })
      return { chats, currentChat, messaging, setChats, setCurrentChat }
    })

    let query!: Promise<unknown>
    act(() => {
      query = result.current.messaging.handleQuery(
        'First prompt',
      ) as Promise<unknown>
    })
    await vi.waitFor(() => expect(sendChatStreamMock).toHaveBeenCalled())
    expect(sendChatStreamMock).toHaveBeenCalledWith(
      expect.objectContaining({ codeExecutionAccessToken: 'token' }),
    )
    stream.send({ choices: [{ delta: { content: 'Partial' } }] })
    await vi.waitFor(() =>
      expect(result.current.currentChat.messages.at(-1)?.content).toBe(
        'Partial',
      ),
    )

    const stableId = result.current.currentChat.id
    act(() => {
      const permanentChat = {
        ...result.current.currentChat,
        title: 'Saved while streaming',
        titleState: 'manual' as const,
        isTemporary: false,
        webSearchEnabled: false,
      }
      result.current.setCurrentChat(permanentChat)
      result.current.setChats((previous) => [
        permanentChat,
        ...previous.filter((chat) => chat.id !== stableId),
      ])
    })

    stream.send({ choices: [{ delta: { content: ' response' } }] })
    await vi.waitFor(() => {
      expect(result.current.currentChat.messages.at(-1)?.content).toBe(
        'Partial response',
      )
      expect(result.current.currentChat.isTemporary).toBe(false)
    })
    stream.send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
    stream.close()
    await act(async () => {
      await query
    })

    expect(result.current.currentChat.id).toBe(stableId)
    expect(result.current.chats).toHaveLength(1)
    expect(result.current.currentChat).toMatchObject({
      title: 'Saved while streaming',
      titleState: 'manual',
      isTemporary: false,
      webSearchEnabled: false,
    })
    expect(saveChatMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: stableId,
        title: 'Saved while streaming',
        titleState: 'manual',
        isTemporary: false,
        webSearchEnabled: false,
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: 'assistant',
            content: 'Partial response',
          }),
        ]),
      }),
      expect.any(Boolean),
    )
  })

  it('applies a generated title after recovery completes', async () => {
    authState.isSignedIn = true
    authState.userId = 'user-1'
    recoveryAvailableState.available = true
    generateTitleMock.mockResolvedValue('Generated title')
    const remotelyMergedMessage: Chat['messages'][number] = {
      role: 'user',
      content: 'Merged on another device',
      timestamp: new Date(),
    }
    completeLiveChatRecoveryMock.mockImplementationOnce(
      async (...args: unknown[]) => {
        const input = args[0] as {
          chatId: string
          assistantMessage: Chat['messages'][number]
        }
        return {
          id: input.chatId,
          title: 'Generated title',
          titleState: 'generated',
          createdAt: new Date(),
          messages: [remotelyMergedMessage, input.assistantMessage],
          isBlankChat: false,
        }
      },
    )
    const initialChat: Chat = {
      id: '',
      title: 'Untitled',
      titleState: 'placeholder',
      createdAt: new Date(),
      messages: [],
      isBlankChat: true,
    }
    const stream = createOpenStream()
    sendChatStreamMock.mockResolvedValue(stream.stream)

    const { result } = renderHook(() => {
      const [currentChat, setCurrentChat] = useState(initialChat)
      const [chats, setChats] = useState([initialChat])
      const messaging = useChatMessaging({
        systemPrompt: '',
        storeHistory: true,
        models: [{} as never],
        selectedModel: 'test-model',
        chats,
        currentChat,
        setChats,
        setCurrentChat,
      })
      return { currentChat, messaging }
    })

    let query!: Promise<unknown>
    act(() => {
      query = result.current.messaging.handleQuery(
        'First prompt',
      ) as Promise<unknown>
    })
    await vi.waitFor(() => expect(sendChatStreamMock).toHaveBeenCalled())
    stream.send({ choices: [{ delta: { content: 'Complete answer' } }] })
    stream.send({
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    })
    stream.close()

    await act(async () => {
      await query
    })

    expect(completeLiveChatRecoveryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        chatPatch: expect.objectContaining({ title: 'Generated title' }),
      }),
    )
    expect(result.current.currentChat).toMatchObject({
      title: 'Generated title',
      titleState: 'generated',
    })
    expect(result.current.currentChat.messages[0]).toEqual(
      remotelyMergedMessage,
    )
  })

  it('renders response chunks while recovery token persistence is pending', async () => {
    authState.isSignedIn = true
    authState.userId = 'user-1'
    recoveryAvailableState.available = true
    const initialChat: Chat = {
      id: 'chat-1',
      title: 'Existing chat',
      createdAt: new Date(),
      messages: [],
    }
    const stream = createOpenStream()
    let finishTokenCapture!: () => void
    ;(stream.stream as ChatChunkStream).recoveryReady = new Promise<void>(
      (resolve) => {
        finishTokenCapture = resolve
      },
    )
    sendChatStreamMock.mockResolvedValue(stream.stream)

    const { result } = renderHook(() => {
      const [currentChat, setCurrentChat] = useState(initialChat)
      const [chats, setChats] = useState([initialChat])
      const messaging = useChatMessaging({
        systemPrompt: '',
        storeHistory: true,
        models: [{} as never],
        selectedModel: 'test-model',
        chats,
        currentChat,
        setChats,
        setCurrentChat,
      })
      return { currentChat, messaging }
    })

    let query!: Promise<unknown>
    act(() => {
      query = result.current.messaging.handleQuery('Prompt') as Promise<unknown>
    })
    await vi.waitFor(() => expect(sendChatStreamMock).toHaveBeenCalled())
    stream.send({ choices: [{ delta: { content: 'Visible immediately' } }] })

    await vi.waitFor(() =>
      expect(result.current.currentChat.messages.at(-1)).toMatchObject({
        role: 'assistant',
        content: 'Visible immediately',
      }),
    )

    stream.send({
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    })
    stream.close()
    await vi.waitFor(() =>
      expect(completeLiveChatRecoveryMock).not.toHaveBeenCalled(),
    )

    await act(async () => {
      finishTokenCapture()
      await query
    })
    expect(completeLiveChatRecoveryMock).toHaveBeenCalledOnce()
  })

  it('stops without waiting for pending recovery token persistence', async () => {
    authState.isSignedIn = true
    authState.userId = 'user-1'
    recoveryAvailableState.available = true
    const initialChat: Chat = {
      id: 'chat-1',
      title: 'Existing chat',
      createdAt: new Date(),
      messages: [],
    }
    const stream = createOpenStream()
    const pendingTokenCapture = new Promise<void>(() => undefined)
    let recoveryWaitStarted = false
    Object.defineProperty(stream.stream, 'recoveryReady', {
      get: () => {
        recoveryWaitStarted = true
        return pendingTokenCapture
      },
    })
    sendChatStreamMock.mockResolvedValue(stream.stream)

    const { result } = renderHook(() => {
      const [currentChat, setCurrentChat] = useState(initialChat)
      const [chats, setChats] = useState([initialChat])
      const messaging = useChatMessaging({
        systemPrompt: '',
        storeHistory: true,
        models: [{} as never],
        selectedModel: 'test-model',
        chats,
        currentChat,
        setChats,
        setCurrentChat,
      })
      return { messaging }
    })

    let query!: Promise<unknown>
    act(() => {
      query = result.current.messaging.handleQuery('Prompt') as Promise<unknown>
    })
    await vi.waitFor(() => expect(sendChatStreamMock).toHaveBeenCalled())
    stream.send({ choices: [{ delta: { content: 'Partial response' } }] })
    stream.send({
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    })
    stream.close()
    await vi.waitFor(() => expect(recoveryWaitStarted).toBe(true))

    await act(async () => {
      await result.current.messaging.cancelGeneration()
      await query
    })

    expect(completeLiveChatRecoveryMock).not.toHaveBeenCalled()
  })

  it('falls back to normal persistence when recovery capture is invalidated', async () => {
    authState.isSignedIn = true
    authState.userId = 'user-1'
    recoveryAvailableState.available = true
    const initialChat: Chat = {
      id: 'chat-1',
      title: 'Existing chat',
      createdAt: new Date(),
      messages: [],
    }
    const stream = createOpenStream()
    const recoveryError = new DOMException('Invalidated', 'AbortError')
    const recoveryReady = Promise.reject(recoveryError)
    void recoveryReady.catch(() => undefined)
    ;(stream.stream as ChatChunkStream).recoveryReady = recoveryReady
    ;(stream.stream as ChatChunkStream).abandonRecovery = vi.fn(
      async () => undefined,
    )
    sendChatStreamMock.mockResolvedValue(stream.stream)

    const { result } = renderHook(() => {
      const [currentChat, setCurrentChat] = useState(initialChat)
      const [chats, setChats] = useState([initialChat])
      const messaging = useChatMessaging({
        systemPrompt: '',
        storeHistory: true,
        models: [{} as never],
        selectedModel: 'test-model',
        chats,
        currentChat,
        setChats,
        setCurrentChat,
      })
      return { messaging }
    })

    let query!: Promise<unknown>
    act(() => {
      query = result.current.messaging.handleQuery('Prompt') as Promise<unknown>
    })
    await vi.waitFor(() => expect(sendChatStreamMock).toHaveBeenCalled())
    stream.send({ choices: [{ delta: { content: 'Complete response' } }] })
    stream.send({
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    })
    stream.close()
    await act(async () => {
      await query
    })

    expect(completeLiveChatRecoveryMock).not.toHaveBeenCalled()
    expect(saveChatMock).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({ content: 'Complete response' }),
        ]),
      }),
      false,
    )
  })

  it('preserves a manual title changed during recovery completion', async () => {
    authState.isSignedIn = true
    authState.userId = 'user-1'
    recoveryAvailableState.available = true
    generateTitleMock.mockResolvedValue('Generated title')
    let finishRecovery!: () => void
    completeLiveChatRecoveryMock.mockImplementationOnce(
      (...args: unknown[]) => {
        const input = args[0] as {
          chatId: string
          assistantMessage: Chat['messages'][number]
        }
        return new Promise<Chat>((resolve) => {
          finishRecovery = () =>
            resolve({
              ...initialChat,
              id: input.chatId,
              title: 'Generated title',
              titleState: 'generated',
              messages: [input.assistantMessage],
              isBlankChat: false,
            })
        })
      },
    )
    const initialChat: Chat = {
      id: '',
      title: 'Untitled',
      titleState: 'placeholder',
      createdAt: new Date(),
      messages: [],
      isBlankChat: true,
    }
    const stream = createOpenStream()
    sendChatStreamMock.mockResolvedValue(stream.stream)

    const { result } = renderHook(() => {
      const [currentChat, setCurrentChat] = useState(initialChat)
      const [chats, setChats] = useState([initialChat])
      const messaging = useChatMessaging({
        systemPrompt: '',
        storeHistory: true,
        models: [{} as never],
        selectedModel: 'test-model',
        chats,
        currentChat,
        setChats,
        setCurrentChat,
      })
      return { currentChat, messaging, setCurrentChat }
    })

    let query!: Promise<unknown>
    act(() => {
      query = result.current.messaging.handleQuery(
        'First prompt',
      ) as Promise<unknown>
    })
    await vi.waitFor(() => expect(sendChatStreamMock).toHaveBeenCalled())
    stream.send({ choices: [{ delta: { content: 'Complete answer' } }] })
    stream.send({
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    })
    stream.close()
    await vi.waitFor(() =>
      expect(completeLiveChatRecoveryMock).toHaveBeenCalled(),
    )

    act(() => {
      result.current.setCurrentChat((chat) => ({
        ...chat,
        title: 'Manual title',
        titleState: 'manual',
      }))
    })
    await act(async () => {
      finishRecovery()
      await query
    })

    expect(result.current.currentChat).toMatchObject({
      title: 'Manual title',
      titleState: 'manual',
    })
  })

  it('keeps a completed response when stopped during recovery finalization', async () => {
    authState.isSignedIn = true
    authState.userId = 'user-1'
    recoveryAvailableState.available = true
    cancelChatRecoveryMock.mockRejectedValueOnce(
      new Error('recovery state changed'),
    )
    const initialChat: Chat = {
      id: 'chat-1',
      title: 'Existing chat',
      createdAt: new Date(),
      messages: [
        { role: 'user', content: 'Earlier', timestamp: new Date() },
        { role: 'assistant', content: 'Earlier reply', timestamp: new Date() },
      ],
      isLocalOnly: true,
    }
    const stream = createOpenStream()
    sendChatStreamMock.mockResolvedValue(stream.stream)
    let finishRecovery!: () => void
    completeLiveChatRecoveryMock.mockImplementationOnce(
      (...args: unknown[]) => {
        const input = args[0] as {
          chatId: string
          assistantMessage: Chat['messages'][number]
        }
        return new Promise<Chat>((resolve) => {
          finishRecovery = () =>
            resolve({
              ...initialChat,
              id: input.chatId,
              messages: [...initialChat.messages, input.assistantMessage],
            })
        })
      },
    )

    const { result } = renderHook(() => {
      const [currentChat, setCurrentChat] = useState(initialChat)
      const [chats, setChats] = useState([initialChat])
      const messaging = useChatMessaging({
        systemPrompt: '',
        storeHistory: true,
        models: [{} as never],
        selectedModel: 'test-model',
        chats,
        currentChat,
        setChats,
        setCurrentChat,
      })
      return { currentChat, messaging }
    })

    let query!: Promise<unknown>
    act(() => {
      query = result.current.messaging.handleQuery(
        'New prompt',
      ) as Promise<unknown>
    })
    await vi.waitFor(() => expect(sendChatStreamMock).toHaveBeenCalled())
    stream.send({ choices: [{ delta: { content: 'Complete answer' } }] })
    stream.send({
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    })
    stream.close()
    await vi.waitFor(() =>
      expect(completeLiveChatRecoveryMock).toHaveBeenCalled(),
    )

    await act(async () => {
      await result.current.messaging.cancelGeneration()
    })

    expect(result.current.currentChat.messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: 'Complete answer',
      turnId: expect.any(String),
    })
    expect(cancelChatRecoveryMock).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({ content: 'Complete answer' }),
      expect.any(String),
    )
    expect(persistInterruptedAssistantMock).not.toHaveBeenCalled()

    finishRecovery()
    await act(async () => {
      await query
    })
  })
})
