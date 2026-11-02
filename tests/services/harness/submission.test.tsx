import { DEFAULT_CHAT_TITLE } from '@/constants/chat'
import { localSummary } from '@/services/harness/local-threads'
import { HarnessError } from '@/services/harness/sse'
import type { Frame, ThreadSummary, Turn } from '@/services/harness/types'
import { useThread } from '@/services/harness/use-thread'
import { act, renderHook, waitFor } from '@testing-library/react'
import { expect, it } from 'vitest'
import { client, KEY, signIn } from '../../harness-fixture'
import { resetChatStoresAroundEachTest, storedThread } from './thread-fixture'

resetChatStoresAroundEachTest()

const RECORD_VERSION = 1

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

it.each([
  { name: 'cloud', local: false, temporary: false, projectId: null },
  { name: 'project', local: false, temporary: false, projectId: 'project-1' },
  { name: 'local', local: true, temporary: false, projectId: null },
  { name: 'temporary', local: false, temporary: true, projectId: null },
])(
  'shows the correct sidebar entry for a $name chat throughout its first send',
  async ({ local, temporary, projectId }) => {
    signIn({ cloud: true })
    const accepted = gate()
    const titled = gate()
    const saved: ThreadSummary[] = []
    client.post.mockImplementation(async (path) => {
      if (path === '/v1/threads/list')
        return { threads: [...saved], nextCursor: null }
      throw new Error(`Unexpected ${path}`)
    })
    client.events.mockImplementation(async function* (
      _path: string,
      input: Turn,
    ): AsyncGenerator<Frame> {
      await accepted.promise
      yield {
        id: 0,
        event: {
          type: 'RUN_STARTED',
          threadId: input.threadId!,
          runId: 'new-chat-run',
          instance: 'instance-1',
        },
      }
      await titled.promise
      const thread = storedThread(input.threadId!, {
        title: 'Generated conversation title',
        titleState: 'generated',
        projectId,
        messages: [
          {
            id: input.clientRequestId,
            role: 'user',
            content: input.content ?? '',
            createdAt: new Date().toISOString(),
          },
        ],
      })
      const summary = localSummary(thread)
      if (!local && !temporary) saved.push(summary)
      yield {
        id: 1,
        event: {
          type: 'STATE_SNAPSHOT',
          snapshot: { thread: summary, queue: [], rateLimit: { kind: null } },
        },
      }
      yield {
        id: 2,
        event: {
          type: 'RUN_FINISHED',
          threadId: input.threadId!,
          runId: 'new-chat-run',
          metadata: input.local
            ? { thread: { ...thread, recordVersion: RECORD_VERSION } }
            : {},
        },
      }
    })
    const { result } = renderHook(() =>
      useThread(null, projectId, { newChatLocal: local }),
    )
    await waitFor(() => expect(result.current.loadingChats).toBe(false))
    if (temporary) act(() => result.current.setTemporary(true))
    expect(result.current.chats).toEqual([])
    let sending: Promise<boolean> | undefined
    try {
      act(() => {
        sending = result.current.send({ content: 'My first question' })
      })
      const id = result.current.chat.id
      const firstMessageAt = result.current.chat.messages[0].timestamp
      expect(id).not.toBe('')
      expect(result.current.chats).toEqual(
        temporary
          ? []
          : [
              expect.objectContaining({
                id,
                title: DEFAULT_CHAT_TITLE,
                titleState: 'placeholder',
                pendingSave: true,
                isLocalOnly: local,
                projectId: projectId ?? undefined,
                createdAt: firstMessageAt,
              }),
            ],
      )
      await act(() => result.current.refresh())
      expect(result.current.chats.map((chat) => chat.id)).toEqual(
        temporary ? [] : [id],
      )
      await act(async () => accepted.resolve())
      await waitFor(() => expect(result.current.status).toBe('streaming'))
      expect(result.current.chats.map((chat) => chat.id)).toEqual(
        temporary ? [] : [id],
      )
      await act(async () => {
        titled.resolve()
        await sending
      })
      await waitFor(() =>
        expect(
          result.current.chats.map(({ id, title }) => ({ id, title })),
        ).toEqual(
          temporary ? [] : [{ id, title: 'Generated conversation title' }],
        ),
      )
    } finally {
      await act(async () => {
        accepted.resolve()
        titled.resolve()
        await sending
      })
    }
  },
)

it('keeps the run receipt when an early stop is refused, so reopening rejoins it', async () => {
  signIn()
  const accepted = gate()
  client.post.mockImplementation(async (path) => {
    if (path === '/v1/threads/cancel')
      throw new HarnessError(
        {
          code: 'UPSTREAM_REFUSED',
          message: 'Stop unavailable',
          action: 'retry',
        },
        503,
      )
    throw new Error(`Unexpected ${path}`)
  })
  client.events.mockImplementation(async function* (
    path: string,
    turn: Turn,
  ): AsyncGenerator<Frame> {
    if (path === '/v1/threads/turn') await accepted.promise
    yield {
      id: 0,
      event: {
        type: 'RUN_STARTED',
        threadId: turn.threadId!,
        runId: 'recoverable',
        instance: 'instance-1',
      },
    }
    yield {
      id: 1,
      event: {
        type: 'TEXT_MESSAGE_CHUNK',
        messageId: 'reply',
        role: 'assistant',
        delta: 'Recovered answer',
      },
    }
    yield {
      id: 2,
      event: {
        type: 'RUN_FINISHED',
        threadId: turn.threadId!,
        runId: 'recoverable',
        metadata: {},
      },
    }
  })
  const first = renderHook(() => useThread())
  let sending: Promise<unknown> | undefined
  act(() => {
    sending = first.result.current.send({ content: 'Question to keep' })
  })
  await waitFor(() => expect(client.events).toHaveBeenCalledTimes(1))
  const threadId = first.result.current.chat.id
  await act(() => first.result.current.cancel())
  await act(async () => {
    accepted.resolve()
    await sending
  })
  expect(first.result.current.error).toBe('Stop unavailable')
  expect(JSON.parse(sessionStorage.getItem('harness-run:alice')!)).toEqual({
    threadId,
    runId: 'recoverable',
    instance: 'instance-1',
  })
  first.unmount()
  const second = renderHook(() => useThread(threadId, null, { local: true }))
  await waitFor(() =>
    expect(second.result.current.chat.messages.at(-1)?.content).toBe(
      'Recovered answer',
    ),
  )
  expect(client.events.mock.calls[1].slice(0, 2)).toEqual([
    '/v1/threads/follow',
    { threadId, runId: 'recoverable' },
  ])
  // The reloaded page follows the run at the instance its receipt names.
  expect(client.locate).toHaveBeenCalledExactlyOnceWith(threadId, 'instance-1')
  expect(client.locate.mock.invocationCallOrder[0]).toBeLessThan(
    client.events.mock.invocationCallOrder[1],
  )
})

it('cancels a deleted background chat without stopping the open submission', async () => {
  signIn()
  const background = gate()
  const accepted = gate()
  const finish = gate()
  let firstId = ''
  client.events.mockImplementation(async function* (
    _path: string,
    turn: Turn,
  ): AsyncGenerator<Frame> {
    if (!firstId) {
      firstId = turn.threadId!
      yield {
        id: 0,
        event: {
          type: 'RUN_STARTED',
          threadId: firstId,
          runId: 'background-run',
          instance: 'instance-1',
        },
      }
      await background.promise
      yield {
        id: 1,
        event: {
          type: 'RUN_FINISHED',
          threadId: firstId,
          runId: 'background-run',
          metadata: { cancelled: true },
        },
      }
    } else {
      await accepted.promise
      yield {
        id: 0,
        event: {
          type: 'RUN_STARTED',
          threadId: turn.threadId!,
          runId: 'open-run',
          instance: 'instance-1',
        },
      }
      await finish.promise
      yield {
        id: 1,
        event: {
          type: 'RUN_FINISHED',
          threadId: turn.threadId!,
          runId: 'open-run',
          metadata: {},
        },
      }
    }
  })
  client.post.mockImplementation(async (path) => {
    if (path === '/v1/threads/cancel') {
      background.resolve()
      return { cancelled: true }
    }
    throw new Error(`Unexpected ${path}`)
  })
  const { result } = renderHook(() => useThread())
  let first: Promise<unknown> | undefined
  let second: Promise<unknown> | undefined
  try {
    act(() => {
      first = result.current.send({ content: 'Background question' })
    })
    await waitFor(() => expect(result.current.status).toBe('streaming'))
    act(() => result.current.newChat())
    act(() => {
      second = result.current.send({ content: 'Open question' })
    })
    await waitFor(() => expect(client.events).toHaveBeenCalledTimes(2))
    await act(() => result.current.remove(firstId))
    expect(client.post).toHaveBeenCalledExactlyOnceWith(
      '/v1/threads/cancel',
      { threadId: firstId, runId: 'background-run' },
      expect.any(AbortSignal),
    )
    await act(async () => accepted.resolve())
    expect(result.current.status).toBe('streaming')
    expect(client.post).toHaveBeenCalledTimes(1)
  } finally {
    await act(async () => {
      background.resolve()
      accepted.resolve()
      finish.resolve()
      await Promise.all([first, second])
    })
  }
})

it('retries an unacknowledged stop when the run is rejoined after a failed cancel request', async () => {
  signIn({ cloud: true })
  const accepted = gate()
  const stopped = gate()
  let cancels = 0
  client.post.mockImplementation(async (path) => {
    if (path === '/v1/threads/list') return { threads: [], nextCursor: null }
    if (path === '/v1/threads/cancel') {
      if (++cancels === 1) throw new TypeError('Connection lost')
      stopped.resolve()
      return { cancelled: true }
    }
    throw new Error(`Unexpected ${path}`)
  })
  client.events.mockImplementation(async function* (
    path: string,
    turn: Turn,
  ): AsyncGenerator<Frame> {
    if (path === '/v1/threads/turn') await accepted.promise
    yield {
      id: 0,
      event: {
        type: 'RUN_STARTED',
        threadId: turn.threadId!,
        runId: 'cancel-me',
        instance: 'instance-1',
      },
    }
    await stopped.promise
    yield {
      id: 1,
      event: {
        type: 'RUN_FINISHED',
        threadId: turn.threadId!,
        runId: 'cancel-me',
        metadata: { cancelled: true },
      },
    }
  })
  const { result } = renderHook(() => useThread())
  let sending: Promise<unknown> | undefined
  try {
    act(() => {
      sending = result.current.send({ content: 'Stop before acceptance' })
    })
    await waitFor(() => expect(client.events).toHaveBeenCalledTimes(1))
    await act(() => result.current.cancel())
    await act(async () => accepted.resolve())
    await waitFor(() => expect(cancels).toBe(2))
    const threadId = (client.events.mock.calls[0][1] as Turn).threadId
    expect(
      client.post.mock.calls
        .filter(([path]) => path === '/v1/threads/cancel')
        .map(([, input]) => input),
    ).toEqual([
      { key: KEY, threadId, runId: 'cancel-me' },
      { key: KEY, threadId, runId: 'cancel-me' },
    ])
  } finally {
    await act(async () => {
      accepted.resolve()
      stopped.resolve()
      await sending
    })
  }
})

// Streams a turn's run: it starts, reports its chat, then ends with `end`
// once `release` settles.
function runOf(
  runId: string,
  end: 'finished' | 'failed',
  release: Promise<void> = Promise.resolve(),
) {
  return async function* (_path: string, input: Turn): AsyncGenerator<Frame> {
    const threadId = input.threadId!
    const thread = storedThread(threadId, {
      messages: [
        {
          id: input.clientRequestId,
          role: 'user',
          content: input.content ?? '',
          createdAt: new Date().toISOString(),
        },
      ],
    })
    yield {
      id: 0,
      event: { type: 'RUN_STARTED', threadId, runId, instance: 'instance-1' },
    }
    yield {
      id: 1,
      event: {
        type: 'STATE_SNAPSHOT',
        snapshot: {
          thread: localSummary(thread),
          queue: [],
          rateLimit: { kind: null },
        },
      },
    }
    await release
    yield {
      id: 2,
      event:
        end === 'finished'
          ? {
              type: 'RUN_FINISHED',
              threadId,
              runId,
              metadata: input.local
                ? { thread: { ...thread, recordVersion: RECORD_VERSION } }
                : {},
            }
          : {
              type: 'RUN_ERROR',
              threadId,
              runId,
              code: 'MODEL_UNAVAILABLE',
              message: 'The model is temporarily unavailable',
              action: 'retry',
            },
    }
  }
}

it.each([
  { name: 'stored', local: false },
  { name: 'local', local: true },
])(
  'shows a $name chat as synced only once the harness saved its reply',
  async ({ local }) => {
    signIn({ cloud: true })
    const finished = gate()
    client.post.mockImplementation(async (path) => {
      if (path === '/v1/threads/list') return { threads: [], nextCursor: null }
      throw new Error(`Unexpected ${path}`)
    })
    client.events.mockImplementation(
      runOf('run-1', 'finished', finished.promise),
    )
    const { result } = renderHook(() =>
      useThread(null, null, { newChatLocal: local }),
    )
    await waitFor(() => expect(result.current.loadingChats).toBe(false))
    let sending: Promise<boolean> | undefined
    try {
      act(() => {
        sending = result.current.send({ content: 'Keep this' })
      })
      await waitFor(() => expect(result.current.status).toBe('streaming'))
      expect(result.current.synced).toBe(false)
      await act(async () => {
        finished.resolve()
        await sending
      })
      expect(result.current.status).toBe('idle')
      expect(result.current.synced).toBe(!local)
    } finally {
      await act(async () => {
        finished.resolve()
        await sending
      })
    }
  },
)

it('stops showing a stored chat as synced when its next run fails', async () => {
  signIn({ cloud: true })
  client.post.mockImplementation(async (path) => {
    if (path === '/v1/threads/list') return { threads: [], nextCursor: null }
    throw new Error(`Unexpected ${path}`)
  })
  client.events
    .mockImplementationOnce(runOf('run-1', 'finished'))
    .mockImplementationOnce(runOf('run-2', 'failed'))
  const { result } = renderHook(() => useThread())
  await waitFor(() => expect(result.current.loadingChats).toBe(false))
  await act(() => result.current.send({ content: 'one' }))
  expect(result.current.synced).toBe(true)

  await act(() => result.current.send({ content: 'two' }))

  expect(result.current.status).toBe('error')
  expect(result.current.synced).toBe(false)
})
