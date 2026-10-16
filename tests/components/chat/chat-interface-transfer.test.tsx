import { ChatInterface } from '@/components/chat/chat-interface'
import type { ChatSidebar } from '@/components/chat/chat-sidebar'
import { authTokenManager } from '@/services/auth'
import {
  localThreadStore,
  type LocalThread,
} from '@/services/harness/local-threads'
import { HarnessError } from '@/services/harness/sse'
import type { ThreadSummary } from '@/services/harness/types'
import { resetSafeguards } from '@/services/safeguards'
import { chatEvents } from '@/services/storage/chat-events'
import { deletedChatsTracker } from '@/services/storage/deleted-chats-tracker'
import { indexedDBStorage } from '@/services/storage/indexed-db'
import { act, render, waitFor } from '@testing-library/react'
import { IDBKeyRange as FakeIDBKeyRange, IDBFactory } from 'fake-indexeddb'
import type { ComponentProps } from 'react'
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { connectHarness, KEY, type FakeHarness } from './chat-interface-fixture'
import { chatPage } from './chat-page-mocks'

type SidebarProps = ComponentProps<typeof ChatSidebar>
const page = vi.hoisted(() => ({
  sidebar: null as SidebarProps | null,
  toast: vi.fn(),
}))

vi.mock('@clerk/react', async () => (await import('./chat-page-mocks')).clerk)
vi.mock('next/router', async () => (await import('./chat-page-mocks')).router)
vi.mock('next/head', async () => (await import('./chat-page-mocks')).head)
vi.mock('next/dynamic', async () => (await import('./chat-page-mocks')).dynamic)
vi.mock(
  '@/components/ui/logo-loading',
  async () => (await import('./chat-page-mocks')).logoLoading,
)
vi.mock(
  '@/hooks/use-projects',
  async () => (await import('./chat-page-mocks')).projects,
)
vi.mock(
  '@/hooks/use-subscription-status',
  async () => (await import('./chat-page-mocks')).subscription,
)
vi.mock(
  '@/hooks/use-passkey-backup',
  async () => (await import('./chat-page-mocks')).passkeyBackup,
)
vi.mock(
  '@/components/project',
  async () => (await import('./chat-page-mocks')).project,
)
vi.mock('@/components/chat/chat-sidebar', () => ({
  ChatSidebar: (props: SidebarProps) => {
    page.sidebar = props
    return null
  },
}))
vi.mock(
  '@/utils/error-handling',
  async () => (await import('./chat-page-mocks')).errorHandling,
)
vi.mock('@/hooks/use-toast', () => ({
  toast: page.toast,
  useToast: () => ({ toast: page.toast }),
}))

const CHAT_ID = '8233746419000_1c4e7a52-9a2b-4f7e-8d1a-5b6c7d8e9f00'
const deviceChat: LocalThread = {
  id: CHAT_ID,
  title: 'Garden plans',
  titleState: 'manual',
  createdAt: '2026-04-01T09:00:00Z',
  updatedAt: '2026-04-01T09:05:00Z',
  model: 'test-model',
  codeExecutionAccessToken: 'c'.repeat(64),
  messages: [
    {
      id: 'u1',
      role: 'user',
      createdAt: '2026-04-01T09:00:00Z',
      content: 'Look at this',
      attachments: [
        {
          id: 'photo',
          type: 'image',
          fileName: 'bed.png',
          mimeType: 'image/png',
          base64: 'aW1hZ2U=',
        },
      ],
    },
  ],
}
const imported: ThreadSummary = {
  id: CHAT_ID,
  title: 'Garden plans',
  titleState: 'manual',
  createdAt: '2026-04-01T09:00:00Z',
  updatedAt: '2026-04-02T09:00:00Z',
  model: 'test-model',
  projectId: null,
  pinned: false,
  webSearchEnabled: true,
  messageCount: 1,
  activeRun: null,
  contextUsage: null,
}

let harness: FakeHarness
let cloud: ThreadSummary[]

function connect() {
  cloud = []
  harness = connectHarness()
}

const sidebar = () => {
  if (!page.sidebar) throw new Error('The sidebar was not rendered')
  return page.sidebar
}
const calls = () =>
  harness.client.post.mock.calls
    .map(([path, input]) => [path, input])
    .filter(([path]) => path !== '/v1/threads/list')
const stored = () => localThreadStore('device').get(CHAT_ID)

async function renderPage() {
  render(<ChatInterface />)
  await waitFor(() =>
    expect(sidebar().chats.map((chat) => chat.id)).toEqual([CHAT_ID]),
  )
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
  page.sidebar = null
  page.toast.mockReset()
  chatPage.premium = false
  authTokenManager.initialize(async () => 'clerk-jwt')
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (String(url).endsWith('/api/users/me/safeguard-flags'))
        return Response.json({
          flags: [],
          in_window: 0,
          window_hours: 168,
          warn_threshold: 2,
          ban_threshold: 3,
        })
      throw new Error(`Unexpected request: ${url}`)
    }),
  )
  sessionStorage.clear()
  deletedChatsTracker.clear()
  await indexedDBStorage.deleteAllChats()
  deletedChatsTracker.clear()
  await localThreadStore('device').update(CHAT_ID, () => deviceChat)
})

afterEach(() => {
  resetSafeguards()
  authTokenManager.reset()
  chatEvents.clear()
  deletedChatsTracker.clear()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('moving chats from the chat page', () => {
  it('pins a device chat by moving it to the cloud first', async () => {
    connect()
    harness.client.post.mockImplementation(async (path: string, input) => {
      if (path === '/v1/threads/list')
        return { threads: cloud, nextCursor: null }
      if (path === '/v1/threads/import') {
        cloud = [imported]
        return imported
      }
      if (path === '/v1/threads/update')
        return { ...imported, pinned: (input as { pinned: boolean }).pinned }
      throw new Error(`Unexpected ${path}`)
    })
    await renderPage()

    await act(async () => {
      await sidebar().onToggleFavorite?.({
        id: CHAT_ID,
        title: '',
        isLocalOnly: true,
      })
    })

    expect(calls()).toEqual([
      [
        '/v1/threads/import',
        expect.objectContaining({ key: KEY, threadId: CHAT_ID }),
      ],
      ['/v1/threads/update', { key: KEY, id: CHAT_ID, pinned: true }],
    ])
    expect(await stored()).toBeNull()
    expect(page.toast).toHaveBeenCalledExactlyOnceWith({
      title: 'Chat moved to cloud',
      description: 'The chat will now sync across your devices.',
    })
    await waitFor(() => expect(sidebar().pinnedChatIds).toEqual([CHAT_ID]))
  })

  it('leaves a device chat unpinned on the device when its move fails', async () => {
    connect()
    harness.client.post.mockImplementation(async (path: string) => {
      if (path === '/v1/threads/list')
        return { threads: cloud, nextCursor: null }
      if (path === '/v1/threads/import')
        throw new HarnessError({ code: 'UPSTREAM_REFUSED', message: 'No' }, 502)
      throw new Error(`Unexpected ${path}`)
    })
    await renderPage()

    await act(async () => {
      await sidebar().onToggleFavorite?.({
        id: CHAT_ID,
        title: '',
        isLocalOnly: true,
      })
    })

    expect(calls().map(([path]) => path)).toEqual(['/v1/threads/import'])
    expect(await stored()).toEqual(deviceChat)
    expect(page.toast).toHaveBeenCalledExactlyOnceWith({
      title: 'Failed to move chat to cloud',
      description: 'Please try again.',
      variant: 'destructive',
    })
  })

  it('files a device chat into a project through the cloud', async () => {
    chatPage.premium = true
    connect()
    harness.client.post.mockImplementation(async (path: string) => {
      if (path === '/v1/threads/list')
        return { threads: cloud, nextCursor: null }
      if (path === '/v1/threads/import') {
        cloud = [imported]
        return imported
      }
      if (path === '/v1/threads/update') {
        cloud = [{ ...imported, projectId: 'project-1' }]
        return cloud[0]
      }
      throw new Error(`Unexpected ${path}`)
    })
    await renderPage()

    await act(async () => {
      await sidebar().onMoveChatToProject?.(CHAT_ID, 'project-1')
    })

    expect(calls()).toEqual([
      [
        '/v1/threads/import',
        expect.objectContaining({ key: KEY, threadId: CHAT_ID }),
      ],
      ['/v1/threads/update', { key: KEY, id: CHAT_ID, projectId: 'project-1' }],
    ])
    expect(await stored()).toBeNull()
    expect(page.toast).toHaveBeenLastCalledWith({
      title: 'Chat moved to project',
      description: 'The chat has been moved successfully.',
    })
  })

  it('returns a device chat to the device as it was when its project move fails', async () => {
    chatPage.premium = true
    connect()
    harness.client.post.mockImplementation(async (path: string) => {
      if (path === '/v1/threads/list')
        return { threads: cloud, nextCursor: null }
      if (path === '/v1/threads/import') {
        cloud = [imported]
        return imported
      }
      if (path === '/v1/threads/update')
        throw new HarnessError(
          { code: 'THREAD_NOT_FOUND', message: 'Gone' },
          404,
        )
      if (path === '/v1/threads/delete') {
        cloud = []
        return {}
      }
      throw new Error(`Unexpected ${path}`)
    })
    await renderPage()

    await act(async () => {
      await sidebar().onMoveChatToProject?.(CHAT_ID, 'project-1')
    })

    expect(calls()).toEqual([
      [
        '/v1/threads/import',
        expect.objectContaining({ key: KEY, threadId: CHAT_ID }),
      ],
      ['/v1/threads/update', { key: KEY, id: CHAT_ID, projectId: 'project-1' }],
      ['/v1/threads/delete', { key: KEY, id: CHAT_ID }],
    ])
    expect(await stored()).toEqual(deviceChat)
    expect(page.toast).toHaveBeenLastCalledWith({
      title: 'Failed to move chat',
      description: 'Please try again.',
      variant: 'destructive',
    })
    await waitFor(() =>
      expect(
        sidebar().chats.map((chat) => [chat.id, chat.isLocalOnly]),
      ).toEqual([[CHAT_ID, true]]),
    )
  })

  it('names unreadable attachments when a synced chat cannot move to the device', async () => {
    await localThreadStore('device').delete(CHAT_ID)
    connect()
    cloud = [imported]
    harness.client.post.mockImplementation(async (path: string) => {
      if (path === '/v1/threads/list')
        return { threads: cloud, nextCursor: null }
      if (path === '/v1/threads/transcript')
        throw new HarnessError(
          { code: 'ATTACHMENTS_UNAVAILABLE', message: '1 attachments' },
          409,
        )
      throw new Error(`Unexpected ${path}`)
    })
    await renderPage()

    await act(async () => {
      await sidebar().onConvertChatToLocal?.(CHAT_ID)
    })

    expect(calls()).toEqual([
      ['/v1/threads/transcript', { key: KEY, threadId: CHAT_ID }],
    ])
    expect(page.toast).toHaveBeenCalledExactlyOnceWith({
      title: 'Failed to move chat to local',
      description:
        'Some attachments in this chat could not be downloaded. Check your connection and try again.',
      variant: 'destructive',
    })
  })

  it('moves a synced chat to the device and says so', async () => {
    await localThreadStore('device').delete(CHAT_ID)
    connect()
    cloud = [imported]
    harness.client.post.mockImplementation(async (path: string) => {
      if (path === '/v1/threads/list')
        return { threads: cloud, nextCursor: null }
      if (path === '/v1/threads/transcript')
        return {
          thread: {
            ...deviceChat,
            id: undefined,
            updatedAt: '2026-04-02T09:00:00Z',
            presetId: null,
            pinned: false,
          },
        }
      if (path === '/v1/threads/delete') {
        cloud = []
        return {}
      }
      throw new Error(`Unexpected ${path}`)
    })
    await renderPage()

    await act(async () => {
      await sidebar().onConvertChatToLocal?.(CHAT_ID)
    })

    expect(calls()).toEqual([
      ['/v1/threads/transcript', { key: KEY, threadId: CHAT_ID }],
      ['/v1/threads/delete', { key: KEY, id: CHAT_ID }],
    ])
    expect(await stored()).toEqual({
      ...deviceChat,
      updatedAt: '2026-04-02T09:00:00Z',
    })
    expect(page.toast).toHaveBeenCalledExactlyOnceWith({
      title: 'Chat moved to local',
      description: 'The chat is now only stored on this device.',
    })
  })
})
