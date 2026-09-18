import { useChatStorage } from '@/components/chat/hooks/use-chat-storage'
import type { Chat, PendingRecoveryEnvelope } from '@/components/chat/types'
import { chatEvents } from '@/services/storage/chat-events'
import { chatStorage } from '@/services/storage/chat-storage'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockLoadChats,
  mockIsStreaming,
  mockDownloadChat,
  mockLoadChatImages,
  mockApplyRemoteChat,
  mockToast,
} = vi.hoisted(() => ({
  mockLoadChats: vi.fn(),
  mockIsStreaming: vi.fn(),
  mockDownloadChat: vi.fn(),
  mockLoadChatImages: vi.fn(),
  mockApplyRemoteChat: vi.fn(),
  mockToast: vi.fn(),
}))

vi.mock('@clerk/nextjs', () => ({
  useAuth: () => ({
    isSignedIn: true,
    getToken: vi.fn(),
  }),
}))

// Keep reload deterministic: no chats loaded from storage
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
    isStreaming: mockIsStreaming,
    isStreamingOrPending: mockIsStreaming,
  },
}))

vi.mock('@/services/cloud/cloud-storage', () => ({
  cloudStorage: {
    downloadChat: mockDownloadChat,
    loadChatImages: mockLoadChatImages,
  },
}))

vi.mock('@/services/storage/indexed-db', () => ({
  indexedDBStorage: {
    applyRemoteChatIfFresh: mockApplyRemoteChat,
  },
}))

vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: mockToast }),
}))

function createMockRecovery(
  overrides: Partial<PendingRecoveryEnvelope> = {},
): PendingRecoveryEnvelope {
  return {
    v: 1,
    turnId: 'turn-1',
    keyId: '0'.repeat(32),
    createdAt: '2026-07-21T00:00:00.000Z',
    expiresAt: '2026-07-22T00:00:00.000Z',
    nonce: 'nonce',
    ciphertext: 'ciphertext',
    ...overrides,
  }
}

describe('useChatStorage.reloadChats', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockLoadChats.mockResolvedValue([])
    mockIsStreaming.mockReturnValue(false)
    mockLoadChatImages.mockResolvedValue(new Map())
    mockApplyRemoteChat.mockResolvedValue({ applied: true })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it.each([false, true])(
    'merges completed upload metadata without clearing pending edits (pending: %s)',
    async (pendingSave) => {
      const current: Chat = {
        id: 'new-cloud-chat',
        title: 'New conversation',
        createdAt: new Date('2026-09-01T00:00:00Z'),
        updatedAt: '2026-09-01T00:00:00Z',
        messages: [{ role: 'user', content: 'Hello', timestamp: new Date() }],
        isBlankChat: false,
        isLocalOnly: false,
        locallyModified: true,
        pendingSave,
      }
      const { result } = renderHook(() =>
        useChatStorage({ storeHistory: true }),
      )
      await waitFor(() => expect(result.current.isInitialLoad).toBe(false))
      act(() => {
        result.current.setChats([current])
        result.current.setCurrentChat(current)
      })
      const syncedAt = Date.now()
      mockLoadChats.mockResolvedValue([
        {
          ...current,
          syncedAt,
          locallyModified: false,
          pendingSave: undefined,
          messages: [],
          messageCount: 1,
          isMetadataOnly: true,
        },
      ])
      act(() => chatEvents.emit({ reason: 'sync', ids: [current.id] }))
      await waitFor(() =>
        expect(result.current.currentChat.syncedAt).toBe(syncedAt),
      )
      expect(result.current.currentChat.locallyModified).toBe(pendingSave)
      expect(result.current.currentChat.messages).toBe(current.messages)
      expect(result.current.currentChat.pendingSave).toBe(pendingSave)
    },
  )

  it('loads summaries first and hydrates a chat when selected', async () => {
    const summary = {
      id: 'chat-summary',
      title: 'Summary',
      messages: [],
      messageCount: 1,
      isMetadataOnly: true,
      createdAt: new Date('2026-08-12T00:00:00.000Z'),
      isBlankChat: false,
      isLocalOnly: false,
    }
    const hydrated = {
      ...summary,
      messages: [
        {
          role: 'user' as const,
          content: 'Loaded message',
          timestamp: new Date('2026-08-12T00:00:00.000Z'),
        },
      ],
      isMetadataOnly: false,
    }
    mockLoadChats.mockResolvedValueOnce([summary])
    const getChat = vi.spyOn(chatStorage, 'getChat').mockResolvedValue(hydrated)

    const { result } = renderHook(() => useChatStorage({ storeHistory: true }))
    await waitFor(() => expect(result.current.isInitialLoad).toBe(false))

    expect(mockLoadChats).toHaveBeenCalledWith(true, true)
    expect(result.current.chats.find((chat) => chat.id === summary.id)).toEqual(
      summary,
    )

    act(() => result.current.handleChatSelect(summary.id))
    await waitFor(() =>
      expect(result.current.currentChat.messages).toHaveLength(1),
    )

    expect(getChat).toHaveBeenCalledWith(summary.id)
  })

  it('owns selection immediately and ignores late A hydration after selecting B', async () => {
    const prior = {
      id: 'prior',
      title: 'Prior',
      messages: [
        {
          role: 'user' as const,
          content: 'Still visible',
          timestamp: new Date('2026-08-12T00:00:00.000Z'),
        },
      ],
      createdAt: new Date('2026-08-12T00:00:00.000Z'),
      isBlankChat: false,
      isLocalOnly: false,
    }
    const summaryA = {
      ...prior,
      id: 'A',
      title: 'A',
      messages: [],
      messageCount: 1,
      isMetadataOnly: true,
    }
    const summaryB = { ...summaryA, id: 'B', title: 'B' }
    const hydratedA = {
      ...summaryA,
      messages: prior.messages,
      isMetadataOnly: false,
    }
    const hydratedB = {
      ...summaryB,
      messages: prior.messages,
      isMetadataOnly: false,
    }
    let resolveA!: (chat: typeof hydratedA) => void
    let resolveB!: (chat: typeof hydratedB) => void
    mockLoadChats.mockResolvedValueOnce([prior, summaryA, summaryB])
    vi.spyOn(chatStorage, 'getChat').mockImplementation((id) =>
      id === 'A'
        ? new Promise((resolve) => {
            resolveA = resolve
          })
        : new Promise((resolve) => {
            resolveB = resolve
          }),
    )
    const { result } = renderHook(() => useChatStorage({ storeHistory: true }))
    await waitFor(() => expect(result.current.isInitialLoad).toBe(false))
    act(() => result.current.setCurrentChat(prior))

    act(() => result.current.handleChatSelect('A'))
    expect(result.current.currentChat.id).toBe('A')
    expect(result.current.isChatHydrating).toBe(true)
    act(() => result.current.handleChatSelect('B'))
    expect(result.current.currentChat.id).toBe('B')
    expect(result.current.isChatHydrating).toBe(true)

    await act(async () => resolveB(hydratedB))
    expect(result.current.currentChat.id).toBe('B')
    expect(result.current.isChatHydrating).toBe(false)
    await act(async () => resolveA(hydratedA))
    expect(result.current.currentChat.id).toBe('B')
    expect(result.current.chats.find(({ id }) => id === 'A')).toBe(summaryA)
  })

  it('reverts to the prior chat and shows an error when hydration fails', async () => {
    const prior = {
      id: 'prior',
      title: 'Prior',
      messages: [
        {
          role: 'user' as const,
          content: 'Still visible',
          timestamp: new Date('2026-08-12T00:00:00.000Z'),
        },
      ],
      createdAt: new Date('2026-08-12T00:00:00.000Z'),
      isBlankChat: false,
      isLocalOnly: false,
    }
    const summary = {
      ...prior,
      id: 'A',
      messages: [],
      messageCount: 1,
      isMetadataOnly: true,
    }
    mockLoadChats.mockResolvedValueOnce([prior, summary])
    vi.spyOn(chatStorage, 'getChat').mockRejectedValue(new Error('read failed'))
    const { result } = renderHook(() => useChatStorage({ storeHistory: true }))
    await waitFor(() => expect(result.current.isInitialLoad).toBe(false))
    act(() => result.current.setCurrentChat(prior))

    act(() => result.current.handleChatSelect('A'))
    expect(result.current.currentChat.id).toBe('A')
    expect(result.current.isChatHydrating).toBe(true)
    await waitFor(() => expect(mockToast).toHaveBeenCalled())

    expect(result.current.currentChat).toMatchObject(prior)
    expect(result.current.isChatHydrating).toBe(false)
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Failed to load chat' }),
    )
  })

  it('does not overwrite a selected chat that changes during hydration', async () => {
    const summary = {
      id: 'chat-summary',
      title: 'Summary',
      messages: [],
      messageCount: 1,
      isMetadataOnly: true,
      createdAt: new Date('2026-08-12T00:00:00.000Z'),
      isBlankChat: false,
      isLocalOnly: false,
    }
    let finishHydration!: (chat: typeof summary) => void
    mockLoadChats.mockResolvedValueOnce([summary])
    vi.spyOn(chatStorage, 'getChat').mockReturnValue(
      new Promise((resolve) => {
        finishHydration = resolve
      }),
    )
    const { result } = renderHook(() => useChatStorage({ storeHistory: true }))
    await waitFor(() => expect(result.current.isInitialLoad).toBe(false))

    act(() => result.current.handleChatSelect(summary.id))
    const liveChat = {
      ...summary,
      isMetadataOnly: false,
      messages: [
        {
          role: 'assistant' as const,
          content: 'Live response',
          timestamp: new Date('2026-08-12T00:00:01.000Z'),
        },
      ],
    }
    act(() => {
      result.current.setCurrentChat(liveChat)
      result.current.setChats((chats) =>
        chats.map((chat) => (chat.id === liveChat.id ? liveChat : chat)),
      )
    })
    await act(async () => finishHydration(summary))

    expect(result.current.currentChat).toBe(liveChat)
    expect(result.current.chats.find((chat) => chat.id === liveChat.id)).toBe(
      liveChat,
    )
  })

  it('applies hydration by id when a reload replaced the chat objects', async () => {
    const summary = {
      id: 'chat-summary',
      title: 'Summary',
      messages: [],
      messageCount: 1,
      isMetadataOnly: true,
      createdAt: new Date('2026-08-12T00:00:00.000Z'),
      updatedAt: '2026-08-12T00:00:00.000Z',
      isBlankChat: false,
      isLocalOnly: false,
    }
    const hydrated = {
      ...summary,
      messages: [
        {
          role: 'user' as const,
          content: 'Loaded message',
          timestamp: new Date('2026-08-12T00:00:00.000Z'),
        },
      ],
      isMetadataOnly: false,
    }
    let finishHydration!: (chat: typeof hydrated) => void
    mockLoadChats.mockResolvedValue([summary])
    vi.spyOn(chatStorage, 'getChat').mockReturnValue(
      new Promise((resolve) => {
        finishHydration = resolve
      }),
    )
    const { result } = renderHook(() => useChatStorage({ storeHistory: true }))
    await waitFor(() => expect(result.current.isInitialLoad).toBe(false))

    act(() => result.current.handleChatSelect(summary.id))
    // A background sync reload rebuilds the chats array with fresh summary
    // objects while hydration is still in flight.
    await act(async () => {
      await result.current.reloadChats()
    })
    expect(result.current.currentChat.id).toBe(summary.id)

    await act(async () => finishHydration(hydrated))

    expect(result.current.currentChat.messages).toHaveLength(1)
    expect(result.current.currentChat.isMetadataOnly).toBe(false)
    expect(
      result.current.chats.find((chat) => chat.id === summary.id)?.messages,
    ).toHaveLength(1)
  })

  it('re-marks a hydrated chat as metadata-only when storage has newer content', async () => {
    const summary = {
      id: 'chat-1',
      title: 'Chat',
      messages: [],
      messageCount: 1,
      isMetadataOnly: true,
      createdAt: new Date('2026-08-12T00:00:00.000Z'),
      updatedAt: '2026-08-12T00:00:00.000Z',
      isBlankChat: false,
      isLocalOnly: false,
    }
    const hydrated = {
      ...summary,
      messages: [
        {
          role: 'user' as const,
          content: 'First message',
          timestamp: new Date('2026-08-12T00:00:00.000Z'),
        },
      ],
      isMetadataOnly: false,
    }
    mockLoadChats.mockResolvedValueOnce([summary])
    const getChat = vi.spyOn(chatStorage, 'getChat').mockResolvedValue(hydrated)

    const { result } = renderHook(() => useChatStorage({ storeHistory: true }))
    await waitFor(() => expect(result.current.isInitialLoad).toBe(false))
    act(() => result.current.handleChatSelect(summary.id))
    await waitFor(() =>
      expect(result.current.currentChat.messages).toHaveLength(1),
    )

    // The user opens another chat, then a sync from a second device adds
    // messages to chat-1: the reload's summary reports newer content.
    const other = {
      id: 'chat-2',
      title: 'Other',
      messages: [],
      createdAt: new Date('2026-08-12T01:00:00.000Z'),
      isBlankChat: false,
      isLocalOnly: false,
    }
    act(() => result.current.setCurrentChat(other))
    const newerSummary = {
      ...summary,
      messageCount: 3,
      updatedAt: '2026-08-12T02:00:00.000Z',
    }
    mockLoadChats.mockResolvedValue([newerSummary, other])
    await act(async () => {
      await result.current.reloadChats()
    })

    const listed = result.current.chats.find((chat) => chat.id === summary.id)
    expect(listed?.isMetadataOnly).toBe(true)

    // Re-selecting the chat hydrates the fresh copy instead of showing
    // the stale one.
    const rehydrated = {
      ...hydrated,
      updatedAt: newerSummary.updatedAt,
      messages: [
        ...hydrated.messages,
        {
          role: 'assistant' as const,
          content: 'Synced answer',
          timestamp: new Date('2026-08-12T02:00:00.000Z'),
        },
        {
          role: 'user' as const,
          content: 'Synced follow-up',
          timestamp: new Date('2026-08-12T02:00:01.000Z'),
        },
      ],
    }
    getChat.mockResolvedValue(rehydrated)
    act(() => result.current.handleChatSelect(summary.id))
    await waitFor(() =>
      expect(result.current.currentChat.messages).toHaveLength(3),
    )
  })

  it('refreshes the displayed chat when a newer summary arrives', async () => {
    const summary = {
      id: 'chat-1',
      title: 'Chat',
      messages: [],
      messageCount: 1,
      isMetadataOnly: true,
      createdAt: new Date('2026-08-12T00:00:00.000Z'),
      updatedAt: '2026-08-12T00:00:00.000Z',
      isBlankChat: false,
      isLocalOnly: false,
    }
    const hydrated = {
      ...summary,
      messages: [
        {
          role: 'user' as const,
          content: 'First message',
          timestamp: new Date('2026-08-12T00:00:00.000Z'),
        },
      ],
      isMetadataOnly: false,
    }
    mockLoadChats.mockResolvedValueOnce([summary])
    const getChat = vi.spyOn(chatStorage, 'getChat')
    getChat.mockResolvedValueOnce(hydrated)

    const { result } = renderHook(() => useChatStorage({ storeHistory: true }))
    await waitFor(() => expect(result.current.isInitialLoad).toBe(false))
    act(() => result.current.handleChatSelect(summary.id))
    await waitFor(() =>
      expect(result.current.currentChat.messages).toHaveLength(1),
    )

    // Storage reports newer content while this chat is on screen.
    const newerSummary = {
      ...summary,
      title: 'Renamed elsewhere',
      messageCount: 2,
      updatedAt: '2026-08-12T01:00:00.000Z',
    }
    const refreshed = {
      ...hydrated,
      title: newerSummary.title,
      updatedAt: newerSummary.updatedAt,
      messages: [
        ...hydrated.messages,
        {
          role: 'assistant' as const,
          content: 'Synced answer',
          timestamp: new Date('2026-08-12T01:00:00.000Z'),
        },
      ],
    }
    getChat.mockResolvedValueOnce(refreshed)
    mockLoadChats.mockResolvedValue([newerSummary])
    await act(async () => {
      await result.current.reloadChats()
    })

    expect(result.current.currentChat.messages).toHaveLength(2)
    expect(result.current.currentChat.messages[1]?.content).toBe(
      'Synced answer',
    )
    expect(result.current.currentChat.title).toBe('Renamed elsewhere')
    expect(result.current.currentChat.isMetadataOnly).toBeFalsy()
  })

  it('keeps hydrated messages when the reload summary matches storage', async () => {
    const summary = {
      id: 'chat-1',
      title: 'Chat',
      messages: [],
      messageCount: 1,
      isMetadataOnly: true,
      createdAt: new Date('2026-08-12T00:00:00.000Z'),
      updatedAt: '2026-08-12T00:00:00.000Z',
      isBlankChat: false,
      isLocalOnly: false,
    }
    const hydrated = {
      ...summary,
      messages: [
        {
          role: 'user' as const,
          content: 'First message',
          timestamp: new Date('2026-08-12T00:00:00.000Z'),
        },
      ],
      isMetadataOnly: false,
    }
    mockLoadChats.mockResolvedValueOnce([summary])
    vi.spyOn(chatStorage, 'getChat').mockResolvedValue(hydrated)

    const { result } = renderHook(() => useChatStorage({ storeHistory: true }))
    await waitFor(() => expect(result.current.isInitialLoad).toBe(false))
    act(() => result.current.handleChatSelect(summary.id))
    await waitFor(() =>
      expect(result.current.currentChat.messages).toHaveLength(1),
    )

    mockLoadChats.mockResolvedValue([summary])
    await act(async () => {
      await result.current.reloadChats()
    })

    const listed = result.current.chats.find((chat) => chat.id === summary.id)
    expect(listed?.isMetadataOnly).toBe(false)
    expect(listed?.messages).toHaveLength(1)
  })

  it('keeps a routed local new chat selected after loading storage', async () => {
    const { result } = renderHook(() =>
      useChatStorage({
        storeHistory: true,
        initialNewChatIsLocalOnly: true,
      }),
    )

    expect(result.current.currentChat.isBlankChat).toBe(true)
    expect(result.current.currentChat.isLocalOnly).toBe(true)

    await waitFor(() => {
      expect(result.current.isInitialLoad).toBe(false)
    })

    expect(result.current.currentChat.isBlankChat).toBe(true)
    expect(result.current.currentChat.isLocalOnly).toBe(true)
  })

  it('preserves a temporary chat opened while initial storage is loading', async () => {
    let finishLoading!: (chats: []) => void
    mockLoadChats.mockReturnValueOnce(
      new Promise<[]>((resolve) => {
        finishLoading = resolve
      }),
    )
    const { result } = renderHook(() =>
      useChatStorage({
        storeHistory: true,
      }),
    )
    const temporaryChat = {
      id: '0000000000001_12345678-1234-4234-8234-123456789abc',
      title: 'Temporary Chat',
      messages: [],
      createdAt: new Date(),
      isBlankChat: true,
      isTemporary: true,
      isLocalOnly: true,
    }

    act(() => result.current.setCurrentChat(temporaryChat))
    await act(async () => finishLoading([]))

    expect(result.current.currentChat).toMatchObject(temporaryChat)
  })

  it('does not reset currentChat to blank during temp-id window', async () => {
    const { result } = renderHook(() =>
      useChatStorage({
        storeHistory: true,
      }),
    )

    // Let the hook finish its initial async load effect first.
    await waitFor(() => {
      expect(result.current.isInitialLoad).toBe(false)
    })

    await act(async () => {
      result.current.setCurrentChat({
        id: 'temp-123',
        title: 'Untitled',
        messages: [],
        createdAt: new Date(),
        isBlankChat: false,
        isLocalOnly: false,
        pendingSave: true,
      })
    })

    await act(async () => {
      await result.current.reloadChats()
    })

    expect(result.current.currentChat.id).toBe('temp-123')
    expect(result.current.currentChat.isBlankChat).toBe(false)
  })

  it('does not reset currentChat to blank during pendingSave window (non-temp id)', async () => {
    const { result } = renderHook(() =>
      useChatStorage({
        storeHistory: true,
      }),
    )

    await waitFor(() => {
      expect(result.current.isInitialLoad).toBe(false)
    })

    await act(async () => {
      result.current.setCurrentChat({
        id: 'server-abc',
        title: 'Untitled',
        messages: [],
        createdAt: new Date(),
        isBlankChat: false,
        isLocalOnly: false,
        pendingSave: true,
      })
    })

    await act(async () => {
      await result.current.reloadChats()
    })

    expect(result.current.currentChat.id).toBe('server-abc')
    expect(result.current.currentChat.isBlankChat).toBe(false)
  })

  it('moves the selected local chat into the cloud collection after reload', async () => {
    const { result } = renderHook(() =>
      useChatStorage({
        storeHistory: true,
      }),
    )

    await waitFor(() => {
      expect(result.current.isInitialLoad).toBe(false)
    })

    const current = {
      id: 'chat-1',
      title: 'Moved chat',
      messages: [
        { role: 'user', content: 'Current message', timestamp: new Date() },
      ],
      createdAt: new Date(),
      isBlankChat: false,
      isLocalOnly: true,
    }
    await act(async () => {
      result.current.setCurrentChat(current as any)
    })
    mockLoadChats.mockResolvedValue([
      {
        ...current,
        messages: [],
        isLocalOnly: false,
      },
    ])

    await act(async () => {
      await result.current.reloadChats()
    })

    expect(result.current.currentChat.isLocalOnly).toBe(false)
    expect(result.current.currentChat.messages).toEqual(current.messages)
    expect(result.current.chats.find((chat) => chat.id === current.id)).toBe(
      result.current.currentChat,
    )
  })

  it('moves the selected cloud chat into the local collection after reload', async () => {
    const { result } = renderHook(() =>
      useChatStorage({
        storeHistory: true,
      }),
    )

    await waitFor(() => {
      expect(result.current.isInitialLoad).toBe(false)
    })

    const current = {
      id: 'chat-1',
      title: 'Moved chat',
      messages: [],
      createdAt: new Date(),
      isBlankChat: false,
      isLocalOnly: false,
      projectId: 'project-1',
    }
    await act(async () => {
      result.current.setCurrentChat(current as any)
    })
    mockLoadChats.mockResolvedValue([
      {
        ...current,
        isLocalOnly: true,
        projectId: undefined,
      },
    ])

    await act(async () => {
      await result.current.reloadChats()
    })

    expect(result.current.currentChat.isLocalOnly).toBe(true)
    expect(result.current.currentChat.projectId).toBeUndefined()
    expect(result.current.chats.find((chat) => chat.id === current.id)).toBe(
      result.current.currentChat,
    )
  })

  it('updates the selected chat location during a streaming recovery reload', async () => {
    const { result } = renderHook(() =>
      useChatStorage({
        storeHistory: true,
      }),
    )

    await waitFor(() => {
      expect(result.current.isInitialLoad).toBe(false)
    })

    const current = {
      id: 'chat-1',
      title: 'Moved chat',
      messages: [
        { role: 'user', content: 'Streaming message', timestamp: new Date() },
      ],
      createdAt: new Date(),
      isBlankChat: false,
      isLocalOnly: true,
    }
    await act(async () => {
      result.current.setCurrentChat(current as any)
    })
    mockIsStreaming.mockReturnValue(true)
    mockLoadChats.mockResolvedValue([
      {
        ...current,
        messages: [],
        isLocalOnly: false,
      },
    ])

    act(() => {
      chatEvents.emit({ reason: 'recovery', ids: [current.id] })
    })

    await waitFor(() => {
      expect(result.current.currentChat.isLocalOnly).toBe(false)
    })
    expect(result.current.currentChat.messages).toEqual(current.messages)
  })

  it('applies idChanges to currentChat before reloading', async () => {
    const { result } = renderHook(() =>
      useChatStorage({
        storeHistory: true,
      }),
    )

    await waitFor(() => {
      expect(result.current.isInitialLoad).toBe(false)
    })

    await act(async () => {
      result.current.setCurrentChat({
        id: 'temp-abc',
        title: 'Untitled',
        messages: [{ role: 'user', content: 'hi', timestamp: new Date() }],
        createdAt: new Date(),
        isBlankChat: false,
        isLocalOnly: false,
        pendingSave: false,
      } as any)
    })

    await act(async () => {
      chatEvents.emit({
        reason: 'sync',
        ids: ['server-def'],
        idChanges: [{ from: 'temp-abc', to: 'server-def' }],
      })
      // reloadChats is async; yield to allow it to run
      await Promise.resolve()
    })

    expect(result.current.currentChat.id).toBe('server-def')
  })

  it('refreshes pending recoveries for the selected chat after sync', async () => {
    const { result } = renderHook(() =>
      useChatStorage({
        storeHistory: true,
      }),
    )

    await waitFor(() => {
      expect(result.current.isInitialLoad).toBe(false)
    })

    const current = {
      id: 'chat-1',
      title: 'Recovery chat',
      messages: [
        {
          role: 'user' as const,
          content: 'Question',
          turnId: 'turn-1',
          timestamp: new Date(),
        },
      ],
      createdAt: new Date(),
      isBlankChat: false,
      isLocalOnly: false,
    }
    const recovery = createMockRecovery()

    await act(async () => {
      result.current.setCurrentChat(current as any)
    })
    mockLoadChats.mockResolvedValue([
      { ...current, pendingRecoveries: [recovery] },
    ])

    act(() => {
      chatEvents.emit({ reason: 'sync', ids: ['chat-1'] })
    })
    await waitFor(() => {
      expect(result.current.currentChat.pendingRecoveries).toEqual([recovery])
    })
  })

  it('refreshes pending recoveries while the selected chat is switching', async () => {
    const current = {
      id: 'chat-1',
      title: 'Recovery chat',
      messages: [
        {
          role: 'user' as const,
          content: 'Question',
          turnId: 'turn-1',
          timestamp: new Date(),
        },
      ],
      createdAt: new Date(),
      isBlankChat: false,
      isLocalOnly: false,
    }
    const recovery = createMockRecovery()
    const { result } = renderHook(() =>
      useChatStorage({
        storeHistory: true,
      }),
    )
    await waitFor(() => {
      expect(result.current.isInitialLoad).toBe(false)
    })

    await act(async () => {
      await result.current.switchChat(current as any)
    })
    mockLoadChats.mockResolvedValue([
      { ...current, pendingRecoveries: [recovery] },
    ])
    act(() => {
      chatEvents.emit({ reason: 'sync', ids: ['chat-1'] })
    })

    await waitFor(() => {
      expect(result.current.currentChat.pendingRecoveries).toEqual([recovery])
    })
  })

  it('switches an already-loaded chat without entering a loading delay', async () => {
    const selected = {
      id: 'chat-2',
      title: 'Selected chat',
      messages: [],
      createdAt: new Date(),
      isBlankChat: false,
    }
    mockLoadChats.mockResolvedValue([selected])
    const { result } = renderHook(() =>
      useChatStorage({
        storeHistory: true,
      }),
    )
    await waitFor(() => expect(result.current.isInitialLoad).toBe(false))

    await act(async () => {
      await result.current.switchChat(selected)
    })

    expect(result.current.currentChat.id).toBe(selected.id)
    expect(result.current.isInitialLoad).toBe(false)
  })

  it('does not let an older sync reload clear recovery progress', async () => {
    const current = {
      id: 'chat-1',
      title: 'Recovery chat',
      messages: [
        {
          role: 'user' as const,
          content: 'Question',
          turnId: 'turn-1',
          timestamp: new Date(),
        },
      ],
      createdAt: new Date(),
      isBlankChat: false,
      isLocalOnly: false,
    }
    const recovery = createMockRecovery()
    const { result } = renderHook(() =>
      useChatStorage({
        storeHistory: true,
      }),
    )
    await waitFor(() => {
      expect(result.current.isInitialLoad).toBe(false)
    })

    let finishOlderReload: ((chats: any[]) => void) | undefined
    mockLoadChats
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finishOlderReload = resolve
        }),
      )
      .mockResolvedValueOnce([{ ...current, pendingRecoveries: [recovery] }])
    await act(async () => {
      result.current.setCurrentChat(current as any)
    })
    act(() => {
      chatEvents.emit({ reason: 'sync', ids: ['chat-1'] })
      chatEvents.emit({ reason: 'recovery', ids: ['chat-1'] })
    })

    await waitFor(() => {
      expect(result.current.currentChat.pendingRecoveries).toEqual([recovery])
    })
    finishOlderReload?.([current])
    await act(async () => {
      await Promise.resolve()
    })

    expect(result.current.currentChat.pendingRecoveries).toEqual([recovery])
    expect(
      result.current.chats.find((chat) => chat.id === 'chat-1')
        ?.pendingRecoveries,
    ).toEqual([recovery])
  })

  it('preserves pending recoveries when loading a chat from a URL', async () => {
    const recovery = createMockRecovery()
    mockDownloadChat.mockResolvedValue({
      id: 'chat-1',
      title: 'Recovery chat',
      messages: [
        {
          role: 'user',
          content: 'Question',
          turnId: 'turn-1',
          timestamp: new Date(),
        },
      ],
      pendingRecoveries: [recovery],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastAccessedAt: Date.now(),
    })

    const { result } = renderHook(() =>
      useChatStorage({
        storeHistory: true,
        initialChatId: 'chat-1',
      }),
    )

    await waitFor(() => {
      expect(result.current.currentChat.id).toBe('chat-1')
    })
    expect(result.current.currentChat.pendingRecoveries).toEqual([recovery])
    expect(mockApplyRemoteChat).toHaveBeenCalledWith({
      chat: expect.objectContaining({
        id: 'chat-1',
        pendingRecoveries: [recovery],
      }),
      syncVersion: 1,
      expectedLocalUpdatedAt: null,
    })
  })

  it('keeps recovery updates when a sync reload supersedes them', async () => {
    const { result } = renderHook(() =>
      useChatStorage({
        storeHistory: true,
      }),
    )

    await waitFor(() => {
      expect(result.current.isInitialLoad).toBe(false)
    })

    const userMessage = {
      role: 'user' as const,
      content: 'Question',
      turnId: 'turn-1',
      timestamp: new Date(),
    }
    const current = {
      id: 'chat-1',
      title: 'Recovery chat',
      messages: [userMessage],
      createdAt: new Date(),
      isBlankChat: false,
      isLocalOnly: false,
    }
    const recovery = createMockRecovery()
    let finishOlderReload: ((chats: any[]) => void) | undefined
    mockLoadChats
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finishOlderReload = resolve
        }),
      )
      .mockResolvedValueOnce([
        {
          ...current,
          messages: [
            userMessage,
            {
              role: 'assistant',
              content: 'Recovered answer',
              turnId: 'turn-1',
              timestamp: new Date(),
            },
          ],
        },
      ])

    await act(async () => {
      result.current.setCurrentChat(current as any)
    })
    act(() => {
      chatEvents.emit({ reason: 'recovery', ids: ['chat-1'] })
      chatEvents.emit({ reason: 'sync', ids: ['chat-1'] })
    })
    await waitFor(() => {
      expect(result.current.currentChat.messages).toHaveLength(2)
    })

    finishOlderReload?.([{ ...current, pendingRecoveries: [recovery] }])
    await act(async () => {
      await Promise.resolve()
    })

    expect(result.current.currentChat.messages).toHaveLength(2)
    expect(result.current.currentChat.pendingRecoveries).toBeUndefined()
  })

  it('adopts a recovered response delivered by a plain sync', async () => {
    const recovery = createMockRecovery()
    const userMessage = {
      role: 'user' as const,
      content: 'Question',
      turnId: 'turn-1',
      timestamp: new Date(),
    }
    const current = {
      id: 'chat-1',
      title: 'Recovery chat',
      messages: [
        userMessage,
        {
          role: 'assistant' as const,
          content: 'Partial',
          turnId: 'turn-1',
          timestamp: new Date(),
        },
      ],
      pendingRecoveries: [recovery],
      createdAt: new Date(),
      isBlankChat: false,
      isLocalOnly: false,
    }
    mockLoadChats.mockResolvedValue([
      {
        ...current,
        messages: [
          userMessage,
          {
            role: 'assistant',
            content: 'Recovered answer',
            turnId: 'turn-1',
            timestamp: new Date(),
          },
        ],
        pendingRecoveries: undefined,
      },
    ])
    const { result } = renderHook(() =>
      useChatStorage({
        storeHistory: true,
      }),
    )
    await waitFor(() => {
      expect(result.current.isInitialLoad).toBe(false)
    })
    await act(async () => {
      result.current.setCurrentChat(current as any)
    })

    act(() => {
      chatEvents.emit({ reason: 'sync', ids: ['chat-1'] })
    })

    await waitFor(() => {
      expect(result.current.currentChat.messages[1].content).toBe(
        'Recovered answer',
      )
    })
    expect(result.current.currentChat.pendingRecoveries).toBeUndefined()
  })

  it('keeps a partial response when sync only removes its recovery', async () => {
    const recovery = createMockRecovery()
    const currentTimestamp = new Date('2026-07-21T00:00:00.000Z')
    const current = {
      id: 'chat-1',
      title: 'Recovery chat',
      messages: [
        {
          role: 'user' as const,
          content: 'Question',
          turnId: 'turn-1',
          timestamp: new Date(),
        },
        {
          role: 'assistant' as const,
          content: 'Partial',
          turnId: 'turn-1',
          timestamp: currentTimestamp,
        },
      ],
      pendingRecoveries: [recovery],
      createdAt: new Date(),
      isBlankChat: false,
      isLocalOnly: false,
    }
    mockLoadChats.mockResolvedValue([
      {
        ...current,
        messages: [
          current.messages[0],
          {
            ...current.messages[1],
            timestamp: new Date('2026-07-21T00:01:00.000Z'),
          },
        ],
        pendingRecoveries: undefined,
      },
    ])
    const { result } = renderHook(() =>
      useChatStorage({
        storeHistory: true,
      }),
    )
    await waitFor(() => {
      expect(result.current.isInitialLoad).toBe(false)
    })
    await act(async () => {
      result.current.setCurrentChat(current as any)
    })

    act(() => {
      chatEvents.emit({ reason: 'sync', ids: ['chat-1'] })
    })

    await waitFor(() => {
      expect(result.current.currentChat.pendingRecoveries).toBeUndefined()
    })
    expect(result.current.currentChat.messages[1].timestamp).toBe(
      currentTimestamp,
    )
  })
})
