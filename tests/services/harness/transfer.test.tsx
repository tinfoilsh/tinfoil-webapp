import { AUTH_ACTIVE_USER_ID } from '@/constants/storage-keys'
import type { HarnessClient } from '@/services/harness/client'
import {
  localThreadStore,
  type LocalThread,
} from '@/services/harness/local-threads'
import { activateAPI, HarnessAPI, publish } from '@/services/harness/runtime'
import { HarnessError } from '@/services/harness/sse'
import type { ThreadSummary } from '@/services/harness/types'
import { useThread } from '@/services/harness/use-thread'
import { chatEvents } from '@/services/storage/chat-events'
import { deletedChatsTracker } from '@/services/storage/deleted-chats-tracker'
import { indexedDBStorage } from '@/services/storage/indexed-db'
import { act, renderHook, waitFor } from '@testing-library/react'
import { IDBKeyRange as FakeIDBKeyRange, IDBFactory } from 'fake-indexeddb'
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { testSession } from '../../harness-fixture'

vi.mock('@/components/chat/genui/registry', () => ({ GENUI_WIDGETS: [] }))
vi.mock('@/utils/error-handling', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarning: vi.fn(),
}))

const KEY = 'Y29udGVudC1rZXk='
const CHAT_ID = '8233746419000_1c4e7a52-9a2b-4f7e-8d1a-5b6c7d8e9f00'
const OTHER_ID = '8233746418000_2d5f8b63-0b3c-4a8f-9e2b-6c7d8e9fa011'

let client: {
  events: ReturnType<typeof vi.fn>
  post: ReturnType<typeof vi.fn>
  upload: ReturnType<typeof vi.fn>
  download: ReturnType<typeof vi.fn>
}

function signInWithCloudSync() {
  localStorage.setItem('tinfoil-settings-cloud-sync-enabled', 'true')
  localStorage.setItem(AUTH_ACTIVE_USER_ID, 'alice')
  client = {
    events: vi.fn(),
    post: vi.fn(),
    upload: vi.fn(),
    download: vi.fn(),
  }
  const api = new HarnessAPI(client as unknown as HarnessClient, 'alice')
  vi.spyOn(api, 'key').mockReturnValue(KEY)
  activateAPI(api)
  publish({
    session: { ...testSession, features: { transfer: true } },
    profile: {},
    keyReady: true,
    profileReady: true,
  })
  return api
}

function summary(id: string, title: string): ThreadSummary {
  return {
    id,
    title,
    titleState: 'generated',
    createdAt: '2026-04-01T09:00:00Z',
    updatedAt: '2026-04-01T09:05:00Z',
    model: 'test-model',
    projectId: null,
    pinned: false,
    webSearchEnabled: true,
    messageCount: 2,
    activeRun: null,
    contextUsage: null,
  }
}

// The harness's transcript of a stored chat: attachments carry their
// content and no keys, and server bookkeeping is gone.
function transcript() {
  return {
    id: CHAT_ID,
    title: 'Garden plans',
    titleState: 'manual',
    createdAt: '2026-04-01T09:00:00Z',
    updatedAt: '2026-04-01T09:05:00Z',
    model: 'test-model',
    pinned: true,
    presetId: null,
    webSearchEnabled: false,
    codeExecutionAccessToken: 'c'.repeat(64),
    messages: [
      {
        id: 'u1',
        role: 'user',
        createdAt: '2026-04-01T09:00:00Z',
        timestamp: '2026-04-01T09:00:00Z',
        content: 'Look at these',
        attachments: [
          {
            id: 'a'.repeat(36),
            type: 'image',
            fileName: 'bed.png',
            mimeType: 'image/png',
            thumbnailBase64: 'dGh1bWI=',
            base64: 'aW1hZ2U=',
          },
          {
            id: 'b'.repeat(36),
            type: 'document',
            fileName: 'plan.pdf',
            mimeType: 'application/pdf',
            textContent: 'Plant tomatoes',
            pages: [
              {
                page: 1,
                text: 'Plant tomatoes',
                image: 'cGFnZQ==',
                is_scanned: false,
              },
            ],
          },
        ],
      },
      {
        id: 'r1',
        role: 'assistant',
        createdAt: '2026-04-01T09:00:02Z',
        content: 'Nice beds',
        thoughts: 'Looking',
        model: 'test-model',
        timeline: [
          { id: 'r1_thinking_0', type: 'thinking', content: 'Looking' },
          { id: 'r1_content_1', type: 'content', content: 'Nice beds' },
        ],
      },
    ],
  }
}

const deviceCopy: LocalThread = {
  id: CHAT_ID,
  title: 'Garden plans',
  titleState: 'manual',
  createdAt: '2026-04-01T09:00:00Z',
  updatedAt: '2026-04-01T09:05:00Z',
  model: 'test-model',
  webSearchEnabled: false,
  codeExecutionAccessToken: 'c'.repeat(64),
  messages: [
    {
      id: 'u1',
      role: 'user',
      createdAt: '2026-04-01T09:00:00Z',
      content: 'Look at these',
      attachments: [
        {
          id: 'a'.repeat(36),
          type: 'image',
          fileName: 'bed.png',
          mimeType: 'image/png',
          thumbnailBase64: 'dGh1bWI=',
          base64: 'aW1hZ2U=',
        },
        {
          id: 'b'.repeat(36),
          type: 'document',
          fileName: 'plan.pdf',
          mimeType: 'application/pdf',
          textContent: 'Plant tomatoes',
          pages: [
            {
              page: 1,
              text: 'Plant tomatoes',
              image: 'cGFnZQ==',
              is_scanned: false,
            },
          ],
        },
      ],
    },
    {
      id: 'r1',
      role: 'assistant',
      createdAt: '2026-04-01T09:00:02Z',
      content: 'Nice beds',
      model: 'test-model',
      timeline: [
        { id: 'r1_thinking_0', type: 'thinking', content: 'Looking' },
        { id: 'r1_content_1', type: 'content', content: 'Nice beds' },
      ],
    },
  ],
}

const stored = (id: string) => localThreadStore('device').get(id)
const posted = () =>
  client.post.mock.calls.map(([path, input]) => [path, input])
const transfers = () => posted().filter(([path]) => path !== '/v1/threads/list')

async function renderThreads(cloud: ThreadSummary[]) {
  const hook = renderHook(() => useThread())
  await waitFor(() =>
    expect(hook.result.current.threads.map((t) => t.id)).toEqual(
      cloud.map((t) => t.id),
    ),
  )
  return hook
}

beforeAll(() => {
  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    value: new IDBFactory(),
  })
  Object.defineProperty(globalThis, 'IDBKeyRange', {
    configurable: true,
    value: FakeIDBKeyRange,
  })
})

beforeEach(async () => {
  sessionStorage.clear()
  deletedChatsTracker.clear()
  await indexedDBStorage.deleteAllChats()
  deletedChatsTracker.clear()
})

afterEach(() => {
  chatEvents.clear()
  deletedChatsTracker.clear()
  sessionStorage.clear()
  vi.restoreAllMocks()
})

describe('moving a stored chat to this device', () => {
  it('stores the transcript under the same id and then deletes the cloud copy', async () => {
    signInWithCloudSync()
    const cloud = [summary(CHAT_ID, 'Garden plans'), summary(OTHER_ID, 'Other')]
    client.post.mockImplementation(async (path: string) => {
      if (path === '/v1/threads/list')
        return { threads: cloud, nextCursor: null }
      if (path === '/v1/threads/transcript') return { thread: transcript() }
      if (path === '/v1/threads/delete') {
        // The device copy is stored before the cloud copy is deleted.
        expect(await stored(CHAT_ID)).toEqual(deviceCopy)
        return {}
      }
      throw new Error(`Unexpected ${path}`)
    })
    const { result } = await renderThreads(cloud)

    await act(() => result.current.moveToDevice(CHAT_ID))

    expect(transfers()).toEqual([
      ['/v1/threads/transcript', { key: KEY, threadId: CHAT_ID }],
      ['/v1/threads/delete', { key: KEY, id: CHAT_ID }],
    ])
    expect(await stored(CHAT_ID)).toEqual(deviceCopy)
    expect(result.current.threads.map((t) => t.id)).toEqual([OTHER_ID])
    expect(
      result.current.chats.map((chat) => [chat.id, chat.isLocalOnly ?? false]),
    ).toEqual([
      [OTHER_ID, false],
      [CHAT_ID, true],
    ])
  })

  it('removes the device copy again when the cloud copy cannot be deleted', async () => {
    signInWithCloudSync()
    const cloud = [summary(CHAT_ID, 'Garden plans')]
    const refusal = new HarnessError(
      { code: 'UPSTREAM_REFUSED', message: 'Sync is unavailable' },
      503,
    )
    let copied: LocalThread | null = null
    client.post.mockImplementation(async (path: string) => {
      if (path === '/v1/threads/list')
        return { threads: cloud, nextCursor: null }
      if (path === '/v1/threads/transcript') return { thread: transcript() }
      if (path === '/v1/threads/delete') {
        copied = await stored(CHAT_ID)
        throw refusal
      }
      throw new Error(`Unexpected ${path}`)
    })
    const { result } = await renderThreads(cloud)

    await expect(act(() => result.current.moveToDevice(CHAT_ID))).rejects.toBe(
      refusal,
    )

    expect(copied).toEqual(deviceCopy)
    expect(await stored(CHAT_ID)).toBeNull()
    expect(await localThreadStore('device').list()).toEqual([])
    expect(result.current.threads.map((t) => t.id)).toEqual([CHAT_ID])
    expect(result.current.chats.some((chat) => chat.isLocalOnly)).toBe(false)
  })

  it('keeps the device copy when the deletion of the cloud copy may have committed', async () => {
    signInWithCloudSync()
    const cloud = [summary(CHAT_ID, 'Garden plans')]
    // The connection drops after the request was sent, so the harness may
    // have deleted the cloud copy.
    const dropped = new TypeError('Failed to fetch')
    client.post.mockImplementation(async (path: string) => {
      if (path === '/v1/threads/list')
        return { threads: cloud, nextCursor: null }
      if (path === '/v1/threads/transcript') return { thread: transcript() }
      if (path === '/v1/threads/delete') throw dropped
      throw new Error(`Unexpected ${path}`)
    })
    const { result } = await renderThreads(cloud)

    await expect(act(() => result.current.moveToDevice(CHAT_ID))).rejects.toBe(
      dropped,
    )

    expect(transfers()).toEqual([
      ['/v1/threads/transcript', { key: KEY, threadId: CHAT_ID }],
      ['/v1/threads/delete', { key: KEY, id: CHAT_ID }],
    ])
    expect(await stored(CHAT_ID)).toEqual(deviceCopy)
  })

  it('leaves a chat in the cloud when the harness cannot read its attachments', async () => {
    signInWithCloudSync()
    const cloud = [summary(CHAT_ID, 'Garden plans')]
    const unavailable = new HarnessError(
      {
        code: 'ATTACHMENTS_UNAVAILABLE',
        message: '1 attachments in this chat could not be read',
      },
      409,
    )
    client.post.mockImplementation(async (path: string) => {
      if (path === '/v1/threads/list')
        return { threads: cloud, nextCursor: null }
      if (path === '/v1/threads/transcript') throw unavailable
      throw new Error(`Unexpected ${path}`)
    })
    const { result } = await renderThreads(cloud)

    await expect(act(() => result.current.moveToDevice(CHAT_ID))).rejects.toBe(
      unavailable,
    )

    expect(transfers()).toEqual([
      ['/v1/threads/transcript', { key: KEY, threadId: CHAT_ID }],
    ])
    expect(await stored(CHAT_ID)).toBeNull()
    expect(result.current.threads.map((t) => t.id)).toEqual([CHAT_ID])
  })

  it('reopens the open chat from this device', async () => {
    signInWithCloudSync()
    const cloud = [summary(CHAT_ID, 'Garden plans')]
    client.post.mockImplementation(async (path: string) => {
      if (path === '/v1/threads/list')
        return { threads: cloud, nextCursor: null }
      if (path === '/v1/threads/get')
        return {
          ...summary(CHAT_ID, 'Garden plans'),
          hasOlder: false,
          messages: [
            {
              id: 'u1',
              role: 'user',
              createdAt: '2026-04-01T09:00:00Z',
              content: 'Look at these',
            },
          ],
        }
      if (path === '/v1/threads/transcript') return { thread: transcript() }
      if (path === '/v1/threads/delete') return {}
      throw new Error(`Unexpected ${path}`)
    })
    const { result } = await renderThreads(cloud)
    await act(() => result.current.open(CHAT_ID))
    expect(result.current.chat.isLocalOnly).toBe(false)
    expect(result.current.chat.messages).toHaveLength(1)

    await act(() => result.current.moveToDevice(CHAT_ID))

    expect(result.current.chat).toMatchObject({
      id: CHAT_ID,
      isLocalOnly: true,
      title: 'Garden plans',
    })
    expect(result.current.chat.messages.map((m) => m.content)).toEqual([
      'Look at these',
      'Nice beds',
    ])
  })

  it('changes nothing in the open chat until its move ends', async () => {
    signInWithCloudSync()
    const cloud = [summary(CHAT_ID, 'Garden plans')]
    let finishReading!: () => void
    const reading = new Promise<void>((resolve) => {
      finishReading = resolve
    })
    client.post.mockImplementation(async (path: string) => {
      if (path === '/v1/threads/list')
        return { threads: cloud, nextCursor: null }
      if (path === '/v1/threads/get')
        return {
          ...summary(CHAT_ID, 'Garden plans'),
          hasOlder: false,
          messages: [
            {
              id: 'u1',
              role: 'user',
              createdAt: '2026-04-01T09:00:00Z',
              content: 'Look at these',
            },
            {
              id: 'r1',
              role: 'assistant',
              createdAt: '2026-04-01T09:00:02Z',
              content: 'Nice beds',
            },
          ],
        }
      if (path === '/v1/threads/transcript') {
        await reading
        return { thread: transcript() }
      }
      if (path === '/v1/threads/delete') return {}
      throw new Error(`Unexpected ${path}`)
    })
    const { result } = await renderThreads(cloud)
    await act(() => result.current.open(CHAT_ID))
    let moving: Promise<void> | undefined
    act(() => {
      moving = result.current.moveToDevice(CHAT_ID)
    })
    await waitFor(() =>
      expect(transfers().map(([path]) => path)).toContain(
        '/v1/threads/transcript',
      ),
    )

    // Each would change the cloud copy after its transcript was read, and
    // be lost when the cloud copy is deleted.
    expect(result.current.send({ content: 'More?' })).toBeUndefined()
    await act(() => result.current.update(CHAT_ID, { title: 'Renamed' }))
    await act(() => result.current.deleteMessage(1))
    await act(async () => {
      finishReading()
      await moving
    })

    expect(client.events).not.toHaveBeenCalled()
    expect(transfers()).toEqual([
      ['/v1/threads/get', { key: KEY, id: CHAT_ID }],
      ['/v1/threads/transcript', { key: KEY, threadId: CHAT_ID }],
      ['/v1/threads/delete', { key: KEY, id: CHAT_ID }],
    ])
    expect(await stored(CHAT_ID)).toEqual(deviceCopy)
    expect(result.current.chat).toMatchObject({
      id: CHAT_ID,
      isLocalOnly: true,
    })
  })
})

describe('moving a chat from this device to the cloud', () => {
  const imported = summary(CHAT_ID, 'Garden plans')

  it('imports the whole transcript under the same id and then deletes the device copy', async () => {
    signInWithCloudSync()
    await localThreadStore('device').update(CHAT_ID, () => deviceCopy)
    client.post.mockImplementation(async (path: string) => {
      if (path === '/v1/threads/list') return { threads: [], nextCursor: null }
      if (path === '/v1/threads/import') {
        // The device copy stays until the cloud has the chat.
        expect(await stored(CHAT_ID)).toEqual(deviceCopy)
        return imported
      }
      throw new Error(`Unexpected ${path}`)
    })
    const { result } = await renderThreads([])
    await waitFor(() =>
      expect(result.current.chats.map((chat) => chat.id)).toEqual([CHAT_ID]),
    )

    let original: LocalThread | undefined
    await act(async () => {
      original = await result.current.moveToCloud(CHAT_ID)
    })

    expect(transfers()).toEqual([
      [
        '/v1/threads/import',
        {
          key: KEY,
          threadId: CHAT_ID,
          thread: {
            title: 'Garden plans',
            titleState: 'manual',
            createdAt: '2026-04-01T09:00:00Z',
            model: 'test-model',
            presetId: null,
            webSearchEnabled: false,
            codeExecutionAccessToken: 'c'.repeat(64),
            messages: deviceCopy.messages,
          },
        },
      ],
    ])
    expect(original).toEqual(deviceCopy)
    expect(await stored(CHAT_ID)).toBeNull()
    expect(result.current.threads).toEqual([imported])
    expect(result.current.chats.map((chat) => chat.isLocalOnly)).toEqual([
      undefined,
    ])
  })

  it('keeps the device copy unchanged when the cloud refuses the chat', async () => {
    signInWithCloudSync()
    await localThreadStore('device').update(CHAT_ID, () => deviceCopy)
    const refusal = new HarnessError(
      { code: 'THREAD_EXISTS', message: 'This chat is already in the cloud' },
      409,
    )
    client.post.mockImplementation(async (path: string) => {
      if (path === '/v1/threads/list') return { threads: [], nextCursor: null }
      if (path === '/v1/threads/import') throw refusal
      throw new Error(`Unexpected ${path}`)
    })
    const { result } = await renderThreads([])

    await expect(act(() => result.current.moveToCloud(CHAT_ID))).rejects.toBe(
      refusal,
    )

    expect(transfers().map(([path]) => path)).toEqual(['/v1/threads/import'])
    expect(await stored(CHAT_ID)).toEqual(deviceCopy)
    expect(result.current.threads).toEqual([])
  })

  it('deletes the cloud copy again when the device copy cannot be deleted', async () => {
    signInWithCloudSync()
    await localThreadStore('device').update(CHAT_ID, () => deviceCopy)
    client.post.mockImplementation(async (path: string) => {
      if (path === '/v1/threads/list') return { threads: [], nextCursor: null }
      if (path === '/v1/threads/import') return imported
      if (path === '/v1/threads/delete') return {}
      throw new Error(`Unexpected ${path}`)
    })
    const failure = new Error('Disk is full')
    vi.spyOn(indexedDBStorage, 'deleteChat').mockRejectedValueOnce(failure)
    const { result } = await renderThreads([])

    await expect(act(() => result.current.moveToCloud(CHAT_ID))).rejects.toBe(
      failure,
    )

    expect(transfers()).toEqual([
      ['/v1/threads/import', expect.objectContaining({ threadId: CHAT_ID })],
      ['/v1/threads/delete', { key: KEY, id: CHAT_ID }],
    ])
    expect(await stored(CHAT_ID)).toEqual(deviceCopy)
    expect(result.current.threads).toEqual([])
  })

  it('refuses while a reply to the chat streams on this device', async () => {
    signInWithCloudSync()
    await localThreadStore('device').update(CHAT_ID, () => deviceCopy)
    client.post.mockImplementation(async (path: string) => {
      if (path === '/v1/threads/list') return { threads: [], nextCursor: null }
      throw new Error(`Unexpected ${path}`)
    })
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    client.events.mockImplementation(async function* () {
      yield {
        id: 0,
        event: { type: 'RUN_STARTED', threadId: CHAT_ID, runId: 'run-1' },
      }
      await held
      yield {
        id: 1,
        event: { type: 'RUN_FINISHED', threadId: CHAT_ID, runId: 'run-1' },
      }
    })
    const { result } = renderHook(() =>
      useThread(CHAT_ID, null, { local: true }),
    )
    await waitFor(() => expect(result.current.chat.messages).toHaveLength(2))
    let sending: Promise<unknown> | undefined
    act(() => {
      sending = result.current.send({ content: 'More?' })
    })
    await waitFor(() => expect(result.current.running).toBe(true))

    const refusal = await result.current.moveToCloud(CHAT_ID).catch((e) => e)

    expect(refusal).toBeInstanceOf(HarnessError)
    expect(refusal).toMatchObject({ code: 'RUN_IN_FLIGHT', status: 409 })
    expect(transfers()).toEqual([])
    await act(async () => {
      release()
      await sending
    })
    expect((await stored(CHAT_ID))?.id).toBe(CHAT_ID)
  })

  it('changes nothing in the open chat until its move ends', async () => {
    signInWithCloudSync()
    await localThreadStore('device').update(CHAT_ID, () => deviceCopy)
    let finishImport!: () => void
    const importing = new Promise<void>((resolve) => {
      finishImport = resolve
    })
    client.post.mockImplementation(async (path: string) => {
      if (path === '/v1/threads/list') return { threads: [], nextCursor: null }
      if (path === '/v1/threads/import') {
        await importing
        return imported
      }
      if (path === '/v1/threads/get')
        return { ...imported, hasOlder: false, messages: [] }
      throw new Error(`Unexpected ${path}`)
    })
    const { result } = renderHook(() =>
      useThread(CHAT_ID, null, { local: true }),
    )
    await waitFor(() => expect(result.current.chat.messages).toHaveLength(2))
    let moving: Promise<unknown> | undefined
    act(() => {
      moving = result.current.moveToCloud(CHAT_ID)
    })
    await waitFor(() =>
      expect(transfers().map(([path]) => path)).toEqual(['/v1/threads/import']),
    )

    // Each would change the device copy after the import read it, and be
    // lost when the device copy is deleted.
    expect(result.current.send({ content: 'More?' })).toBeUndefined()
    await act(() => result.current.update(CHAT_ID, { title: 'Renamed' }))
    await act(() => result.current.deleteMessage(1))
    expect(await stored(CHAT_ID)).toEqual(deviceCopy)
    await act(async () => {
      finishImport()
      await moving
    })

    expect(client.events).not.toHaveBeenCalled()
    expect(transfers()).toEqual([
      [
        '/v1/threads/import',
        expect.objectContaining({
          thread: expect.objectContaining({
            title: 'Garden plans',
            messages: deviceCopy.messages,
          }),
        }),
      ],
      ['/v1/threads/get', { key: KEY, id: CHAT_ID }],
    ])
    expect(await stored(CHAT_ID)).toBeNull()
    expect(result.current.chat).toMatchObject({
      id: CHAT_ID,
      isLocalOnly: false,
    })
  })

  it('puts the device copy back under the same id after a move is undone', async () => {
    signInWithCloudSync()
    await localThreadStore('device').update(CHAT_ID, () => deviceCopy)
    client.post.mockImplementation(async (path: string) => {
      if (path === '/v1/threads/list') return { threads: [], nextCursor: null }
      if (path === '/v1/threads/import') return imported
      if (path === '/v1/threads/delete') return {}
      throw new Error(`Unexpected ${path}`)
    })
    const { result } = await renderThreads([])
    let original: LocalThread | undefined
    await act(async () => {
      original = await result.current.moveToCloud(CHAT_ID)
    })
    expect(await stored(CHAT_ID)).toBeNull()
    expect(deletedChatsTracker.isDeleted(CHAT_ID)).toBe(true)

    await act(() => result.current.moveToDevice(CHAT_ID, original))

    expect(transfers().map(([path, input]) => [path, input.id])).toEqual([
      ['/v1/threads/import', undefined],
      ['/v1/threads/delete', CHAT_ID],
    ])
    expect(await stored(CHAT_ID)).toEqual(deviceCopy)
    expect(result.current.threads).toEqual([])
    expect(result.current.chats.map((chat) => chat.id)).toEqual([CHAT_ID])
  })
})
