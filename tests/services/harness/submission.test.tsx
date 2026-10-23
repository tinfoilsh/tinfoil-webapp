import type { Frame, Turn } from '@/services/harness/types'
import { useThread } from '@/services/harness/use-thread'
import { act, renderHook, waitFor } from '@testing-library/react'
import { expect, it } from 'vitest'
import { client, KEY, signIn } from '../../harness-fixture'
import { resetChatStoresAroundEachTest } from './thread-fixture'

resetChatStoresAroundEachTest()

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

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
        },
      }
      await finish.promise
      yield {
        id: 1,
        event: {
          type: 'RUN_FINISHED',
          threadId: turn.threadId!,
          runId: 'open-run',
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
