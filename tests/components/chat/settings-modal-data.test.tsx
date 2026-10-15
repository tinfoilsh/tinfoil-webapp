import { SettingsModal } from '@/components/chat/settings-modal'
import {
  AUTH_ACTIVE_USER_ID,
  SETTINGS_CLOUD_SYNC_ENABLED,
} from '@/constants/storage-keys'
import type { HarnessClient } from '@/services/harness/client'
import {
  localThreadStore,
  type LocalThread,
} from '@/services/harness/local-threads'
import { activateAPI, HarnessAPI, publish } from '@/services/harness/runtime'
import { HarnessError } from '@/services/harness/sse'
import type { ThreadSummary } from '@/services/harness/types'
import { chatEvents } from '@/services/storage/chat-events'
import { deletedChatsTracker } from '@/services/storage/deleted-chats-tracker'
import { indexedDBStorage } from '@/services/storage/indexed-db'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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

const page = vi.hoisted(() => ({
  isSignedIn: true,
  toast: vi.fn(),
}))

vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: page.toast }),
}))
vi.mock('@clerk/react', () => ({
  useAuth: () => ({
    getToken: async () => null,
    signOut: vi.fn(),
    isSignedIn: page.isSignedIn,
  }),
  useUser: () => ({
    user: page.isSignedIn ? { id: 'alice' } : null,
  }),
}))
vi.mock('@/services/passkey', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/passkey')>()),
  loadPasskeyCredentials: vi.fn().mockResolvedValue([]),
}))
vi.mock('@/utils/error-handling', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarning: vi.fn(),
}))

const KEY = 'Y29udGVudC1rZXk='
const LOCAL_ID = '8233746419000_1c4e7a52-9a2b-4f7e-8d1a-5b6c7d8e9f00'

let client: {
  events: ReturnType<typeof vi.fn>
  post: ReturnType<typeof vi.fn>
  upload: ReturnType<typeof vi.fn>
  download: ReturnType<typeof vi.fn>
}
let downloads: { name: string; blob: Blob }[]

function connect({ cloud = false }: { cloud?: boolean } = {}) {
  const userId = page.isSignedIn ? 'alice' : null
  localStorage.setItem(SETTINGS_CLOUD_SYNC_ENABLED, cloud ? 'true' : 'false')
  if (userId) localStorage.setItem(AUTH_ACTIVE_USER_ID, userId)
  client = {
    events: vi.fn(),
    post: vi.fn(async (path: string) => {
      throw new Error(`Unexpected ${path}`)
    }),
    upload: vi.fn(),
    download: vi.fn(),
  }
  const api = new HarnessAPI(client as unknown as HarnessClient, userId)
  if (userId) vi.spyOn(api, 'key').mockReturnValue(KEY)
  activateAPI(api)
  publish({
    session: testSession,
    profile: {},
    keyReady: true,
    profileReady: true,
  })
}

function renderData(props: { isPremium?: boolean } = {}) {
  render(
    <SettingsModal
      isOpen
      setIsOpen={vi.fn()}
      isDarkMode={false}
      themeMode="light"
      setThemeMode={vi.fn()}
      isClient
      onOpenPromptLibrary={vi.fn()}
      onDeleteAllChats={vi.fn()}
      encryptionKey={null}
      initialTab="data"
      isSignedIn={page.isSignedIn}
      isPremium={props.isPremium ?? false}
    />,
  )
}

const deviceChat: LocalThread = {
  id: LOCAL_ID,
  title: 'Garden plans',
  titleState: 'manual',
  createdAt: '2026-04-01T09:00:00Z',
  updatedAt: '2026-04-01T09:05:00Z',
  messages: [
    {
      id: 'u1',
      role: 'user',
      createdAt: '2026-04-01T09:00:01Z',
      content: 'When do I plant?',
    },
    {
      id: 'a1',
      role: 'assistant',
      createdAt: '2026-04-01T09:00:05Z',
      content: 'In May.',
      timeline: [{ id: 'a1-c', type: 'content', content: 'In May.' }],
    },
  ],
}

const conversation = (id: string, name: string) => ({
  uuid: id,
  name,
  created_at: '2026-04-01T09:00:00.000Z',
  updated_at: '2026-04-01T09:05:00.000Z',
  chat_messages: [
    {
      uuid: `${id}_msg_0`,
      text: 'When do I plant?',
      sender: 'human',
      created_at: '2026-04-01T09:00:01.000Z',
    },
    {
      uuid: `${id}_msg_1`,
      text: 'In May.',
      sender: 'assistant',
      created_at: '2026-04-01T09:00:05.000Z',
    },
  ],
})

function summary(id: string, projectId: string | null): ThreadSummary {
  return {
    id,
    title: id,
    titleState: 'generated',
    createdAt: deviceChat.createdAt,
    updatedAt: deviceChat.updatedAt,
    model: 'test-model',
    projectId,
    pinned: false,
    webSearchEnabled: true,
    messageCount: 2,
    activeRun: null,
    contextUsage: null,
  }
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
  page.isSignedIn = true
  page.toast.mockReset()
  sessionStorage.clear()
  deletedChatsTracker.clear()
  await indexedDBStorage.deleteAllChats()
  deletedChatsTracker.clear()
  downloads = []
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
    downloads.push({ name: '', blob: blob as Blob })
    return `blob:export-${downloads.length}`
  })
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    downloads[downloads.length - 1].name = this.download
  })
})

afterEach(() => {
  chatEvents.clear()
  deletedChatsTracker.clear()
  sessionStorage.clear()
  vi.restoreAllMocks()
})

async function exportChats() {
  fireEvent.click(screen.getByRole('button', { name: 'Export Chats' }))
  await waitFor(() => expect(page.toast).toHaveBeenCalled())
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Export Chats' })).toBeEnabled(),
  )
}

describe('exporting chats from the Data tab', () => {
  it('downloads the chats kept on this device without cloud sync', async () => {
    connect()
    await localThreadStore('device').update(LOCAL_ID, () => deviceChat)
    renderData()

    await exportChats()

    expect(page.toast).toHaveBeenCalledExactlyOnceWith({
      title: 'Export complete',
      description: 'Exported 1 conversation successfully.',
    })
    expect(downloads.map(({ name }) => name)).toEqual(['conversations.json'])
    expect(JSON.parse(await downloads[0].blob.text())).toEqual([
      conversation(LOCAL_ID, 'Garden plans'),
    ])
    expect(client.post).not.toHaveBeenCalled()
  })

  it("downloads a signed-out visitor's chats from this tab", async () => {
    page.isSignedIn = false
    connect()
    await localThreadStore('tab').update(LOCAL_ID, () => deviceChat)
    renderData()

    await exportChats()

    expect(page.toast).toHaveBeenCalledExactlyOnceWith({
      title: 'Export complete',
      description: 'Exported 1 conversation successfully.',
    })
    expect(JSON.parse(await downloads[0].blob.text())).toEqual([
      conversation(LOCAL_ID, 'Garden plans'),
    ])
  })

  it('leaves out project chats without premium and says so', async () => {
    connect({ cloud: true })
    client.post.mockImplementation(async (path: string, input) => {
      const { threadId } = input as { threadId?: string }
      if (path === '/v1/threads/list')
        return {
          threads: [summary('in-project', 'project-1'), summary('loose', null)],
          nextCursor: null,
        }
      if (path === '/v1/threads/transcript')
        return { thread: { ...deviceChat, id: threadId, title: threadId } }
      throw new Error(`Unexpected ${path}`)
    })
    renderData()

    await exportChats()

    expect(page.toast.mock.calls.map(([toast]) => toast)).toEqual([
      {
        title: 'Project chats not included',
        description:
          '1 project chat could not be exported. Premium is required to export project chats.',
      },
      {
        title: 'Export complete',
        description: 'Exported 1 conversation successfully.',
      },
    ])
    expect(JSON.parse(await downloads[0].blob.text())).toEqual([
      conversation('loose', 'loose'),
    ])
  })

  it('says when there is nothing to export', async () => {
    connect()
    renderData()

    await exportChats()

    expect(page.toast).toHaveBeenCalledExactlyOnceWith({
      title: 'No chats to export',
      description: 'You have no chats to export yet.',
      variant: 'destructive',
    })
    expect(downloads).toEqual([])
  })

  it('reports an export whose chats cannot be read', async () => {
    connect({ cloud: true })
    client.post.mockRejectedValue(
      new HarnessError({ code: 'UPSTREAM_REFUSED', message: 'Down' }, 503),
    )
    renderData()

    await exportChats()

    expect(page.toast).toHaveBeenCalledExactlyOnceWith({
      title: 'Export failed',
      description: 'Failed to prepare chats for export. Please try again.',
      variant: 'destructive',
    })
    expect(downloads).toEqual([])
  })
})
