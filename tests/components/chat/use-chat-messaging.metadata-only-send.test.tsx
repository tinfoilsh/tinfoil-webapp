import { useChatMessaging } from '@/components/chat/hooks/use-chat-messaging'
import { useMessageQueue } from '@/components/chat/hooks/use-message-queue'
import type { Chat } from '@/components/chat/types'
import { UrlHashMessageHandler } from '@/components/url-hash-message-handler'
import type { ChatChunk } from '@/services/inference/chat-stream'
import { sessionChatStorage } from '@/services/storage/session-storage'
import {
  act,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react'
import { StrictMode, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  getChatMock,
  saveChatMock,
  saveExistingChatMock,
  saveChatAndSyncMock,
  sendChatStreamMock,
  isDeletedMock,
} = vi.hoisted(() => ({
  getChatMock: vi.fn(async (_id: unknown) => null as unknown),
  saveChatMock: vi.fn(async (chat: unknown, _skip?: unknown) => chat),
  saveExistingChatMock: vi.fn(async (chat: unknown, _skip?: unknown) => chat),
  saveChatAndSyncMock: vi.fn(async (chat: unknown) => chat),
  sendChatStreamMock: vi.fn(),
  isDeletedMock: vi.fn(() => false),
}))

vi.mock('@clerk/react', () => ({
  useAuth: () => ({ isSignedIn: true, userId: 'user-1' }),
}))

vi.mock('next/router', () => ({
  useRouter: () => ({
    replace: async (path: string) => {
      window.history.replaceState(null, '', path)
      return true
    },
  }),
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
    getChat: (id: unknown) => getChatMock(id),
    saveChat: (chat: unknown, skip?: unknown) => saveChatMock(chat, skip),
    saveExistingChat: (chat: unknown, skip?: unknown) =>
      saveExistingChatMock(chat, skip),
    saveChatAndSync: (chat: unknown) => saveChatAndSyncMock(chat),
  },
}))

vi.mock('@/services/storage/deleted-chats-tracker', () => ({
  deletedChatsTracker: { isDeleted: () => isDeletedMock() },
}))

vi.mock('@/services/exec-snapshot/access-token', () => ({
  generateCodeExecutionAccessToken: () => 'token',
}))

vi.mock('@/services/exec-snapshot/use-exec-snapshot', () => ({
  getCodeExecutionContainerAuthTokenForChat: vi.fn(async () => null),
}))

vi.mock('@/utils/cloud-sync-settings', () => ({
  isCloudSyncEnabled: () => true,
}))

vi.mock('@/utils/error-handling', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarning: vi.fn(),
}))

const storedMessages = [
  {
    role: 'user' as const,
    content: 'Earlier question',
    timestamp: new Date('2026-08-12T00:00:00.000Z'),
  },
  {
    role: 'assistant' as const,
    content: 'Earlier answer',
    timestamp: new Date('2026-08-12T00:00:01.000Z'),
  },
]

function metadataOnlyChat(): Chat {
  return {
    id: 'chat-1',
    title: 'Existing chat',
    createdAt: new Date('2026-08-12T00:00:00.000Z'),
    messages: [],
    messageCount: storedMessages.length,
    isMetadataOnly: true,
    isBlankChat: false,
    isLocalOnly: false,
  }
}

function hydratedChat(): Chat {
  return {
    ...metadataOnlyChat(),
    messages: storedMessages,
    isMetadataOnly: false,
  }
}

function completedStream() {
  return (async function* (): AsyncGenerator<ChatChunk> {
    yield { choices: [{ delta: { content: 'Response' } }] } as ChatChunk
    yield { choices: [{ delta: {}, finish_reason: 'stop' }] }
  })()
}

beforeEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  getChatMock.mockReset().mockRejectedValue(new Error('Unexpected chat read'))
  saveChatMock.mockReset().mockImplementation(async (chat: unknown) => chat)
  saveExistingChatMock
    .mockReset()
    .mockImplementation(async (chat: unknown) => chat)
  saveChatAndSyncMock
    .mockReset()
    .mockImplementation(async (chat: unknown) => chat)
  sendChatStreamMock
    .mockReset()
    .mockImplementation(async () => completedStream())
  isDeletedMock.mockReset().mockReturnValue(false)
  sessionStorage.clear()
  vi.spyOn(sessionChatStorage, 'saveChat')
})

afterEach(() => {
  vi.restoreAllMocks()
  sessionStorage.clear()
})

function renderMessaging(initialChat: Chat) {
  return renderHook(() => {
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
    return { chats, currentChat, setChats, setCurrentChat, messaging }
  })
}

describe('useChatMessaging metadata-only sends', () => {
  it('hydrates stored messages before persisting a send', async () => {
    getChatMock.mockResolvedValue(hydratedChat())
    const { result } = renderMessaging(metadataOnlyChat())

    await act(async () => {
      await result.current.messaging.handleQuery('New prompt')
    })

    expect(getChatMock).toHaveBeenCalledWith('chat-1')
    // The pre-stream save must contain the full stored history plus the
    // new user message — never just the placeholder empty array.
    const firstSave = saveExistingChatMock.mock.calls[0][0] as Chat
    expect(
      firstSave.messages.map((m: { content: string }) => m.content),
    ).toEqual(['Earlier question', 'Earlier answer', 'New prompt'])
    expect(firstSave.isMetadataOnly).toBe(false)

    expect(
      result.current.currentChat.messages.map(
        (m: { content: string }) => m.content,
      ),
    ).toEqual(['Earlier question', 'Earlier answer', 'New prompt', 'Response'])
    expect(saveExistingChatMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        messages: result.current.currentChat.messages,
      }),
      false,
    )
    expect(result.current.messaging.streamError).toBeNull()
  })

  it('refreshes hydration when the stored summary changes during the read', async () => {
    let resolveFirstHydration!: (chat: Chat) => void
    const initialSummary = {
      ...metadataOnlyChat(),
      updatedAt: '2026-08-12T00:00:02.000Z',
    }
    const refreshedMessages = [
      ...storedMessages,
      {
        role: 'user' as const,
        content: 'Remote question',
        timestamp: new Date('2026-08-12T00:00:03.000Z'),
      },
      {
        role: 'assistant' as const,
        content: 'Remote answer',
        timestamp: new Date('2026-08-12T00:00:04.000Z'),
      },
    ]
    const refreshedSummary = {
      ...initialSummary,
      updatedAt: '2026-08-12T00:00:05.000Z',
      messageCount: refreshedMessages.length,
    }
    getChatMock
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveFirstHydration = resolve
        }),
      )
      .mockResolvedValueOnce({
        ...refreshedSummary,
        messages: refreshedMessages,
        isMetadataOnly: false,
      })
    const { result } = renderMessaging(initialSummary)
    let send!: Promise<unknown>

    act(() => {
      send = result.current.messaging.handleQuery(
        'New prompt',
      ) as Promise<unknown>
    })
    act(() => {
      result.current.setChats([refreshedSummary])
      result.current.setCurrentChat(refreshedSummary)
    })
    await act(async () => resolveFirstHydration(hydratedChat()))
    await act(async () => send)

    expect(getChatMock).toHaveBeenCalledTimes(2)
    const firstSave = saveExistingChatMock.mock.calls[0][0] as Chat
    expect(firstSave.messages.map(({ content }) => content)).toEqual([
      'Earlier question',
      'Earlier answer',
      'Remote question',
      'Remote answer',
      'New prompt',
    ])
    expect(
      result.current.currentChat.messages.map(({ content }) => content),
    ).toEqual([
      'Earlier question',
      'Earlier answer',
      'Remote question',
      'Remote answer',
      'New prompt',
      'Response',
    ])
    expect(saveExistingChatMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        messages: result.current.currentChat.messages,
      }),
      false,
    )
    expect(result.current.messaging.streamError).toBeNull()
  })

  it('does not persist anything when hydration fails', async () => {
    getChatMock.mockResolvedValue(null)
    const { result } = renderMessaging(metadataOnlyChat())

    let dispatchResult: unknown
    await act(async () => {
      dispatchResult = await result.current.messaging.handleQuery('New prompt')
    })

    expect(saveChatMock).not.toHaveBeenCalled()
    expect(saveExistingChatMock).not.toHaveBeenCalled()
    expect(saveChatAndSyncMock).not.toHaveBeenCalled()
    expect(sendChatStreamMock).not.toHaveBeenCalled()
    expect(dispatchResult).toEqual({
      status: 'not-started',
      reason: 'chat-unavailable',
    })
    expect(result.current.currentChat.messages).toHaveLength(0)
  })

  it('rolls back the optimistic turn when the existing row disappears', async () => {
    getChatMock.mockResolvedValue(hydratedChat())
    saveExistingChatMock.mockResolvedValue(null)
    const { result } = renderMessaging(metadataOnlyChat())

    let dispatchResult: unknown
    await act(async () => {
      dispatchResult = await result.current.messaging.handleQuery('New prompt')
    })

    expect(dispatchResult).toEqual({
      status: 'not-started',
      reason: 'chat-unavailable',
    })
    expect(result.current.currentChat.messages).toEqual(storedMessages)
    expect(sendChatStreamMock).not.toHaveBeenCalled()
  })

  it('sends normally on a hydrated chat without re-reading storage', async () => {
    const { result } = renderMessaging(hydratedChat())

    await act(async () => {
      await result.current.messaging.handleQuery('New prompt')
    })

    expect(getChatMock).not.toHaveBeenCalled()
    const firstSave = saveChatAndSyncMock.mock.calls[0][0] as Chat
    expect(
      firstSave.messages.map((m: { content: string }) => m.content),
    ).toEqual(['Earlier question', 'Earlier answer', 'New prompt'])
    expect(
      result.current.currentChat.messages.map(({ content }) => content),
    ).toEqual(['Earlier question', 'Earlier answer', 'New prompt', 'Response'])
    expect(saveChatMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        messages: result.current.currentChat.messages,
      }),
      false,
    )
    expect(result.current.messaging.streamError).toBeNull()
  })

  it('keeps B current while a hydrated send continues for A', async () => {
    let resolveHydration!: (chat: Chat) => void
    getChatMock.mockReturnValue(
      new Promise((resolve) => {
        resolveHydration = resolve
      }),
    )
    const chatB: Chat = {
      id: 'chat-2',
      title: 'B',
      messages: [],
      createdAt: new Date(),
      isBlankChat: false,
      isLocalOnly: false,
    }
    const { result } = renderMessaging(metadataOnlyChat())
    let send!: Promise<unknown>

    act(() => {
      send = result.current.messaging.handleQuery(
        'New prompt',
      ) as Promise<unknown>
    })
    act(() => {
      result.current.setChats((previous) => [...previous, chatB])
      result.current.setCurrentChat(chatB)
    })
    await act(async () => resolveHydration(hydratedChat()))
    await act(async () => send)

    expect(result.current.currentChat).toBe(chatB)
    expect(
      result.current.chats
        .find(({ id }) => id === 'chat-1')
        ?.messages.map(({ content }) => content),
    ).toEqual(['Earlier question', 'Earlier answer', 'New prompt', 'Response'])
    expect(saveExistingChatMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: 'chat-1',
        messages: result.current.chats.find(({ id }) => id === 'chat-1')
          ?.messages,
      }),
      false,
    )
  })

  it('does not recreate or upload A when it is deleted during hydration', async () => {
    let resolveHydration!: (chat: Chat) => void
    getChatMock.mockReturnValue(
      new Promise((resolve) => {
        resolveHydration = resolve
      }),
    )
    const chatB: Chat = {
      id: 'chat-2',
      title: 'B',
      messages: [],
      createdAt: new Date(),
      isBlankChat: false,
      isLocalOnly: false,
    }
    const { result } = renderMessaging(metadataOnlyChat())
    let send!: Promise<unknown>

    act(() => {
      send = result.current.messaging.handleQuery(
        'New prompt',
      ) as Promise<unknown>
    })
    isDeletedMock.mockReturnValue(true)
    act(() => {
      result.current.setChats([chatB])
      result.current.setCurrentChat(chatB)
    })
    await act(async () => resolveHydration(hydratedChat()))
    await act(async () => send)

    expect(result.current.currentChat).toBe(chatB)
    expect(saveChatMock).not.toHaveBeenCalled()
    expect(saveExistingChatMock).not.toHaveBeenCalled()
    expect(saveChatAndSyncMock).not.toHaveBeenCalled()
    expect(sendChatStreamMock).not.toHaveBeenCalled()
  })
})

describe('useChatMessaging model availability', () => {
  it('does not dispatch without an available model', async () => {
    const initialChat = hydratedChat()
    const { result } = renderHook(() => {
      const [currentChat, setCurrentChat] = useState(initialChat)
      const [chats, setChats] = useState([initialChat])
      const messaging = useChatMessaging({
        systemPrompt: '',
        storeHistory: true,
        models: [],
        selectedModel: '',
        chats,
        currentChat,
        setChats,
        setCurrentChat,
      })
      return { currentChat, messaging }
    })

    await act(async () => {
      await result.current.messaging.handleQuery('No model')
    })

    expect(sendChatStreamMock).not.toHaveBeenCalled()
    expect(saveChatMock).not.toHaveBeenCalled()
    expect(saveChatAndSyncMock).not.toHaveBeenCalled()
    expect(result.current.currentChat.messages).toHaveLength(
      storedMessages.length,
    )
  })
})

function UrlMessageChat({
  blocked,
  ready = true,
}: {
  blocked: boolean
  ready?: boolean
}) {
  const [currentChat, setCurrentChat] = useState<Chat>(() => ({
    id: '',
    title: 'New Chat',
    createdAt: new Date(),
    messages: [],
    isBlankChat: true,
    isLocalOnly: true,
  }))
  const [chats, setChats] = useState([currentChat])
  const messaging = useChatMessaging({
    systemPrompt: '',
    storeHistory: false,
    models: [
      {
        modelName: 'gpt-oss-120b',
        name: 'GPT-OSS',
        nameShort: 'GPT-OSS',
        description: '',
        image: '',
        type: 'chat',
      },
    ],
    selectedModel: 'gpt-oss-120b',
    chats,
    currentChat,
    setChats,
    setCurrentChat,
  })
  const queue = useMessageQueue({
    chatId: currentChat.id,
    loadingState: messaging.loadingState,
    handleQuery: messaging.handleQuery,
    isRateLimited: () => false,
    isDispatchBlocked: () => blocked,
    dispatchBlocked: blocked,
  })
  return (
    <>
      <UrlHashMessageHandler isReady={ready} onSubmit={queue.submit} />
      <output data-testid="queued">
        {queue.queuedMessages.map((item) => item.text).join('\n')}
      </output>
      <output data-testid="messages">
        {currentChat.messages.map((item) => item.content).join('\n')}
      </output>
      <output data-testid="stream-error">
        {messaging.streamError?.message}
      </output>
    </>
  )
}

describe('URL messages through the chat send pipeline', () => {
  afterEach(() => {
    window.history.replaceState(null, '', '/')
    window.sessionStorage.clear()
  })

  it.each(['fragment', 'query'])(
    'retains a %s message until dispatch is unblocked, then streams exactly once',
    async (format) => {
      const message = 'Hello 👋 from the marketing page'
      window.history.replaceState(
        null,
        '',
        format === 'fragment'
          ? `/#send=${Buffer.from(message).toString('base64')}`
          : `/?q=${encodeURIComponent(message)}`,
      )
      const { rerender } = render(
        <StrictMode>
          <UrlMessageChat blocked />
        </StrictMode>,
      )
      await waitFor(() =>
        expect(screen.getByTestId('queued')).toHaveTextContent(message),
      )
      expect(sendChatStreamMock).not.toHaveBeenCalled()
      expect(window.location.hash).toBe('')
      expect(window.location.search).toBe('')

      rerender(
        <StrictMode>
          <UrlMessageChat blocked={false} />
        </StrictMode>,
      )
      await waitFor(() =>
        expect(sessionChatStorage.saveChat).toHaveBeenLastCalledWith(
          expect.objectContaining({
            messages: [
              expect.objectContaining({ role: 'user', content: message }),
              expect.objectContaining({
                role: 'assistant',
                content: 'Response',
              }),
            ],
          }),
        ),
      )
      expect(screen.getByTestId('messages')).toHaveTextContent('Response')
      expect(screen.getByTestId('stream-error')).toBeEmptyDOMElement()
      expect(sendChatStreamMock).toHaveBeenCalledOnce()
      expect(sendChatStreamMock.mock.calls[0][0].updatedMessages).toEqual([
        expect.objectContaining({ role: 'user', content: message }),
      ])
      expect(screen.getByTestId('queued')).toHaveTextContent('')
      expect(screen.getByTestId('messages')).toHaveTextContent(message)
    },
  )

  it('leaves the fragment untouched until the receiving chat is ready', async () => {
    const message = 'Wait for initialization'
    const hash = `#send=${Buffer.from(message).toString('base64')}`
    window.history.replaceState(null, '', `/${hash}`)
    const { rerender } = render(
      <UrlMessageChat ready={false} blocked={false} />,
    )
    expect(window.location.hash).toBe(hash)
    expect(sendChatStreamMock).not.toHaveBeenCalled()
    rerender(<UrlMessageChat ready blocked={false} />)
    await waitFor(() =>
      expect(sessionChatStorage.saveChat).toHaveBeenLastCalledWith(
        expect.objectContaining({
          messages: [
            expect.objectContaining({ role: 'user', content: message }),
            expect.objectContaining({ role: 'assistant', content: 'Response' }),
          ],
        }),
      ),
    )
    expect(screen.getByTestId('messages')).toHaveTextContent('Response')
    expect(screen.getByTestId('stream-error')).toBeEmptyDOMElement()
    expect(sendChatStreamMock).toHaveBeenCalledOnce()
    expect(window.location.hash).toBe('')
    expect(sendChatStreamMock.mock.calls[0][0].updatedMessages).toEqual([
      expect.objectContaining({ role: 'user', content: message }),
    ])
  })
})
