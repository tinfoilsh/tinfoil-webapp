import {
  SETTINGS_CLOUD_SYNC_ENABLED,
  USER_PREFS_LOCAL_PROFILE,
  USER_PREFS_LOCAL_PROFILE_UPGRADED,
} from '@/constants/storage-keys'
import { storeRun } from '@/services/harness/device-threads'
import { localThreadStore } from '@/services/harness/local-threads'
import { getView } from '@/services/harness/runtime'
import type {
  Frame,
  Thread,
  ThreadSummary,
  Turn,
} from '@/services/harness/types'
import { useThread } from '@/services/harness/use-thread'
import { act, renderHook, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { client, signIn, testSession } from '../../harness-fixture'
import { resetChatStoresAroundEachTest, storedThread } from './thread-fixture'

vi.mock('@/components/chat/genui/registry', () => ({ GENUI_WIDGETS: [] }))
resetChatStoresAroundEachTest()

it.each(['/v1/attachments/upload', '/v1/projects/documents/upload'] as const)(
  'shrinks the upload copy before %s',
  async (route) => {
    const groups = [{ accept: ['.png'], maxBytes: 4096, imageMaxSide: 1536 }]
    const api = signIn({
      cloud: true,
      session: {
        ...testSession,
        composer: {
          ...testSession.composer,
          attachments: groups,
          projectDocuments: groups,
        },
      },
    })
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:source')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    vi.stubGlobal(
      'Image',
      class {
        src = ''
        naturalWidth = 4096
        naturalHeight = 2048
        decode = async () => {}
      },
    )
    const drawImage = vi.fn()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      fillRect: vi.fn(),
      drawImage,
    } as never)
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(
      function (this: HTMLCanvasElement, callback) {
        expect([this.width, this.height]).toEqual([1536, 768])
        callback(new Blob(['scaled'], { type: 'image/jpeg' }))
      },
    )
    client.upload.mockResolvedValue({ converted: true })
    await api.upload(
      route,
      new File(['large original'.repeat(100)], 'photo.png', {
        type: 'image/png',
      }),
      {},
      { keyless: route === '/v1/attachments/upload' },
    )
    const uploaded = client.upload.mock.calls[0][1] as File
    expect(await uploaded.text()).toBe('scaled')
    expect(uploaded.type).toBe('image/jpeg')
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 1536, 768)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:source')
  },
)

it('merges device settings before switching to the cloud profile', async () => {
  const local = {
    nickname: 'Sam',
    customPromptPresets: [
      { id: 'user:local', name: 'Editor', systemPrompt: 'Edit carefully.' },
    ],
  }
  localStorage.setItem(USER_PREFS_LOCAL_PROFILE, JSON.stringify(local))
  localStorage.setItem(USER_PREFS_LOCAL_PROFILE_UPGRADED, 'true')
  const api = signIn()
  await api.refreshProfile()
  await api.updateProfile({ nickname: 'Edited Sam' })
  const merged = { ...local, nickname: 'Edited Sam', language: 'French' }
  client.post.mockImplementation(async (path, input) => {
    if (path !== '/v1/profile/merge') throw new Error(`Unexpected ${path}`)
    expect(input).toMatchObject({
      profile: { ...local, nickname: 'Edited Sam' },
      changedFields: ['nickname'],
    })
    return merged
  })
  localStorage.setItem(SETTINGS_CLOUD_SYNC_ENABLED, 'true')
  await api.storageModeChanged()
  expect(getView().profile).toEqual(merged)
  expect(client.post).toHaveBeenCalledTimes(1)
})

function summary(id: string): ThreadSummary {
  return {
    ...storedThread(id),
    messageCount: 0,
    activityAt: '2026-01-01T00:00:00Z',
  }
}

it('keeps loaded pages and older favorites when the chat list refreshes', async () => {
  signIn({ cloud: true })
  let renamed = false
  const first = Array.from({ length: 100 }, (_, i) => summary(`first-${i}`))
  const second = Array.from({ length: 100 }, (_, i) => summary(`second-${i}`))
  const pinned = { ...summary('old-favorite'), pinned: true }
  client.post.mockImplementation(async (path, input) => {
    if (path !== '/v1/threads/list') throw new Error(`Unexpected ${path}`)
    if ((input as { cursor?: string }).cursor)
      return { threads: second, nextCursor: null }
    return {
      threads: first.map((t, i) =>
        i === 0 && renamed ? { ...t, title: 'Renamed' } : t,
      ),
      nextCursor: 'second-page',
      pinned: [pinned],
    }
  })
  const { result } = renderHook(() => useThread())
  await waitFor(() => expect(result.current.chats).toHaveLength(101))
  await act(() => result.current.loadMoreChats())
  expect(result.current.chats).toHaveLength(201)
  renamed = true
  await act(() => result.current.refresh())
  expect(result.current.chats).toHaveLength(201)
  expect(result.current.chats.find((t) => t.id === 'first-0')?.title).toBe(
    'Renamed',
  )
  expect(
    result.current.chats.find((t) => t.id === 'old-favorite')?.pinned,
  ).toBe(true)
})

it('refreshes remote profile and open chat changes when the page regains focus', async () => {
  const api = signIn({ cloud: true })
  let revision = 1
  const thread = (): Thread => ({
    ...summary('shared'),
    title: `Remote ${revision}`,
    hasOlder: false,
    messages: [
      {
        id: 'answer',
        role: 'assistant',
        createdAt: '2026-01-01T00:00:00Z',
        content: `Reply ${revision}`,
      },
    ],
  })
  client.post.mockImplementation(async (path) => {
    if (path === '/v1/threads/list')
      return { threads: [thread()], nextCursor: null }
    if (path === '/v1/threads/get') return thread()
    if (path === '/v1/changes')
      return {
        chats: String(revision),
        profile: String(revision),
        projects: String(revision),
      }
    if (path === '/v1/profile/get') return { nickname: `Remote ${revision}` }
    throw new Error(`Unexpected ${path}`)
  })
  const { result, unmount } = renderHook(() => useThread('shared'))
  const stop = api.watchChanges()
  try {
    await waitFor(() => expect(result.current.chat.title).toBe('Remote 1'))
    act(() => window.dispatchEvent(new Event('focus')))
    await waitFor(() => expect(getView().profile.nickname).toBe('Remote 1'))
    revision = 2
    act(() => window.dispatchEvent(new Event('focus')))
    await waitFor(() =>
      expect(result.current.chat.messages[0].content).toBe('Reply 2'),
    )
    expect(getView().profile.nickname).toBe('Remote 2')
    expect(result.current.chat.title).toBe('Remote 2')
  } finally {
    stop()
    unmount()
  }
})

it('accepts more than one queued message in a device chat', async () => {
  signIn()
  const store = localThreadStore('device')
  await store.add(storedThread('device'))
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  let runs = 0
  client.events.mockImplementation(async function* (
    _path,
    input: Turn,
  ): AsyncGenerator<Frame> {
    const n = ++runs,
      runId = `run-${n}`
    if (n === 1)
      yield { id: 0, event: { type: 'RUN_STARTED', threadId: 'device', runId } }
    else
      yield {
        id: 0,
        event: {
          type: 'STATE_DELTA',
          threadId: 'device',
          runId,
          delta: [
            {
              op: 'add',
              path: '/queue/-',
              value: { queueId: runId, content: input.content! },
            },
          ],
        },
      }
    await held
    yield {
      id: 1,
      event: {
        type: 'RUN_FINISHED',
        threadId: 'device',
        runId,
        metadata: { cancelled: true },
      },
    }
  })
  const { result } = renderHook(() =>
    useThread('device', null, { local: true }),
  )
  await waitFor(() => expect(result.current.chat.id).toBe('device'))
  const pending: (Promise<unknown> | undefined)[] = []
  try {
    act(() => {
      pending.push(result.current.send({ content: 'First' }))
    })
    await waitFor(() => expect(result.current.running).toBe(true))
    act(() => {
      pending.push(result.current.send({ content: 'Second' }))
    })
    await waitFor(() => expect(result.current.queue).toHaveLength(1))
    act(() => {
      pending.push(result.current.send({ content: 'Third' }))
    })
    await waitFor(() =>
      expect(result.current.queue.map((q) => q.text)).toEqual([
        'Second',
        'Third',
      ]),
    )
  } finally {
    await act(async () => {
      release()
      await Promise.all(pending)
    })
  }
})

it('keeps images from an earlier queued turn when a later run stores its result', async () => {
  signIn()
  const store = localThreadStore('device')
  const thread = storedThread('device', {
    messages: [
      {
        id: 'image-message',
        role: 'user',
        createdAt: '2026-01-01T00:00:00Z',
        content: 'Photo',
        attachments: [
          {
            id: 'image',
            kind: 'image',
            fileName: 'photo.jpg',
            mimeType: 'image/jpeg',
            size: 3,
            base64: 'YWJj',
          },
        ],
      },
    ],
  })
  await store.add(thread)
  const completed = {
    ...thread,
    messages: [
      {
        ...thread.messages[0],
        attachments: thread.messages[0].attachments!.map(
          ({ base64: _, ...a }) => a,
        ),
      },
      {
        id: 'answer',
        role: 'assistant' as const,
        createdAt: '2026-01-01T00:00:02Z',
        content: 'Later reply',
      },
    ],
  }
  await storeRun(
    { threadId: 'device', store, images: new Map(), since: 0 },
    { type: 'RUN_FINISHED', metadata: { thread: completed } },
    [],
  )
  const saved = await store.get('device')
  expect(saved?.messages[1].content).toBe('Later reply')
  expect(saved?.messages[0].attachments?.[0].base64).toBe('YWJj')
})
