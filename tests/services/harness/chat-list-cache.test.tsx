import { CLOUD_CHAT_LIST_CACHE_PREFIX } from '@/constants/storage-keys'
import {
  ENCRYPTION_KEY_CHANGED_EVENT,
  encryptionService,
} from '@/services/encryption/encryption-service'
import type { ThreadSummary } from '@/services/harness/types'
import { useThread } from '@/services/harness/use-thread'
import { act, renderHook, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { client, signIn } from '../../harness-fixture'
import { resetChatStoresAroundEachTest } from './thread-fixture'

vi.mock('@/components/chat/genui/registry', () => ({ GENUI_WIDGETS: [] }))
vi.mock('@/utils/error-handling', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarning: vi.fn(),
}))
resetChatStoresAroundEachTest()

function summary(id: string, projectId: string | null = null): ThreadSummary {
  return {
    id,
    title: id,
    titleState: 'manual',
    model: 'gpt-oss-120b',
    createdAt: '2026-10-22T12:00:00Z',
    updatedAt: '2026-10-22T12:00:00Z',
    projectId,
    pinned: false,
    webSearchEnabled: true,
    messageCount: 2,
    activeRun: null,
  }
}

const page = (threads: ThreadSummary[], pinned: ThreadSummary[] = []) => ({
  threads,
  pinned,
  nextCursor: null,
})
const cacheKeys = () =>
  Array.from({ length: localStorage.length }, (_, index) =>
    localStorage.key(index)!,
  ).filter((key) => key.startsWith(CLOUD_CHAT_LIST_CACHE_PREFIX))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

it('restarts an unfinished list after a concurrent chat edit invalidates it', async () => {
  signIn({ cloud: true })
  const pending = deferred<ReturnType<typeof page>>()
  const original = summary('opened')
  const renamed = { ...original, title: 'Renamed chat' }
  let listings = 0
  client.post.mockImplementation(async (path) => {
    if (path === '/v1/threads/list')
      return ++listings === 1
        ? pending.promise
        : page([renamed, summary('other')])
    if (path === '/v1/threads/get')
      return { ...original, messages: [], hasOlder: false }
    if (path === '/v1/threads/update') return renamed
    throw new Error(`Unexpected ${path}`)
  })
  const { result } = renderHook(() => useThread(original.id))
  await waitFor(() => expect(result.current.chat.id).toBe(original.id))
  expect(result.current.loadingChats).toBe(true)
  await act(() => result.current.update(original.id, { title: renamed.title }))
  await waitFor(() => expect(result.current.loadingChats).toBe(false))
  await act(async () => pending.resolve(page([original])))
  expect(result.current.chats.map((chat) => chat.title).sort()).toEqual([
    'Renamed chat',
    'other',
  ])
})

it('restores sidebar summaries and favorites after a reload before fresh results arrive', async () => {
  signIn({ cloud: true })
  const cached = {
    ...summary('cached'),
    activeRun: { runId: 'running', expiresAt: '2099-01-01T00:00:00Z' },
    messages: [
      { id: 'message', role: 'user', content: 'Private message content' },
    ],
  }
  const favorite = { ...summary('older-favorite'), pinned: true }
  client.post.mockResolvedValue(page([cached], [favorite]))
  const first = renderHook(() => useThread())
  await waitFor(() =>
    expect(first.result.current.chats.map((chat) => chat.id)).toEqual([
      'cached',
      'older-favorite',
    ]),
  )
  first.unmount()

  const saved = cacheKeys()
    .map((key) => localStorage.getItem(key))
    .join('')
  expect(saved).not.toContain('Private message content')
  expect(saved).not.toContain('running')

  signIn({ cloud: true })
  const fresh = deferred<ReturnType<typeof page>>()
  client.post.mockReturnValue(fresh.promise)
  const reloaded = renderHook(() => useThread())
  expect(reloaded.result.current.chats.map((chat) => chat.id)).toEqual([
    'cached',
    'older-favorite',
  ])
  expect(reloaded.result.current.chats[0].activeRun).toBeNull()
  expect(reloaded.result.current.chats[1].pinned).toBe(true)
  expect(reloaded.result.current.hasMoreChats).toBe(false)
  await act(async () => fresh.resolve(page([summary('fresh')])))
  expect(reloaded.result.current.chats.map((chat) => chat.id)).toEqual([
    'fresh',
  ])
})

it('keeps rename and deletion results through a reload', async () => {
  signIn({ cloud: true })
  const renamed = { ...summary('kept'), title: 'New title' }
  const deleted = { ...summary('deleted', 'project'), pinned: true }
  client.post.mockImplementation(async (path, input) => {
    if (path === '/v1/threads/list')
      return page(
        (input as { projectId?: string }).projectId
          ? [deleted]
          : [summary('kept'), deleted],
        [deleted],
      )
    if (path === '/v1/threads/update') return renamed
    if (path === '/v1/threads/delete') return {}
    throw new Error(`Unexpected ${path}`)
  })
  const first = renderHook(() => useThread())
  await waitFor(() => expect(first.result.current.chats).toHaveLength(2))
  await act(() => first.result.current.update('kept', { title: 'New title' }))
  first.unmount()
  const project = renderHook(() => useThread(undefined, 'project'))
  await waitFor(() =>
    expect(project.result.current.chats.map((chat) => chat.id)).toEqual([
      'deleted',
    ]),
  )
  await act(() => project.result.current.remove('deleted'))
  project.unmount()

  signIn({ cloud: true })
  const fresh = deferred<ReturnType<typeof page>>()
  client.post.mockReturnValue(fresh.promise)
  const reloaded = renderHook(() => useThread())
  expect(
    reloaded.result.current.chats.map(({ id, title }) => ({ id, title })),
  ).toEqual([{ id: 'kept', title: 'New title' }])
  await act(async () => fresh.resolve(page([renamed])))
})

it('restores each project list from its own cache', async () => {
  signIn({ cloud: true })
  client.post.mockImplementation(async (path, input) => {
    if (path !== '/v1/threads/list') throw new Error(`Unexpected ${path}`)
    return (input as { projectId?: string }).projectId
      ? page([summary('project-chat', 'project')])
      : page([summary('other-chat')])
  })
  const initialProps: { projectId: string | null } = { projectId: 'project' }
  const hook = renderHook(({ projectId }) => useThread(undefined, projectId), {
    initialProps,
  })
  await waitFor(() =>
    expect(hook.result.current.chats.map((chat) => chat.id)).toEqual([
      'project-chat',
    ]),
  )
  hook.rerender({ projectId: null })
  await waitFor(() =>
    expect(hook.result.current.chats.map((chat) => chat.id)).toEqual([
      'other-chat',
    ]),
  )

  const fresh = deferred<ReturnType<typeof page>>()
  client.post.mockReturnValue(fresh.promise)
  hook.rerender({ projectId: 'project' })
  expect(hook.result.current.chats.map((chat) => chat.id)).toEqual([
    'project-chat',
  ])
  await act(async () =>
    fresh.resolve(page([summary('project-chat', 'project')])),
  )
})

it("never restores another account's cached sidebar", async () => {
  signIn({ cloud: true, userId: 'alice' })
  client.post.mockResolvedValue(page([summary('alice-chat')]))
  const alice = renderHook(() => useThread())
  await waitFor(() =>
    expect(alice.result.current.chats.map((chat) => chat.id)).toEqual([
      'alice-chat',
    ]),
  )
  alice.unmount()

  signIn({ cloud: true, userId: 'bob' })
  const fresh = deferred<ReturnType<typeof page>>()
  client.post.mockReturnValue(fresh.promise)
  const bob = renderHook(() => useThread())
  expect(bob.result.current.chats).toEqual([])
  await act(async () => fresh.resolve(page([summary('bob-chat')])))
  expect(bob.result.current.chats.map((chat) => chat.id)).toEqual(['bob-chat'])
})

it('clears cached lists after a key change and ignores an older in-flight refresh', async () => {
  signIn({ cloud: true })
  const firstKey = await encryptionService.generateKey()
  const nextKey = await encryptionService.generateKey()
  await encryptionService.setKey(firstKey)
  client.post.mockResolvedValue(page([summary('old-key-chat')]))
  const hook = renderHook(() => useThread())
  await waitFor(() => expect(hook.result.current.chats).toHaveLength(1))
  expect(cacheKeys()).toHaveLength(1)
  act(() => window.dispatchEvent(new Event(ENCRYPTION_KEY_CHANGED_EVENT)))
  expect(hook.result.current.chats.map((chat) => chat.id)).toEqual([
    'old-key-chat',
  ])
  expect(cacheKeys()).toHaveLength(1)
  const pending = deferred<ReturnType<typeof page>>()
  client.post.mockReturnValue(pending.promise)
  let refresh!: Promise<void>
  act(() => {
    refresh = hook.result.current.refresh()
  })
  await act(() => encryptionService.setKey(nextKey))
  await act(async () => {
    pending.resolve(page([summary('stale')]))
    await refresh
  })
  expect(hook.result.current.chats).toEqual([])
  expect(cacheKeys()).toEqual([])
})

it('fetches the sidebar normally when its cached JSON is invalid', async () => {
  signIn({ cloud: true })
  client.post.mockResolvedValue(page([summary('cached')]))
  const first = renderHook(() => useThread())
  await waitFor(() => expect(first.result.current.chats).toHaveLength(1))
  first.unmount()
  localStorage.setItem(cacheKeys()[0], 'invalid JSON')

  signIn({ cloud: true })
  client.post.mockResolvedValue(page([summary('fresh')]))
  const reloaded = renderHook(() => useThread())
  await waitFor(() =>
    expect(reloaded.result.current.chats.map((chat) => chat.id)).toEqual([
      'fresh',
    ]),
  )
})

it('keeps network results usable when browser storage is full', async () => {
  signIn({ cloud: true })
  const setItem = localStorage.setItem.bind(localStorage)
  vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
    if (key.startsWith(CLOUD_CHAT_LIST_CACHE_PREFIX))
      throw new DOMException('Full', 'QuotaExceededError')
    setItem(key, value)
  })
  client.post.mockResolvedValue(page([summary('fresh')]))
  const hook = renderHook(() => useThread())
  await waitFor(() =>
    expect(hook.result.current.chats.map((chat) => chat.id)).toEqual(['fresh']),
  )
  expect(hook.result.current.error).toBe('')
})
