import {
  QueueIdentifierUnavailableError,
  useMessageQueue,
} from '@/components/chat/hooks/use-message-queue'
import type { Attachment, LoadingState } from '@/components/chat/types'
import { MESSAGE_QUEUE_PREFIX } from '@/constants/storage-keys'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve()
  })
}

// handleQuery mock whose 'A' dispatch never settles, mimicking a cancelled
// stream whose cleanup hangs; every other dispatch resolves immediately.
function createWedgedHandleQuery() {
  return vi.fn((text: string) => {
    if (text === 'A') return new Promise<void>(() => {})
    return Promise.resolve()
  })
}

describe('useMessageQueue concurrency', () => {
  beforeEach(() => {
    window.sessionStorage.clear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('leaves the queue unchanged when secure IDs are unavailable', () => {
    const storageKey = `${MESSAGE_QUEUE_PREFIX}chat-a`
    const existing = [{ id: 'existing', text: 'already queued' }]
    window.sessionStorage.setItem(storageKey, JSON.stringify(existing))
    vi.stubGlobal('crypto', {})

    const { result } = renderHook(() =>
      useMessageQueue({
        chatId: 'chat-a',
        loadingState: 'loading' as LoadingState,
        handleQuery: vi.fn(),
        isRateLimited: () => false,
      }),
    )

    expect(() =>
      act(() => result.current.submit({ text: 'new message' })),
    ).toThrow(QueueIdentifierUnavailableError)
    expect(result.current.queuedMessages).toEqual(existing)
    expect(
      JSON.parse(window.sessionStorage.getItem(storageKey) ?? '[]'),
    ).toEqual(existing)
  })

  it('clears queued messages and their persisted copy', () => {
    const storageKey = `${MESSAGE_QUEUE_PREFIX}chat-a`
    const { result } = renderHook(() =>
      useMessageQueue({
        chatId: 'chat-a',
        loadingState: 'loading' as LoadingState,
        handleQuery: vi.fn(),
        isRateLimited: () => false,
      }),
    )

    act(() => result.current.submit({ text: 'queued message' }))
    expect(result.current.queuedMessages).toHaveLength(1)
    expect(window.sessionStorage.getItem(storageKey)).not.toBeNull()

    act(() => result.current.clearQueuedMessages())

    expect(result.current.queuedMessages).toEqual([])
    expect(window.sessionStorage.getItem(storageKey)).toBeNull()
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
      expect.any(Function),
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
      expect.any(Function),
    )

    resolveA?.()
  })

  it('dispatches the first message of a blank chat (empty string id)', async () => {
    const handleQuery = vi.fn((_text: string) => Promise.resolve())

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
      expect.any(Function),
    )
  })

  it('keeps local and cloud blank queues isolated while dispatch is blocked', async () => {
    const handleQuery = vi.fn((_text: string) => Promise.resolve())
    let blocked = true

    const { result, rerender } = renderHook(
      ({ queueId, dispatchBlocked }) =>
        useMessageQueue({
          chatId: '',
          queueId,
          loadingState: 'idle' as LoadingState,
          handleQuery,
          isRateLimited: () => false,
          isDispatchBlocked: () => blocked,
          dispatchBlocked,
        }),
      {
        initialProps: {
          queueId: 'blank-local',
          dispatchBlocked: true as boolean,
        },
      },
    )

    act(() => result.current.submit({ text: 'local message' }))
    rerender({ queueId: 'blank-cloud', dispatchBlocked: true })
    act(() => result.current.submit({ text: 'cloud message' }))
    await flushMicrotasks()

    expect(handleQuery).not.toHaveBeenCalled()
    expect(result.current.queuedMessages.map(({ text }) => text)).toEqual([
      'cloud message',
    ])

    blocked = false
    rerender({ queueId: 'blank-cloud', dispatchBlocked: false })
    await flushMicrotasks()
    expect(handleQuery).toHaveBeenCalledTimes(1)
    expect(handleQuery.mock.calls[0][0]).toBe('cloud message')

    rerender({ queueId: 'blank-local', dispatchBlocked: false })
    await flushMicrotasks()
    expect(handleQuery).toHaveBeenCalledTimes(2)
    expect(handleQuery.mock.calls[1][0]).toBe('local message')
  })

  it('never persists a temporary chat queue and clears it on mode exit', async () => {
    const handleQuery = vi.fn(() => Promise.resolve())
    const { result, rerender } = renderHook(
      ({ queueId, persistQueue }) =>
        useMessageQueue({
          chatId: queueId,
          queueId,
          persistQueue,
          loadingState: 'loading' as LoadingState,
          handleQuery,
          isRateLimited: () => false,
        }),
      {
        initialProps: {
          queueId: 'temporary-chat',
          persistQueue: false as boolean,
        },
      },
    )
    const attachment = {
      id: 'private-image',
      type: 'image',
      fileName: 'private.png',
      mimeType: 'image/png',
      base64: 'private-payload',
    } as Attachment

    act(() => {
      result.current.submit({
        text: 'private text',
        attachments: [attachment],
      })
    })

    expect(
      window.sessionStorage.getItem(`${MESSAGE_QUEUE_PREFIX}temporary-chat`),
    ).toBeNull()
    expect(result.current.queuedMessages).toHaveLength(1)

    rerender({ queueId: 'permanent-chat', persistQueue: true })
    expect(result.current.queuedMessages).toEqual([])
    expect(window.sessionStorage.length).toBe(0)
  })

  it('requeues the complete item once when dispatch never starts', async () => {
    const attachment = {
      id: 'document-1',
      type: 'document',
      fileName: 'notes.txt',
      textContent: 'full attachment',
    } as Attachment
    const handleQuery = vi.fn(async () => ({
      status: 'not-started' as const,
      reason: 'chat-unavailable' as const,
    }))
    const { result } = renderHook(() =>
      useMessageQueue({
        chatId: 'chat-a',
        loadingState: 'idle' as LoadingState,
        handleQuery,
        isRateLimited: () => false,
      }),
    )

    act(() => {
      result.current.submit({
        text: 'keep me',
        attachments: [attachment],
        quote: 'quoted context',
      })
    })
    await flushMicrotasks()

    expect(handleQuery).toHaveBeenCalledTimes(1)
    expect(result.current.queuedMessages).toEqual([
      expect.objectContaining({
        text: 'keep me',
        attachments: [attachment],
        quote: 'quoted context',
      }),
    ])
    await flushMicrotasks()
    expect(handleQuery).toHaveBeenCalledTimes(1)
  })

  it('retries a transiently blocked item when dispatch becomes available', async () => {
    const handleQuery = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'not-started' as const,
        reason: 'blocked' as const,
      })
      .mockResolvedValueOnce({ status: 'accepted' as const })
    const { result, rerender } = renderHook(
      ({ dispatchBlocked }) =>
        useMessageQueue({
          chatId: 'chat-a',
          loadingState: 'idle' as LoadingState,
          handleQuery,
          isRateLimited: () => false,
          dispatchBlocked,
        }),
      { initialProps: { dispatchBlocked: false } },
    )

    act(() => result.current.submit({ text: 'send after recovery' }))
    await flushMicrotasks()
    expect(handleQuery).toHaveBeenCalledTimes(1)
    expect(result.current.queuedMessages).toHaveLength(1)

    rerender({ dispatchBlocked: true })
    rerender({ dispatchBlocked: false })
    await flushMicrotasks()

    expect(handleQuery).toHaveBeenCalledTimes(2)
    expect(result.current.queuedMessages).toEqual([])
  })

  it('re-keys a blank queue to the created chat id', async () => {
    let resolveFirst!: () => void
    const handleQuery = vi.fn((text: string) =>
      text === 'first'
        ? new Promise<void>((resolve) => {
            resolveFirst = resolve
          })
        : Promise.resolve(),
    )

    const { result, rerender } = renderHook(
      ({ chatId, queueId, loadingState }) =>
        useMessageQueue({
          chatId,
          queueId,
          loadingState,
          handleQuery,
          isRateLimited: () => false,
        }),
      {
        initialProps: {
          chatId: '',
          queueId: 'blank-local',
          loadingState: 'idle' as LoadingState,
        },
      },
    )

    act(() => {
      result.current.submit({ text: 'first' })
      result.current.submit({ text: 'second' })
    })
    await flushMicrotasks()
    expect(handleQuery).toHaveBeenCalledTimes(1)

    rerender({
      chatId: 'real-chat',
      queueId: 'real-chat',
      loadingState: 'loading' as LoadingState,
    })
    expect(result.current.queuedMessages.map(({ text }) => text)).toEqual([
      'second',
    ])
    expect(
      JSON.parse(
        window.sessionStorage.getItem(`${MESSAGE_QUEUE_PREFIX}real-chat`) ??
          '[]',
      ).map(({ text }: { text: string }) => text),
    ).toEqual(['second'])

    act(() => resolveFirst())
    rerender({
      chatId: 'real-chat',
      queueId: 'real-chat',
      loadingState: 'idle' as LoadingState,
    })
    await flushMicrotasks()
    expect(handleQuery).toHaveBeenCalledTimes(2)
    expect(handleQuery.mock.calls[1][0]).toBe('second')
  })

  it('frees the blank chat id after conversion so the next new chat can send', async () => {
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
          chatId: '',
          loadingState: 'idle' as LoadingState,
        },
      },
    )

    // First message in a brand-new blank chat; its stream stays in-flight.
    act(() => {
      result.current.submit({ text: 'A' })
    })
    await flushMicrotasks()
    expect(handleQuery).toHaveBeenCalledTimes(1)

    // The blank chat converts to a real id and keeps streaming.
    rerender({ chatId: 'real-1', loadingState: 'loading' as LoadingState })
    await flushMicrotasks()

    // User opens a fresh blank chat (the empty id is reused) and sends; it
    // must dispatch immediately even though the first chat is still
    // streaming.
    rerender({ chatId: '', loadingState: 'idle' as LoadingState })
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
      expect.any(Function),
    )

    resolveA?.()
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
      expect.any(Function),
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
      expect.any(Function),
    )

    resolvers[1]?.()
  })

  it('dispatches the next message when the completed response becomes interactive', async () => {
    const resolvers: Array<() => void> = []
    const readyCallbacks: Array<() => void> = []
    const handleQuery = vi.fn(
      (
        _text: string,
        _attachments: unknown,
        _systemPromptOverride: unknown,
        _baseMessages: unknown,
        _quote: unknown,
        onReadyForNextMessage?: () => void,
      ) => {
        if (onReadyForNextMessage) readyCallbacks.push(onReadyForNextMessage)
        return new Promise<void>((resolve) => {
          resolvers.push(resolve)
        })
      },
    )

    const { result, rerender } = renderHook(
      ({ loadingState }) =>
        useMessageQueue({
          chatId: 'chat-a',
          loadingState,
          handleQuery,
          isRateLimited: () => false,
        }),
      { initialProps: { loadingState: 'idle' as LoadingState } },
    )

    act(() => result.current.submit({ text: 'first' }))
    await flushMicrotasks()
    rerender({ loadingState: 'loading' as LoadingState })
    act(() => result.current.submit({ text: 'second' }))
    await flushMicrotasks()

    expect(handleQuery).toHaveBeenCalledTimes(1)
    expect(result.current.queuedMessages.map(({ text }) => text)).toEqual([
      'second',
    ])

    rerender({ loadingState: 'idle' as LoadingState })
    act(() => readyCallbacks[0]?.())
    await flushMicrotasks()

    expect(handleQuery).toHaveBeenCalledTimes(2)
    expect(handleQuery.mock.calls[1][0]).toBe('second')
    expect(result.current.queuedMessages).toEqual([])

    resolvers.forEach((resolve) => resolve())
  })

  it('parks a queued message when switching away and resumes on return', async () => {
    const handleQuery = vi.fn(() => Promise.resolve())

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
          chatId: 'A',
          loadingState: 'loading' as LoadingState,
        },
      },
    )

    // Chat A is mid-stream; the queued message must not dispatch yet.
    act(() => {
      result.current.submit({ text: 'q1' })
    })
    await flushMicrotasks()
    expect(handleQuery).not.toHaveBeenCalled()

    // Switch to an idle chat B; q1 stays parked on A (not dispatched to B).
    rerender({ chatId: 'B', loadingState: 'idle' as LoadingState })
    await flushMicrotasks()
    expect(handleQuery).not.toHaveBeenCalled()

    // Return to A, now finished streaming; the parked message dispatches.
    rerender({ chatId: 'A', loadingState: 'idle' as LoadingState })
    await flushMicrotasks()
    expect(handleQuery).toHaveBeenCalledTimes(1)
    expect(handleQuery).toHaveBeenLastCalledWith(
      'q1',
      undefined,
      undefined,
      undefined,
      undefined,
      expect.any(Function),
    )
  })

  it('holds a message while rate-limited and resumes when the limit clears', async () => {
    const handleQuery = vi.fn(() => Promise.resolve())
    const onRateLimited = vi.fn()

    const { result, rerender } = renderHook(
      ({ isRateLimited }) =>
        useMessageQueue({
          chatId: 'A',
          loadingState: 'idle' as LoadingState,
          handleQuery,
          isRateLimited,
          onRateLimited,
        }),
      { initialProps: { isRateLimited: () => true } },
    )

    act(() => {
      result.current.submit({ text: 'q1' })
    })
    await flushMicrotasks()

    // Held: prompt shown once, nothing dispatched, no busy-spin.
    expect(handleQuery).not.toHaveBeenCalled()
    expect(onRateLimited).toHaveBeenCalledTimes(1)

    // The limit clears (new predicate identity drives the resume effect).
    rerender({ isRateLimited: () => false })
    await flushMicrotasks()

    expect(handleQuery).toHaveBeenCalledTimes(1)
    expect(handleQuery).toHaveBeenLastCalledWith(
      'q1',
      undefined,
      undefined,
      undefined,
      undefined,
      expect.any(Function),
    )
  })

  it('holds a queued message while recovery is active', async () => {
    const handleQuery = vi.fn(() => Promise.resolve())
    let recoveryActive = true

    const { result, rerender } = renderHook(
      ({ dispatchBlocked }) =>
        useMessageQueue({
          chatId: 'A',
          loadingState: 'idle' as LoadingState,
          handleQuery,
          isRateLimited: () => false,
          isDispatchBlocked: () => recoveryActive,
          dispatchBlocked,
        }),
      { initialProps: { dispatchBlocked: true } },
    )

    act(() => {
      result.current.submit({ text: 'q1' })
    })
    await flushMicrotasks()

    expect(handleQuery).not.toHaveBeenCalled()
    expect(
      result.current.queuedMessages.map((message) => message.text),
    ).toEqual(['q1'])

    recoveryActive = false
    rerender({ dispatchBlocked: false })
    await flushMicrotasks()

    expect(handleQuery).toHaveBeenCalledTimes(1)
    expect(handleQuery).toHaveBeenLastCalledWith(
      'q1',
      undefined,
      undefined,
      undefined,
      undefined,
      expect.any(Function),
    )
  })

  it('removes a specific queued message from the active chat', async () => {
    const handleQuery = vi.fn(() => new Promise<void>(() => {}))

    const { result } = renderHook(() =>
      useMessageQueue({
        chatId: 'A',
        loadingState: 'loading' as LoadingState,
        handleQuery,
        isRateLimited: () => false,
      }),
    )

    act(() => {
      result.current.submit({ text: 'q1' })
      result.current.submit({ text: 'q2' })
    })
    await flushMicrotasks()

    expect(result.current.queuedMessages.map((m) => m.text)).toEqual([
      'q1',
      'q2',
    ])
    expect(handleQuery).not.toHaveBeenCalled()

    const firstId = result.current.queuedMessages[0].id
    act(() => {
      result.current.removeQueuedMessage(firstId)
    })

    expect(result.current.queuedMessages.map((m) => m.text)).toEqual(['q2'])
  })

  it('keeps each chat queue isolated and renders the active one', async () => {
    const handleQuery = vi.fn(() => new Promise<void>(() => {}))

    const { result, rerender } = renderHook(
      ({ chatId }) =>
        useMessageQueue({
          chatId,
          loadingState: 'loading' as LoadingState,
          handleQuery,
          isRateLimited: () => false,
        }),
      { initialProps: { chatId: 'A' } },
    )

    act(() => {
      result.current.submit({ text: 'a-msg' })
    })
    await flushMicrotasks()
    expect(result.current.queuedMessages.map((m) => m.text)).toEqual(['a-msg'])

    // Switching to B shows B's (empty) queue without losing A's.
    rerender({ chatId: 'B' })
    expect(result.current.queuedMessages).toEqual([])

    rerender({ chatId: 'A' })
    expect(result.current.queuedMessages.map((m) => m.text)).toEqual(['a-msg'])
  })

  it('sends a queued message on demand while the pump is wedged on a cancelled stream', async () => {
    // The chat goes idle after Stop but the pump stays parked on A's
    // unsettled promise.
    const handleQuery = createWedgedHandleQuery()

    const { result, rerender } = renderHook(
      ({ loadingState }) =>
        useMessageQueue({
          chatId: 'chat-a',
          loadingState,
          handleQuery,
          isRateLimited: () => false,
        }),
      { initialProps: { loadingState: 'idle' as LoadingState } },
    )

    act(() => {
      result.current.submit({ text: 'A' })
    })
    await flushMicrotasks()
    expect(handleQuery).toHaveBeenCalledTimes(1)

    rerender({ loadingState: 'loading' as LoadingState })
    act(() => {
      result.current.submit({ text: 'B', quote: 'quoted' })
      result.current.submit({ text: 'C' })
    })
    await flushMicrotasks()
    expect(handleQuery).toHaveBeenCalledTimes(1)

    // User presses Stop; the chat goes idle but the pump stays parked on
    // A's unsettled promise, so nothing is auto-dispatched.
    rerender({ loadingState: 'idle' as LoadingState })
    await flushMicrotasks()
    expect(handleQuery).toHaveBeenCalledTimes(1)

    const queuedId = result.current.queuedMessages[0].id
    act(() => {
      result.current.sendQueuedMessage(queuedId)
    })
    await flushMicrotasks()

    // The send unwedges the pump, which dispatches B and then keeps
    // draining the rest of the queue (C) without further manual sends.
    expect(handleQuery).toHaveBeenCalledTimes(3)
    expect(handleQuery.mock.calls[1]).toEqual([
      'B',
      undefined,
      undefined,
      undefined,
      'quoted',
      expect.any(Function),
    ])
    expect(handleQuery.mock.calls[2][0]).toBe('C')
    expect(result.current.queuedMessages).toEqual([])
  })

  it('interrupts the active stream when sending a queued message midstream', async () => {
    // The active stream's promise never settles even after cancellation,
    // mimicking the worst-case cancelled-stream cleanup.
    const handleQuery = createWedgedHandleQuery()
    const cancelGeneration = vi.fn()

    const { result, rerender } = renderHook(
      ({ loadingState }) =>
        useMessageQueue({
          chatId: 'chat-a',
          loadingState,
          handleQuery,
          isRateLimited: () => false,
          cancelGeneration,
        }),
      { initialProps: { loadingState: 'idle' as LoadingState } },
    )

    act(() => {
      result.current.submit({ text: 'A' })
    })
    await flushMicrotasks()
    expect(handleQuery).toHaveBeenCalledTimes(1)

    rerender({ loadingState: 'loading' as LoadingState })
    act(() => {
      result.current.submit({ text: 'q1' })
      result.current.submit({ text: 'q2' })
    })
    await flushMicrotasks()
    expect(handleQuery).toHaveBeenCalledTimes(1)

    // Send q2 midstream: the active stream is cancelled and q2 jumps the
    // queue, dispatching as soon as the chat settles back to idle.
    const secondId = result.current.queuedMessages[1].id
    act(() => {
      result.current.sendQueuedMessage(secondId)
    })
    await flushMicrotasks()
    expect(cancelGeneration).toHaveBeenCalledWith('chat-a')
    expect(result.current.queuedMessages.map((m) => m.text)).toEqual([
      'q2',
      'q1',
    ])

    // Cancellation settles the chat to idle; q2 goes out first, then q1.
    rerender({ loadingState: 'idle' as LoadingState })
    await flushMicrotasks()
    expect(handleQuery).toHaveBeenCalledTimes(3)
    expect(handleQuery.mock.calls[1][0]).toBe('q2')
    expect(handleQuery.mock.calls[2][0]).toBe('q1')
    expect(result.current.queuedMessages).toEqual([])
  })

  it('auto-drains after Stop even when the cancelled dispatch never settles', async () => {
    const handleQuery = createWedgedHandleQuery()

    const { result, rerender } = renderHook(
      ({ loadingState }) =>
        useMessageQueue({
          chatId: 'chat-a',
          loadingState,
          handleQuery,
          isRateLimited: () => false,
        }),
      { initialProps: { loadingState: 'idle' as LoadingState } },
    )

    act(() => {
      result.current.submit({ text: 'A' })
    })
    await flushMicrotasks()
    expect(handleQuery).toHaveBeenCalledTimes(1)

    rerender({ loadingState: 'loading' as LoadingState })
    act(() => {
      result.current.submit({ text: 'B' })
    })
    await flushMicrotasks()
    expect(handleQuery).toHaveBeenCalledTimes(1)

    // Stop button: the cancellation is reported explicitly, then the chat
    // settles to idle. The pump abandons A's dead promise and sends B
    // without any manual action.
    act(() => {
      result.current.notifyGenerationCancelled('chat-a')
    })
    rerender({ loadingState: 'idle' as LoadingState })
    await flushMicrotasks()

    expect(handleQuery).toHaveBeenCalledTimes(2)
    expect(handleQuery).toHaveBeenLastCalledWith(
      'B',
      undefined,
      undefined,
      undefined,
      undefined,
      expect.any(Function),
    )
    expect(result.current.queuedMessages).toEqual([])
  })

  it('holds an on-demand send while rate-limited', async () => {
    const handleQuery = vi.fn(() => Promise.resolve())
    const onRateLimited = vi.fn()

    const { result } = renderHook(() =>
      useMessageQueue({
        chatId: 'chat-a',
        loadingState: 'idle' as LoadingState,
        handleQuery,
        isRateLimited: () => true,
        onRateLimited,
      }),
    )

    act(() => {
      result.current.submit({ text: 'q1' })
    })
    await flushMicrotasks()
    expect(handleQuery).not.toHaveBeenCalled()

    const queuedId = result.current.queuedMessages[0].id
    act(() => {
      result.current.sendQueuedMessage(queuedId)
    })
    await flushMicrotasks()

    expect(handleQuery).not.toHaveBeenCalled()
    expect(result.current.queuedMessages.map((m) => m.text)).toEqual(['q1'])
    expect(onRateLimited).toHaveBeenCalled()
  })

  it('drains multiple messages when handleQuery is synchronous (void)', async () => {
    const calls: string[] = []
    const handleQuery = vi.fn((text: string) => {
      calls.push(text)
    })

    const { result } = renderHook(() =>
      useMessageQueue({
        chatId: 'A',
        loadingState: 'idle' as LoadingState,
        handleQuery,
        isRateLimited: () => false,
      }),
    )

    act(() => {
      result.current.submit({ text: 'q1' })
      result.current.submit({ text: 'q2' })
    })
    await flushMicrotasks()

    expect(calls).toEqual(['q1', 'q2'])
  })
})
