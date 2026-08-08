import { useSidebarChat } from '@/components/chat/hooks/use-sidebar-chat'
import type { Message } from '@/components/chat/types'
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { pendingStreams, sendChatStreamMock, streamingChats } = vi.hoisted(
  () => ({
    pendingStreams: [] as Array<{
      options: { onUpdate: (message: Message) => void }
      resolve: (message: Message) => void
    }>,
    sendChatStreamMock: vi.fn(async (..._args: unknown[]) => ({})),
    streamingChats: new Set<string>(),
  }),
)

vi.mock('@/services/cloud/streaming-tracker', () => ({
  streamingTracker: {
    endStreaming: (chatId: string) => streamingChats.delete(chatId),
  },
}))

vi.mock('@/config/models', () => ({
  getKnownModelDisplayName: () => 'Test Model',
  resolveModelSelection: () => ({
    model: { modelName: 'test-model', name: 'Test Model' },
  }),
}))

vi.mock('@/services/inference/inference-client', () => ({
  sendChatStream: (...args: unknown[]) => sendChatStreamMock(...args),
}))

vi.mock('@/components/chat/hooks/streaming', () => ({
  processStreamingResponse: (
    _response: unknown,
    options: { onUpdate: (message: Message) => void },
  ) =>
    new Promise<Message>((resolve) => {
      pendingStreams.push({ options, resolve })
    }),
}))

vi.mock('@/utils/error-handling', () => ({
  logError: vi.fn(),
}))

describe('useSidebarChat', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sendChatStreamMock.mockResolvedValue({})
    pendingStreams.length = 0
    streamingChats.clear()
  })

  it('keeps a restarted stream in control after the cancelled stream settles', async () => {
    const { result } = renderHook(() =>
      useSidebarChat({
        systemPrompt: 'System',
        models: [{} as never],
        selectedModel: 'test-model',
      }),
    )

    act(() => result.current.askQuote('First quote'))
    await vi.waitFor(() => expect(pendingStreams).toHaveLength(1))

    act(() => result.current.askQuote('Second quote'))
    await vi.waitFor(() => expect(pendingStreams).toHaveLength(2))

    const staleMessage: Message = {
      role: 'assistant',
      content: 'Stale answer',
      timestamp: new Date(),
    }
    await act(async () => {
      pendingStreams[0].options.onUpdate(staleMessage)
      pendingStreams[0].resolve(staleMessage)
      await Promise.resolve()
    })

    expect(result.current.quote).toBe('Second quote')
    expect(result.current.messages).not.toContainEqual(staleMessage)
    expect(result.current.isStreaming).toBe(true)

    const activeMessage: Message = {
      role: 'assistant',
      content: 'Current answer',
      timestamp: new Date(),
    }
    await act(async () => {
      pendingStreams[1].options.onUpdate(activeMessage)
      pendingStreams[1].resolve(activeMessage)
      await Promise.resolve()
    })

    expect(result.current.messages.at(-1)).toEqual(activeMessage)
    expect(result.current.isStreaming).toBe(false)
  })

  it('clears ephemeral stream tracking when cancelled', () => {
    const { result } = renderHook(() =>
      useSidebarChat({
        systemPrompt: 'System',
        models: [{} as never],
        selectedModel: 'test-model',
      }),
    )

    act(() => result.current.askQuote('Quote'))
    streamingChats.add('ask-sidebar-ephemeral')

    act(() => result.current.cancel())

    expect(streamingChats).toEqual(new Set())
  })

  it('does not process a response that arrives after cancellation', async () => {
    let resolveResponse!: (response: object) => void
    sendChatStreamMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveResponse = resolve
      }),
    )
    const { result } = renderHook(() =>
      useSidebarChat({
        systemPrompt: 'System',
        models: [{} as never],
        selectedModel: 'test-model',
      }),
    )

    act(() => result.current.askQuote('Quote'))
    await vi.waitFor(() => expect(sendChatStreamMock).toHaveBeenCalled())
    act(() => result.current.cancel())
    await act(async () => resolveResponse({}))

    expect(pendingStreams).toEqual([])
  })
})
