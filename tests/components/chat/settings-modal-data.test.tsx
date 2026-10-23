import { SettingsModal } from '@/components/chat/settings-modal'
import { buildChatExport } from '@/services/chat-export/export-archive'
import {
  localThreadStore,
  type LocalThread,
} from '@/services/harness/local-threads'
import { HarnessError } from '@/services/harness/sse'
import type { ThreadSummary } from '@/services/harness/types'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { client, KEY, signIn } from '../../harness-fixture'
import { createFunctionalImportWorker } from '../../services/chat-import/functional-import-worker'
import { resetChatStoresAroundEachTest } from '../../services/harness/thread-fixture'

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

const LOCAL_ID = '8233746419000_1c4e7a52-9a2b-4f7e-8d1a-5b6c7d8e9f00'

let downloads: { name: string; blob: Blob }[]

function connect({ cloud = false }: { cloud?: boolean } = {}) {
  signIn({ userId: page.isSignedIn ? 'alice' : null, cloud })
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

resetChatStoresAroundEachTest()

beforeEach(() => {
  page.isSignedIn = true
  page.toast.mockReset()
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

const REVERSE_ID = /^\d{13}_[0-9a-f-]{36}$/

// Picks files in a source's import panel, as its file picker would.
function pickFiles(provider: string, files: File[], input = 0) {
  const toggle = screen.getByRole('button', { name: `Import from ${provider}` })
  if (toggle.getAttribute('aria-expanded') !== 'true') fireEvent.click(toggle)
  const panel = document.getElementById(toggle.getAttribute('aria-controls')!)!
  fireEvent.change(panel.querySelectorAll('input[type="file"]')[input], {
    target: { files },
  })
}

const chatGptExport = new File(
  [
    JSON.stringify([
      {
        title: 'Plants',
        create_time: 1767261600,
        update_time: 1767261700,
        mapping: {
          root: { id: 'root', children: ['q'] },
          q: {
            id: 'q',
            parent: 'root',
            children: ['a'],
            message: {
              author: { role: 'user' },
              content: { content_type: 'text', parts: ['Which herbs?'] },
              create_time: 1767261601,
            },
          },
          a: {
            id: 'a',
            parent: 'q',
            children: [],
            message: {
              author: { role: 'assistant' },
              content: { content_type: 'text', parts: ['Basil.'] },
              create_time: 1767261602,
            },
          },
        },
      },
    ]),
  ],
  'conversations.json',
  { type: 'application/json' },
)

describe('importing chats from the Data tab', () => {
  async function importStaged(label = 'Import conversations') {
    fireEvent.click(screen.getByRole('button', { name: label }))
    await waitFor(() => expect(page.toast).toHaveBeenCalled())
  }

  it('stores ChatGPT conversations on this device without cloud sync', async () => {
    connect()
    renderData()

    pickFiles('ChatGPT', [chatGptExport])
    await importStaged()

    expect(page.toast).toHaveBeenCalledExactlyOnceWith({
      title: 'Import complete',
      description: 'Imported 1 chat from ChatGPT',
    })
    const [listed] = await localThreadStore('device').list()
    expect(listed.id).toMatch(REVERSE_ID)
    const stored = await localThreadStore('device').get(listed.id)
    expect(stored).toMatchObject({
      title: 'Plants',
      titleState: 'generated',
      createdAt: '2026-01-01T10:00:00Z',
      messages: [
        {
          id: `${listed.id}-message-0`,
          role: 'user',
          createdAt: '2026-01-01T10:00:01Z',
          content: 'Which herbs?',
        },
        {
          id: `${listed.id}-message-1`,
          role: 'assistant',
          createdAt: '2026-01-01T10:00:02Z',
          content: 'Basil.',
          timeline: [
            {
              type: 'content',
              id: `${listed.id}-message-1-content`,
              content: 'Basil.',
            },
          ],
        },
      ],
    })
    expect(stored?.codeExecutionAccessToken).toMatch(/^[0-9a-f]{64}$/)
    expect(client.upload).not.toHaveBeenCalled()
    expect(screen.getByRole('status')).toHaveTextContent('1 chat imported')
  })

  it("stores a signed-out visitor's Claude conversations in this tab", async () => {
    page.isSignedIn = false
    connect()
    renderData()

    pickFiles('Claude', [
      new File(
        [
          JSON.stringify([
            {
              uuid: 'c-1',
              name: 'Soup',
              created_at: '2026-01-02T10:00:00Z',
              updated_at: '2026-01-02T10:05:00Z',
              chat_messages: [
                {
                  uuid: 'm-1',
                  text: 'Leek soup?',
                  sender: 'human',
                  created_at: '2026-01-02T10:00:01Z',
                },
                {
                  uuid: 'm-2',
                  text: 'Yes.',
                  sender: 'assistant',
                  created_at: '2026-01-02T10:00:02Z',
                  content: [{ type: 'thinking', thinking: 'Warm' }],
                },
              ],
            },
          ]),
        ],
        'conversations.json',
      ),
    ])
    await importStaged()

    expect(page.toast).toHaveBeenCalledExactlyOnceWith({
      title: 'Import complete',
      description: 'Imported 1 chat from Claude',
    })
    expect(await localThreadStore('device').list()).toEqual([])
    const [listed] = await localThreadStore('tab').list()
    const stored = await localThreadStore('tab').get(listed.id)
    expect(
      stored?.messages.map((m) => [m.role, m.content, m.timeline]),
    ).toEqual([
      ['user', 'Leek soup?', undefined],
      [
        'assistant',
        'Yes.',
        [
          {
            type: 'thinking',
            id: `${listed.id}-message-1-thinking`,
            content: 'Warm',
            duration: null,
          },
          {
            type: 'content',
            id: `${listed.id}-message-1-content`,
            content: 'Yes.',
          },
        ],
      ],
    ])
  })

  it('stores a Tinfoil export with its images on this device', async () => {
    connect()
    vi.stubGlobal('Worker', createFunctionalImportWorker())
    const image = new Uint8Array([137, 80, 78, 71, 9])
    const archive = await buildChatExport(
      [
        {
          id: 'source',
          title: 'Trip',
          createdAt: new Date('2026-02-01T10:00:00Z'),
          messages: [
            {
              role: 'user',
              content: 'Our map',
              timestamp: new Date('2026-02-01T10:00:01Z'),
              attachments: [
                {
                  id: 'map',
                  type: 'image',
                  fileName: 'map.png',
                  mimeType: 'image/png',
                },
              ],
            },
          ],
        },
        {
          id: 'project-chat',
          title: 'Budget',
          projectId: 'project-1',
          createdAt: new Date('2026-02-01T10:00:00Z'),
          messages: [
            {
              role: 'user',
              content: 'Costs',
              timestamp: new Date('2026-02-01T10:00:01Z'),
            },
          ],
        },
      ],
      async () => image,
    )
    renderData()

    pickFiles('Tinfoil', [
      new File([archive.data as Uint8Array<ArrayBuffer>], archive.filename, {
        type: archive.mimeType,
      }),
    ])
    await waitFor(() => expect(page.toast).toHaveBeenCalled())

    expect(page.toast).toHaveBeenCalledExactlyOnceWith({
      title: 'Chats imported; project chats skipped',
      description:
        'Imported 1 chat. Premium is required to import the 1 project chat.',
    })
    const [listed] = await localThreadStore('device').list()
    const stored = await localThreadStore('device').get(listed.id)
    expect(stored?.title).toBe('Trip')
    expect(stored?.messages[0].attachments).toEqual([
      {
        id: 'map',
        type: 'image',
        fileName: 'map.png',
        mimeType: 'image/png',
        fileSize: image.length,
        base64: 'iVBORwk=',
      },
    ])
    expect(screen.getByRole('status')).toHaveTextContent(
      'Skipped 1 project chat. Premium is required to import project chats.',
    )
  })

  it('reports an export that cannot be parsed', async () => {
    connect()
    renderData()

    pickFiles('ChatGPT', [new File(['{ nope'], 'conversations.json')])
    await importStaged()

    expect(page.toast).toHaveBeenCalledExactlyOnceWith({
      title: 'Import failed',
      description: 'Could not parse the ChatGPT export file',
      variant: 'destructive',
    })
    expect(screen.getByRole('status')).toHaveTextContent(
      'conversations.json is not valid JSON',
    )
    expect(await localThreadStore('device').list()).toEqual([])
  })

  it('uploads the export to the chat service with cloud sync', async () => {
    connect({ cloud: true })
    client.upload.mockResolvedValue({ jobId: 'job-1' })
    client.post.mockImplementation(async (path: string) => {
      if (path !== '/v1/import/status') throw new Error(`Unexpected ${path}`)
      return { status: 'running', imported: 0, failed: 0, total: 1 }
    })
    renderData()

    pickFiles('ChatGPT', [chatGptExport])
    await importStaged()

    expect(client.upload).toHaveBeenCalledExactlyOnceWith(
      '/v1/import',
      chatGptExport,
      { key: KEY, source: 'chatgpt' },
      expect.any(AbortSignal),
    )
    expect(page.toast).toHaveBeenCalledExactlyOnceWith({
      title: 'Import started',
      description:
        "Your ChatGPT export is being imported securely. We'll email you when it's done.",
    })
    expect(await localThreadStore('device').list()).toEqual([])
  })
})
