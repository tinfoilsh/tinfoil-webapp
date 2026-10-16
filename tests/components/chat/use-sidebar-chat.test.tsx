import { useSidebarChat } from '@/components/chat/hooks/use-sidebar-chat'
import { harnessAPI } from '@/services/harness/runtime'
import { HarnessError } from '@/services/harness/sse'
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'

beforeEach(() => {
  vi.mocked(harnessAPI().client.events).mockReset()
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

it('shows why an ask failed before the harness sent any message', async () => {
  vi.mocked(harnessAPI().client.events).mockImplementation(async function* () {
    throw new HarnessError(
      { code: 'QUOTA_EXHAUSTED', message: 'The daily limit is reached' },
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
