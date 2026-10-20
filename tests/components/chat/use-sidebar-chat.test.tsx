import { useSidebarChat } from '@/components/chat/hooks/use-sidebar-chat'
import { getView, harnessAPI } from '@/services/harness/runtime'
import { HarnessError } from '@/services/harness/sse'
import { act, renderHook, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'

it('rejoins an ask under the thread the harness created for it', async () => {
  const events = vi.mocked(harnessAPI().client.events)
  events.mockImplementationOnce(async function* () {
    yield {
      id: 0,
      event: { type: 'RUN_STARTED', threadId: 'ask-thread', runId: 'ask-run' },
    }
    yield {
      id: 1,
      event: {
        type: 'TEXT_MESSAGE_CHUNK',
        messageId: 'answer',
        delta: 'Explanation',
      },
    }
    throw new TypeError('connection closed')
  })
  events.mockImplementationOnce(async function* () {
    yield {
      id: 0,
      event: { type: 'RUN_STARTED', threadId: 'ask-thread', runId: 'ask-run' },
    }
    yield {
      id: 1,
      event: {
        type: 'TEXT_MESSAGE_CHUNK',
        messageId: 'answer',
        delta: 'Explanation',
      },
    }
    yield {
      id: 2,
      event: {
        type: 'TEXT_MESSAGE_CHUNK',
        messageId: 'answer',
        delta: ' continued',
      },
    }
    yield {
      id: 3,
      event: { type: 'RUN_FINISHED', threadId: 'ask-thread', runId: 'ask-run' },
    }
  })
  const { result } = renderHook(() =>
    useSidebarChat({
      context: async () => ({ threadId: 'source', local: true }),
      options: {},
    }),
  )
  act(() => result.current.askQuote('Selected text'))
  await waitFor(() =>
    expect(result.current.messages.map((m) => m.content)).toEqual([
      'Explanation continued',
    ]),
  )
  expect(events.mock.calls[1].slice(0, 2)).toEqual([
    '/v1/threads/follow',
    { threadId: 'ask-thread', runId: 'ask-run' },
  ])
})

it('stops streaming a cancelled ask and keeps its partial answer', async () => {
  let streamSignal: AbortSignal | undefined
  let streamExited!: () => void
  const exited = new Promise<void>((resolve) => (streamExited = resolve))
  vi.mocked(harnessAPI().client.events).mockImplementation(
    async function* (_path, _input, signal) {
      streamSignal = signal
      try {
        yield {
          id: 0,
          event: { type: 'RUN_STARTED', threadId: 'thread-1', runId: 'run-1' },
        }
        yield {
          id: 1,
          event: {
            type: 'TEXT_MESSAGE_CHUNK',
            messageId: 'answer',
            delta: 'It means',
            timestamp: '2026-05-01T10:00:00Z',
          },
        }
        // Like a fetch, the stream fails once its signal aborts.
        await new Promise((_, reject) =>
          signal!.addEventListener('abort', () => reject(signal!.reason)),
        )
      } finally {
        streamExited()
      }
    },
  )
  vi.mocked(harnessAPI().client.post).mockImplementation(async (path) => {
    if (path !== '/v1/threads/cancel')
      throw new Error(`Unexpected request: ${path}`)
    return {}
  })
  const { result } = renderHook(() =>
    useSidebarChat({
      context: async () => ({ threadId: 'thread-1', key: 'content-key' }),
      options: { model: 'test-model' },
    }),
  )
  act(() => result.current.askQuote('What does this mean?'))
  await waitFor(() =>
    expect(result.current.messages.map((m) => m.content)).toEqual(['It means']),
  )
  expect(result.current.isStreaming).toBe(true)

  await act(async () => result.current.cancel())

  // The stream itself must end, not only the hook's view of it.
  expect(streamSignal?.aborted).toBe(true)
  await exited
  expect(result.current.isStreaming).toBe(false)
  expect(result.current.loadingState).toBe('idle')
  expect(result.current.messages.map((m) => m.content)).toEqual(['It means'])
  expect(vi.mocked(harnessAPI().client.post)).toHaveBeenCalledWith(
    '/v1/threads/cancel',
    expect.objectContaining({ threadId: 'thread-1', runId: 'run-1' }),
    expect.any(AbortSignal),
  )
})

it('shows why an ask failed before the harness sent any message, and the quota it reports', async () => {
  const rateLimit = {
    kind: 'free_daily' as const,
    maxRequests: 20,
    remaining: 0,
    resetsAt: '2026-05-02T00:00:00Z',
  }
  vi.mocked(harnessAPI().client.events).mockImplementation(async function* () {
    throw new HarnessError(
      {
        code: 'QUOTA_EXHAUSTED',
        message: 'The daily limit is reached',
        kind: 'free_daily',
        resetsAt: '2026-05-02T00:00:00Z',
        rateLimit,
      },
      429,
    )
  })
  const { result } = renderHook(() =>
    useSidebarChat({
      context: async () => ({ threadId: 'thread-1', key: 'content-key' }),
      options: { model: 'test-model' },
    }),
  )

  act(() => result.current.askQuote('What does this mean?'))

  await waitFor(() =>
    expect(result.current.messages).toEqual([
      {
        role: 'assistant',
        content: 'Error: The daily limit is reached',
        timestamp: expect.any(Date),
        isError: true,
      },
    ]),
  )
  expect(result.current.isStreaming).toBe(false)
  expect(getView().rateLimit).toEqual(rateLimit)
  expect(vi.mocked(harnessAPI().client.events)).toHaveBeenCalledWith(
    '/v1/threads/turn',
    expect.objectContaining({
      kind: 'ask',
      threadId: 'thread-1',
      key: 'content-key',
      ephemeral: true,
      content: 'What does this mean?',
      quote: 'What does this mean?',
    }),
    expect.any(AbortSignal),
  )
})

it('shows why the chat an ask reads could not be read, and sends no turn', async () => {
  const { result } = renderHook(() =>
    useSidebarChat({
      context: async () => {
        throw new DOMException(
          'The chat database is unavailable',
          'UnknownError',
        )
      },
      options: { model: 'test-model' },
    }),
  )

  act(() => result.current.askQuote('What does this mean?'))

  await waitFor(() =>
    expect(result.current.messages).toEqual([
      {
        role: 'assistant',
        content: 'Error: The chat database is unavailable',
        timestamp: expect.any(Date),
        isError: true,
      },
    ]),
  )
  expect(vi.mocked(harnessAPI().client.events)).not.toHaveBeenCalled()
  act(() => result.current.reset())
  expect(result.current.messages).toEqual([])
})
