import { useChatStorage } from '@/components/chat/hooks/use-chat-storage'
import { chatEvents } from '@/services/storage/chat-events'
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockLoadChats, mockIsStreaming, mockDownloadChat, mockLoadChatImages } =
  vi.hoisted(() => ({
    mockLoadChats: vi.fn(),
    mockIsStreaming: vi.fn(),
    mockDownloadChat: vi.fn(),
    mockLoadChatImages: vi.fn(),
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
  },
}))

vi.mock('@/services/cloud/cloud-storage', () => ({
  cloudStorage: {
    downloadChat: mockDownloadChat,
    loadChatImages: mockLoadChatImages,
  },
}))

describe('useChatStorage.reloadChats', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockLoadChats.mockResolvedValue([])
    mockIsStreaming.mockReturnValue(false)
    mockLoadChatImages.mockResolvedValue(new Map())
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
    const recovery = {
      v: 1 as const,
      turnId: 'turn-1',
      keyId: '0'.repeat(32),
      createdAt: '2026-07-21T00:00:00.000Z',
      expiresAt: '2026-07-22T00:00:00.000Z',
      nonce: 'nonce',
      ciphertext: 'ciphertext',
    }

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

  it('preserves pending recoveries when loading a chat from a URL', async () => {
    const recovery = {
      v: 1 as const,
      turnId: 'turn-1',
      keyId: '0'.repeat(32),
      createdAt: '2026-07-21T00:00:00.000Z',
      expiresAt: '2026-07-22T00:00:00.000Z',
      nonce: 'nonce',
      ciphertext: 'ciphertext',
    }
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
  })

  it('does not apply an older recovery refresh after completion', async () => {
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
    const recovery = {
      v: 1 as const,
      turnId: 'turn-1',
      keyId: '0'.repeat(32),
      createdAt: '2026-07-21T00:00:00.000Z',
      expiresAt: '2026-07-22T00:00:00.000Z',
      nonce: 'nonce',
      ciphertext: 'ciphertext',
    }
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
      chatEvents.emit({ reason: 'recovery', ids: ['chat-1'] })
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
})
