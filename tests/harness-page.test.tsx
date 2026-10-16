import type { Frame, Thread, Turn } from '@/services/harness/types'
import { useThread } from '@/services/harness/use-thread'
import { act, renderHook } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { client, signIn, testSession } from './harness-fixture'

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
beforeEach(() => {
  sessionStorage.clear()
  signIn({
    userId: null,
    session: { ...testSession, widgets: ['render_chart'] },
  })
})
it('runs a signed-out first turn as a local thread with its preset and keeps it in the tab', async () => {
  client.events.mockImplementation(async function* () {
    yield started
    yield messages
    yield finished
  })
  const { result } = renderHook(() => useThread(null, 'project-1'))
  act(() => result.current.setPresetId('builtin:tutor'))
  await act(() => result.current.send({ content: 'private question' }))
  const input = client.events.mock.calls[0][1] as Turn
  expect(input).toMatchObject({
    content: 'private question',
    local: true,
    widgets: ['render_chart'],
    thread: { presetId: 'builtin:tutor', messages: [] },
  })
  expect(input).not.toHaveProperty('key')
  expect(input).not.toHaveProperty('projectId')
  expect(input.clientRequestId).toBeTruthy()
  expect(result.current.chat.messages.map((m) => m.content)).toEqual([
    'private question',
    'private answer',
  ])
  expect(sessionStorage.getItem('harness-run:anonymous')).toBeNull()
  const [saved] = JSON.parse(
    sessionStorage.getItem('tinfoil-sync-session-chats') ?? '[]',
  )
  expect(saved).toMatchObject({
    id: 'thread-1',
    presetId: 'builtin:tutor',
    messages: [
      { id: 'u', content: 'private question' },
      { id: 'a', content: 'private answer' },
    ],
  })
  expect(localStorage.length).toBe(0)
})
it('retries an ambiguous initial request with its original nonce and input', async () => {
  client.events
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
  expect(client.events.mock.calls[1][1]).toEqual(client.events.mock.calls[0][1])
  expect(result.current.chat.messages).toHaveLength(2)
})
it('reattaches an accepted turn by run id and last event cursor', async () => {
  client.events
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
  expect(client.events.mock.calls[1][0]).toBe('/v1/threads/follow')
  expect(client.events.mock.calls[1][1]).toMatchObject({
    threadId: 'thread-1',
    runId: 'run-1',
  })
  expect(client.events.mock.calls[1][3]).toBe(1)
  expect(result.current.chat.messages).toHaveLength(2)
})
