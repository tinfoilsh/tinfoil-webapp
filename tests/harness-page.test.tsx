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
function signedInHistory(post: ReturnType<typeof vi.fn>) {
  const api = new HarnessAPI(
    { post } as unknown as HarnessClient,
    'history-user',
  )
  vi.spyOn(api, 'key').mockReturnValue('test-key')
  activateAPI(api)
  publish({ session: testSession, keyReady: true })
  return api
}

it('loads history when opening a chat route before the list response arrives', async () => {
  let resolve!: (value: unknown) => void
  const post = vi.fn().mockImplementation((path: string) =>
    path === '/v1/threads/list'
      ? new Promise((done) => {
          resolve = done
        })
      : Promise.resolve(thread),
  )
  signedInHistory(post)
  const { result } = renderHook(() => useThread(thread.id))
  await waitFor(() => expect(result.current.chat.id).toBe(thread.id))
  await act(async () => resolve({ threads: [thread], nextCursor: 'older' }))
  expect(result.current.chats.map((chat) => chat.id)).toEqual([thread.id])
  expect(result.current.cursor).toBe('older')
  expect(
    post.mock.calls.filter(([path]) => path === '/v1/threads/list'),
  ).toHaveLength(1)
})

it('keeps pending history when starting a new chat', async () => {
  let resolve!: (value: unknown) => void
  signedInHistory(
    vi.fn().mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done
        }),
    ),
  )
  const { result } = renderHook(() => useThread())
  act(() => result.current.newChat())
  await act(async () => resolve({ threads: [thread], nextCursor: null }))
  expect(result.current.chats.map((chat) => chat.id)).toEqual([thread.id])
})

it('ignores history from a project that is no longer selected', async () => {
  let resolve!: (value: unknown) => void
  signedInHistory(
    vi.fn().mockImplementation((_path, input) =>
      input.projectId === 'old-project'
        ? new Promise((done) => {
            resolve = done
          })
        : Promise.resolve({
            threads: [
              { ...thread, id: 'new-project-chat', projectId: 'new-project' },
            ],
            nextCursor: null,
          }),
    ),
  )
  const { result, rerender } = renderHook(
    ({ projectId }) => useThread(null, projectId),
    { initialProps: { projectId: 'old-project' } },
  )
  rerender({ projectId: 'new-project' })
  await waitFor(() =>
    expect(result.current.chats[0]?.id).toBe('new-project-chat'),
  )
  await act(async () => resolve({ threads: [thread], nextCursor: 'stale' }))
  expect(result.current.chats.map((chat) => chat.id)).toEqual([
    'new-project-chat',
  ])
  expect(result.current.cursor).toBeNull()
})

it('discards pending history when the encryption key is invalidated', async () => {
  let resolve!: (value: unknown) => void
  const api = signedInHistory(
    vi.fn().mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done
        }),
    ),
  )
  const { result } = renderHook(() => useThread())
  act(() => api.invalidateKey())
  await act(async () => resolve({ threads: [thread], nextCursor: 'stale' }))
  expect(result.current.chats).toEqual([])
  expect(result.current.cursor).toBeNull()
  expect(result.current.error).toBe('')
})

let events: ReturnType<typeof vi.fn>

it('preserves loaded history pages and the cursor when navigation remounts the chat page', async () => {
  const second = { ...thread, id: 'thread-2', title: 'Older chat' }
  const post = vi.fn().mockImplementation(async (path, input) => {
    if (path === '/v1/threads/get')
      return input.id === second.id ? second : thread
    return {
      threads: input.cursor ? [second] : [thread],
      nextCursor: input.cursor ? 'page-3' : 'page-2',
    }
  })
  signedInHistory(post)
  const firstPage = renderHook(() => useThread())
  await waitFor(() => expect(firstPage.result.current.threads).toHaveLength(1))
  await act(() => firstPage.result.current.refresh('page-2'))
  expect(firstPage.result.current.threads).toHaveLength(2)
  firstPage.unmount()

  const chatPage = renderHook(() => useThread(thread.id))
  expect(chatPage.result.current.threads.map((item) => item.id)).toEqual([
    thread.id,
    second.id,
  ])
  expect(chatPage.result.current.cursor).toBe('page-3')
  await waitFor(() =>
    expect(chatPage.result.current.chat.title).toBe(thread.title),
  )
  expect(
    post.mock.calls.filter(([path]) => path === '/v1/threads/list'),
  ).toHaveLength(2)
  chatPage.unmount()

  const otherChat = renderHook(() => useThread(second.id))
  expect(otherChat.result.current.threads).toHaveLength(2)
  await waitFor(() =>
    expect(otherChat.result.current.chat.title).toBe(second.title),
  )
  expect(
    post.mock.calls.filter(([path]) => path === '/v1/threads/list'),
  ).toHaveLength(2)
})

it('clears cached history when the key changes, including after navigating back to another page', async () => {
  const post = vi
    .fn()
    .mockResolvedValue({ threads: [thread], nextCursor: null })
  const api = signedInHistory(post)
  const page = renderHook(() => useThread())
  await waitFor(() => expect(page.result.current.threads).toHaveLength(1))
  page.unmount()
  act(() => api.invalidateKey())
  const next = renderHook(() => useThread())
  expect(next.result.current.threads).toEqual([])
  expect(next.result.current.cursor).toBeNull()
})

beforeEach(() => {
  sessionStorage.clear()
  events = vi.fn()
  activateAPI(
    new HarnessAPI(
      {
        events,
        post: vi.fn().mockResolvedValue(testSession),
      } as unknown as HarnessClient,
      null,
    ),
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
  let sending: ReturnType<typeof result.current.send>
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
