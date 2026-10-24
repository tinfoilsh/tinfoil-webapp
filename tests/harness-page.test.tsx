import type { FollowRequest } from '@/services/harness/client'
import type { Frame, Message, Thread, Turn } from '@/services/harness/types'
import { useThread } from '@/services/harness/use-thread'
import { act, renderHook } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { CACHE_SECRET, client, signIn, testSession } from './harness-fixture'

vi.mock('@/components/chat/genui/registry', () => ({
  GENUI_WIDGETS: [{ name: 'render_chart' }],
}))
const thread: Thread = {
  id: 'thread-1',
  title: 'A chat',
  titleState: 'generated',
  model: 'test-model',
  projectId: null,
  presetId: null,
  pinned: false,
  webSearchEnabled: true,
  contextUsage: null,
  messageCount: 2,
  activeRun: null,
  createdAt: '2026-09-14T10:00:00Z',
  updatedAt: '2026-09-14T10:00:00Z',
  activityAt: '2026-09-14T10:00:00Z',
  hasOlder: false,
  messages: [],
}
const started: Frame = {
  id: 0,
  event: {
    type: 'RUN_STARTED',
    threadId: thread.id,
    runId: 'run-1',
    instance: 'instance-1',
  },
}
const answered: Message[] = [
  {
    id: 'u',
    role: 'user',
    content: 'private question',
    createdAt: '2026-09-14T10:00:00Z',
  },
  {
    id: 'a',
    role: 'assistant',
    createdAt: '2026-09-14T10:00:00Z',
    timeline: [{ id: 'text', type: 'content', content: 'private answer' }],
  },
]
const messages: Frame = {
  id: 1,
  event: { type: 'MESSAGES_SNAPSHOT', messages: answered, hasOlder: false },
}
const finished = {
  id: 2,
  event: {
    type: 'RUN_FINISHED',
    threadId: thread.id,
    runId: 'run-1',
    metadata: {},
  },
} satisfies Frame
beforeEach(() => {
  signIn({
    userId: null,
    session: { ...testSession, widgets: ['render_chart'] },
  })
})
it('runs a signed-out first turn as a new device chat with its preset and keeps it in the tab', async () => {
  client.events.mockImplementation(async function* (
    _path: string,
    input: Turn,
  ) {
    yield started
    yield messages
    yield {
      ...finished,
      event: {
        ...finished.event,
        metadata: {
          thread: {
            ...thread,
            id: input.threadId,
            presetId: input.presetId,
            messages: answered,
          },
        },
      },
    }
  })
  const { result } = renderHook(() => useThread(null, 'project-1'))
  await act(() => result.current.selectPreset('builtin:tutor'))
  await act(() => result.current.send({ content: 'private question' }))
  const input = client.events.mock.calls[0][1] as Turn
  expect(input).toEqual({
    clientRequestId: expect.any(String),
    threadId: expect.stringMatching(/^\d{13}_[0-9a-f-]{36}$/),
    kind: 'send',
    widgets: ['render_chart'],
    options: {
      model: 'test-model',
      timezone: expect.any(String),
      cacheSecret: CACHE_SECRET,
    },
    content: 'private question',
    presetId: 'builtin:tutor',
    local: true,
    profile: {},
  })
  expect(result.current.chat.messages.map((m) => m.content)).toEqual([
    'private question',
    'private answer',
  ])
  expect(sessionStorage.getItem('harness-run:anonymous')).toBeNull()
  const [saved] = JSON.parse(
    sessionStorage.getItem('tinfoil-sync-session-chats') ?? '[]',
  )
  expect(saved).toMatchObject({
    id: input.threadId,
    thread: { presetId: 'builtin:tutor' },
    messages: answered,
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
  expect(result.current.status).toBe('error')
  expect(result.current.error).toBe(
    'The connection closed. Reconnect to continue.',
  )
  await act(() => result.current.reconnect())
  expect(client.events.mock.calls[1][1]).toEqual(client.events.mock.calls[0][1])
  expect(result.current.chat.messages).toHaveLength(2)
})
it('rejoins an accepted turn by its run when its stream drops', async () => {
  const chunk = (id: number, delta: string): Frame => ({
    id,
    event: {
      type: 'TEXT_MESSAGE_CHUNK',
      messageId: 'a',
      role: 'assistant',
      delta,
    },
  })
  client.events
    .mockImplementationOnce(async function* (_path, input: Turn) {
      yield {
        ...started,
        event: { ...started.event, threadId: input.threadId! },
      }
      yield messages
      yield chunk(2, ', and more')
      throw new TypeError('connection closed')
    })
    // The harness resumes the run after the frame the client applied last.
    .mockImplementationOnce(async function* (_path, input: FollowRequest) {
      const run = [
        started,
        messages,
        chunk(2, ', and more'),
        chunk(3, ', and the end'),
        { ...finished, id: 4 },
      ]
      yield* run.filter((frame) => frame.id! > (input.lastEventId ?? -1))
    })
  const { result } = renderHook(() => useThread())
  await act(() => result.current.send({ content: 'private question' }))
  expect(client.events.mock.calls[1]).toEqual([
    '/v1/threads/follow',
    {
      threadId: (client.events.mock.calls[0][1] as Turn).threadId,
      runId: 'run-1',
      lastEventId: 2,
    },
    expect.any(AbortSignal),
  ])
  expect(result.current.chat.messages.map((m) => m.content)).toEqual([
    'private question',
    'private answer, and more, and the end',
  ])
  expect(result.current.status).toBe('idle')
})
