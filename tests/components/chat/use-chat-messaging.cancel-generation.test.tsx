import { useChatMessaging } from '@/components/chat/hooks/use-chat-messaging'
import type { Chat } from '@/components/chat/types'
import type { BaseModel } from '@/config/models'
import {
  clearActiveChatRecoveries,
  setChatRecoveryActive,
} from '@/services/inference/chat-recovery-drafts'
import { chatEvents } from '@/services/storage/chat-events'
import { act, renderHook } from '@testing-library/react'
import { type Dispatch, type SetStateAction, useLayoutEffect } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const abortMock = vi.fn()
const patchStatusMock = vi.fn()
const resetStatusMock = vi.fn()
const moveStatusMock = vi.fn()
const registerControllerMock = vi.fn()
const clearControllerMock = vi.fn()
const streamStatuses: Record<string, object> = {}
const testModels = [
  {
    modelName: 'test-model',
    image: '',
    name: 'Test Model',
    nameShort: 'Test',
    description: '',
    type: 'chat',
  },
] satisfies BaseModel[]
const {
  authState,
  cancelChatRecoveryMock,
  cloudSyncState,
  scanPendingChatRecoveriesMock,
} = vi.hoisted(() => ({
  authState: {
    isSignedIn: false,
    userId: undefined as string | undefined,
  },
  cancelChatRecoveryMock: vi.fn(async () => false),
  cloudSyncState: { enabled: true },
  scanPendingChatRecoveriesMock: vi.fn(),
}))

vi.mock('@clerk/nextjs', () => ({
  useAuth: () => authState,
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
    beginPendingStream: vi.fn(),
    endPendingStream: vi.fn(),
    isStreamingOrPending: vi.fn(() => false),
  },
}))

vi.mock('@/services/inference/tinfoil-client', async () => {
  const actual = await vi.importActual<
    typeof import('@/services/inference/tinfoil-client')
  >('@/services/inference/tinfoil-client')
  return {
    ...actual,
    isChatRecoveryAvailable: () => true,
  }
})

vi.mock('@/utils/cloud-sync-settings', () => ({
  isCloudSyncEnabled: () => cloudSyncState.enabled,
}))

vi.mock('@/services/inference/chat-recovery', () => ({
  abandonChatRecoveryAttempt: vi.fn(),
  cancelChatRecovery: cancelChatRecoveryMock,
  completeLiveChatRecovery: vi.fn(),
  markChatRecoveryTurnCancelled: vi.fn(),
  persistChatRecoveryToken: vi.fn(),
  releaseActiveChatRecovery: vi.fn(),
  scanPendingChatRecoveries: scanPendingChatRecoveriesMock,
  startChatRecoveryAttempt: vi.fn(),
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
    clearActiveChatRecoveries()
    authState.isSignedIn = false
    authState.userId = undefined
    cloudSyncState.enabled = true
    for (const chatId of Object.keys(streamStatuses)) {
      delete streamStatuses[chatId]
    }
  })

  it('targets the latest rendered chat during a chat switch', async () => {
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
    await vi.waitFor(() =>
      expect(patchStatusMock).toHaveBeenCalledWith(
        'chat-b',
        expect.objectContaining({
          loadingState: 'idle',
        }),
      ),
    )
    expect(patchStatusMock).toHaveBeenCalledWith(
      'chat-b',
      expect.objectContaining({
        retryInfo: null,
        isThinking: false,
        isWaitingForResponse: false,
        isStreaming: false,
      }),
    )
  })

  it('exposes a resumed recovery as an active stream', () => {
    const chat = createChat('chat-a')
    streamStatuses['chat-a'] = {
      loadingState: 'streaming',
      retryInfo: null,
      isThinking: false,
      isWaitingForResponse: false,
      isStreaming: true,
      streamError: null,
    }
    const { result } = renderHook(useChatMessagingHarness, {
      initialProps: {
        currentChat: chat,
        triggerCancelOnLayout: false,
      },
    })

    act(() => {
      setChatRecoveryActive('chat-a', 'turn-1', true)
    })

    expect(result.current.loadingState).toBe('loading')
    expect(result.current.isStreaming).toBe(true)
  })

  it('does not start a new prompt while recovery is active', async () => {
    const chat = createChat('chat-a')
    const { result } = renderHook(useChatMessagingHarness, {
      initialProps: {
        currentChat: chat,
        triggerCancelOnLayout: false,
      },
    })
    act(() => {
      setChatRecoveryActive('chat-a', 'turn-1', true)
    })
    resetStatusMock.mockClear()
    registerControllerMock.mockClear()

    await act(async () => {
      await result.current.handleQuery('Another prompt')
    })

    expect(resetStatusMock).not.toHaveBeenCalled()
    expect(registerControllerMock).not.toHaveBeenCalled()
  })

  it('keeps the Stop action active whenever the chat is streaming', () => {
    const chat = createChat('chat-a')
    streamStatuses['chat-a'] = {
      loadingState: 'idle',
      retryInfo: null,
      isThinking: false,
      isWaitingForResponse: false,
      isStreaming: true,
      streamError: null,
    }

    const { result } = renderHook(useChatMessagingHarness, {
      initialProps: {
        currentChat: chat,
        triggerCancelOnLayout: false,
      },
    })

    expect(result.current.loadingState).toBe('loading')
    expect(result.current.isStreaming).toBe(true)
  })

  it('returns the input to idle immediately and deduplicates repeated stops', async () => {
    let finishCancellation!: (persisted: boolean) => void
    cancelChatRecoveryMock.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          finishCancellation = resolve
        }),
    )
    const chat = createChat('chat-a')
    const { result } = renderHook(useChatMessagingHarness, {
      initialProps: {
        currentChat: chat,
        triggerCancelOnLayout: false,
      },
    })
    act(() => {
      setChatRecoveryActive('chat-a', 'turn-1', true)
    })

    let firstCancellation!: Promise<void>
    let secondCancellation!: Promise<void>
    act(() => {
      firstCancellation = result.current.cancelGeneration()
      secondCancellation = result.current.cancelGeneration()
    })

    expect(firstCancellation).toBe(secondCancellation)
    expect(abortMock).toHaveBeenCalledTimes(1)
    await vi.waitFor(() =>
      expect(cancelChatRecoveryMock).toHaveBeenCalledTimes(1),
    )
    expect(patchStatusMock).toHaveBeenCalledWith(
      'chat-a',
      expect.objectContaining({
        loadingState: 'idle',
        isStreaming: false,
      }),
    )

    finishCancellation(false)
    await act(async () => {
      await firstCancellation
    })

    expect(patchStatusMock).toHaveBeenCalledWith('chat-a', {
      loadingState: 'idle',
    })
  })

  it('rescans pending recoveries when cloud sync downloads a chat', () => {
    authState.isSignedIn = true
    authState.userId = 'user-1'
    const chat = createChat('chat-a')

    const { unmount } = renderHook(() =>
      useChatMessaging({
        systemPrompt: '',
        rules: '',
        storeHistory: true,
        models: testModels,
        selectedModel: 'test-model',
        chats: [chat],
        currentChat: chat,
        setChats: noopSetChats,
        setCurrentChat: noopSetCurrentChat,
      }),
    )
    scanPendingChatRecoveriesMock.mockClear()

    act(() => {
      chatEvents.emit({ reason: 'sync', ids: ['chat-a'] })
    })

    expect(scanPendingChatRecoveriesMock).toHaveBeenCalledWith('user-1', false)
    unmount()
  })

  it('rescans pending recoveries when the encryption key becomes available', () => {
    authState.isSignedIn = true
    authState.userId = 'user-1'
    const chat = createChat('chat-a')
    const { unmount } = renderHook(() =>
      useChatMessaging({
        systemPrompt: '',
        rules: '',
        storeHistory: true,
        models: testModels,
        selectedModel: 'test-model',
        chats: [chat],
        currentChat: chat,
        setChats: noopSetChats,
        setCurrentChat: noopSetCurrentChat,
      }),
    )
    scanPendingChatRecoveriesMock.mockClear()

    act(() => {
      window.dispatchEvent(new Event('encryptionKeyChanged'))
    })

    expect(scanPendingChatRecoveriesMock).toHaveBeenCalledWith('user-1', true)
    unmount()
  })

  it('scans IndexedDB recoveries when cloud sync is disabled', () => {
    authState.isSignedIn = true
    authState.userId = 'user-1'
    cloudSyncState.enabled = false
    const chat = { ...createChat('chat-a'), isLocalOnly: true }

    const { unmount } = renderHook(() =>
      useChatMessaging({
        systemPrompt: '',
        rules: '',
        storeHistory: true,
        models: testModels,
        selectedModel: 'test-model',
        chats: [chat],
        currentChat: chat,
        setChats: noopSetChats,
        setCurrentChat: noopSetCurrentChat,
      }),
    )

    expect(scanPendingChatRecoveriesMock).toHaveBeenCalledWith('user-1', false)
    unmount()
  })

  it('scans a recovery loaded after the initial page scan', () => {
    authState.isSignedIn = true
    authState.userId = 'user-1'
    const chat = createChat('chat-a')
    const { rerender } = renderHook(
      ({ currentChat }: { currentChat: Chat }) =>
        useChatMessaging({
          systemPrompt: '',
          rules: '',
          storeHistory: true,
          models: testModels,
          selectedModel: 'test-model',
          chats: [currentChat],
          currentChat,
          setChats: noopSetChats,
          setCurrentChat: noopSetCurrentChat,
        }),
      {
        initialProps: { currentChat: chat },
      },
    )
    scanPendingChatRecoveriesMock.mockClear()

    rerender({
      currentChat: {
        ...chat,
        pendingRecoveries: [
          {
            v: 1,
            storage: 'local',
            turnId: 'turn-1',
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            sessionId: '0123456789abcdef0123456789abcdef',
            recoveryToken: 'token',
          },
        ],
      },
    })

    expect(scanPendingChatRecoveriesMock).toHaveBeenCalledWith('user-1', true)
  })
})
