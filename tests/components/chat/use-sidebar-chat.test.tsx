import { useSidebarChat } from '@/components/chat/hooks/use-sidebar-chat'
import { harnessAPI } from '@/services/harness/runtime'
import { HarnessError } from '@/services/harness/sse'
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'

beforeEach(() => {
  vi.mocked(harnessAPI().client.events).mockReset()
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
