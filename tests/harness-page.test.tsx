import type { HarnessClient } from '@/services/harness/client'
import { HarnessAPI, activateAPI, publish } from '@/services/harness/runtime'
import type { Frame, Thread, Turn } from '@/services/harness/types'
import { useThread } from '@/services/harness/use-thread'
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { testSession } from './harness-fixture'

vi.mock('@/components/chat/genui/registry', () => ({
  GENUI_WIDGETS: [{ name: 'render_chart' }],
}))
const thread: Thread = {
  id: 'thread-1',
  title: 'A chat',
  titleState: 'generated',
  model: 'test-model',
  projectId: null,
  pinned: false,
  webSearchEnabled: true,
  messageCount: 2,
  activeRun: null,
  createdAt: '2026-09-14T10:00:00Z',
  updatedAt: '2026-09-14T10:00:00Z',
  hasOlder: false,
  messages: [],
}
const started: Frame = {
  id: 0,
  event: { type: 'RUN_STARTED', threadId: thread.id, runId: 'run-1' },
}
const messages: Frame = {
  id: 1,
  event: {
    type: 'MESSAGES_SNAPSHOT',
    messages: [
      {
        id: 'u',
        role: 'user',
        content: 'private question',
        createdAt: thread.createdAt,
      },
      {
        id: 'a',
        role: 'assistant',
        createdAt: thread.createdAt,
        timeline: [{ id: 'text', type: 'content', content: 'private answer' }],
      },
    ],
  },
}
const finished: Frame = {
  id: 2,
  event: { type: 'RUN_FINISHED', threadId: thread.id, runId: 'run-1' },
}
let events: ReturnType<typeof vi.fn>
beforeEach(() => {
  sessionStorage.clear()
  events = vi.fn()
  activateAPI(
    new HarnessAPI({ events, post: vi.fn() } as unknown as HarnessClient, null),
  )
  publish({
    session: { ...testSession, widgets: ['render_chart'] },
    keyReady: true,
  })
})
it('sends the first turn selections and renders the server transcript without storing content', async () => {
  events.mockImplementation(async function* () {
    yield started
    yield messages
    yield finished
  })
  const { result } = renderHook(() => useThread(null, 'project-1'))
  act(() => result.current.setPresetId('builtin:tutor'))
  await act(() => result.current.send({ content: 'private question' }))
  const input = events.mock.calls[0][1] as Turn
  expect(input).toMatchObject({
    content: 'private question',
    projectId: 'project-1',
    presetId: 'builtin:tutor',
    ephemeral: true,
    widgets: ['render_chart'],
  })
  expect(input.clientRequestId).toBeTruthy()
  expect(result.current.chat.messages.map((m) => m.content)).toEqual([
    'private question',
    'private answer',
  ])
  expect(sessionStorage.getItem('harness-run:anonymous')).toBe(
    JSON.stringify({ threadId: 'thread-1', runId: 'run-1', temporary: true }),
  )
  expect(localStorage.length).toBe(0)
})
it('retries an ambiguous initial request with its original nonce and input', async () => {
  events
    .mockImplementationOnce(async function* () {
      throw new TypeError('connection closed')
    })
    .mockImplementationOnce(async function* () {
      yield started
      yield messages
      yield finished
    })
  const { result } = renderHook(() => useThread())
  await act(() => result.current.send({ content: 'private question' }))
  expect(result.current.error).toBe('connection closed')
  await act(() => result.current.reconnect())
  expect(events.mock.calls[1][1]).toEqual(events.mock.calls[0][1])
  expect(result.current.chat.messages).toHaveLength(2)
})
it('reattaches an accepted turn by run id and last event cursor', async () => {
  events
    .mockImplementationOnce(async function* () {
      yield started
      yield messages
      throw new TypeError('connection closed')
    })
    .mockImplementationOnce(async function* () {
      yield finished
    })
  const { result } = renderHook(() => useThread())
  await act(() => result.current.send({ content: 'private question' }))
  await act(() => result.current.reconnect())
  expect(events.mock.calls[1][0]).toBe('/v1/threads/follow')
  expect(events.mock.calls[1][1]).toMatchObject({
    threadId: 'thread-1',
    runId: 'run-1',
  })
  expect(events.mock.calls[1][3]).toBe(1)
  expect(result.current.chat.messages).toHaveLength(2)
})
it('ignores a late stream after navigating to a new chat', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  events.mockImplementation(async function* () {
    yield started
    await gate
    yield messages
    yield finished
  })
  const { result } = renderHook(() => useThread())
  let sending!: Promise<void> | undefined
  act(() => {
    sending = result.current.send({ content: 'private question' })
  })
  await waitFor(() => expect(result.current.chat.id).toBe('thread-1'))
  act(() => result.current.newChat())
  await act(async () => {
    release()
    await sending
  })
  expect(result.current.chat.messages).toEqual([])
  expect(result.current.chat.id).toBe('')
})
