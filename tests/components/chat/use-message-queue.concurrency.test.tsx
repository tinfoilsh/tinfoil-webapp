import { useMessageQueue } from '@/components/chat/hooks/use-message-queue'
import type { LoadingState } from '@/components/chat/types'
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve()
  })
}

describe('useMessageQueue concurrency', () => {
  beforeEach(() => {
    window.sessionStorage.clear()
  })

  it('dispatches in a newly active chat while another chat is still streaming', async () => {
    let resolveA: (() => void) | undefined
    const handleQuery = vi.fn((text: string) => {
      if (text === 'A') {
        return new Promise<void>((resolve) => {
          resolveA = resolve
        })
      }
      return Promise.resolve()
    })

    const { result, rerender } = renderHook(
      ({ chatId, loadingState }) =>
        useMessageQueue({
          chatId,
          loadingState,
          handleQuery,
          isRateLimited: () => false,
        }),
      {
        initialProps: {
          chatId: 'chat-a',
          loadingState: 'idle' as LoadingState,
        },
      },
    )

    // Send in chat A; its stream stays in-flight (promise never resolves).
    act(() => {
      result.current.submit({ text: 'A' })
    })
    await flushMicrotasks()
    expect(handleQuery).toHaveBeenCalledTimes(1)
    expect(handleQuery).toHaveBeenLastCalledWith(
      'A',
      undefined,
      undefined,
      undefined,
      undefined,
    )

    // Chat A is now streaming; switch to a different, idle chat B.
    rerender({ chatId: 'chat-a', loadingState: 'loading' as LoadingState })
    rerender({ chatId: 'chat-b', loadingState: 'idle' as LoadingState })

    // Send in chat B; it must dispatch immediately even though chat A's
    // stream has not finished.
    act(() => {
      result.current.submit({ text: 'B' })
    })
    await flushMicrotasks()

    expect(handleQuery).toHaveBeenCalledTimes(2)
    expect(handleQuery).toHaveBeenLastCalledWith(
      'B',
      undefined,
      undefined,
      undefined,
      undefined,
    )

    resolveA?.()
  })

  it('dispatches the first message of a blank chat (empty string id)', async () => {
    const handleQuery = vi.fn(() => Promise.resolve())

    const { result } = renderHook(() =>
      useMessageQueue({
        chatId: '',
        loadingState: 'idle' as LoadingState,
        handleQuery,
        isRateLimited: () => false,
      }),
    )

    act(() => {
      result.current.submit({ text: 'hello' })
    })
    await flushMicrotasks()

    expect(handleQuery).toHaveBeenCalledTimes(1)
    expect(handleQuery).toHaveBeenLastCalledWith(
      'hello',
      undefined,
      undefined,
      undefined,
      undefined,
    )
  })

  it('serializes multiple messages within the same chat', async () => {
    const resolvers: Array<() => void> = []
    const handleQuery = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolvers.push(resolve)
        }),
    )

    const { result } = renderHook(() =>
      useMessageQueue({
        chatId: 'chat-a',
        loadingState: 'idle' as LoadingState,
        handleQuery,
        isRateLimited: () => false,
      }),
    )

    act(() => {
      result.current.submit({ text: 'first' })
      result.current.submit({ text: 'second' })
    })
    await flushMicrotasks()

    // Only the first message dispatches until its stream resolves.
    expect(handleQuery).toHaveBeenCalledTimes(1)
    expect(handleQuery).toHaveBeenLastCalledWith(
      'first',
      undefined,
      undefined,
      undefined,
      undefined,
    )

    act(() => {
      resolvers[0]?.()
    })
    await flushMicrotasks()

    expect(handleQuery).toHaveBeenCalledTimes(2)
    expect(handleQuery).toHaveBeenLastCalledWith(
      'second',
      undefined,
      undefined,
      undefined,
      undefined,
    )

    resolvers[1]?.()
  })
})
