import { SettingsModal } from '@/components/chat/settings-modal'
import { localThreadStore } from '@/services/harness/local-threads'
import { HarnessError } from '@/services/harness/sse'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { client, KEY, signIn } from '../../harness-fixture'
import {
  resetChatStoresAroundEachTest,
  storedThread,
} from '../../services/harness/thread-fixture'

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

const deviceChat = storedThread(LOCAL_ID, {
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
})

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

const FORK_ID = '8233746418000_2d5f8b63-0a3c-4f8e-9e2b-6c7d8e9f0a11'
const photo = {
  id: 'att_photo',
  kind: 'image' as const,
  fileName: 'photo.png',
  mimeType: 'image/jpeg',
  size: 5,
  base64: 'bW9kZWw=',
}
const ORIGINAL = { base64: 'b3JpZ2luYWw=', mimeType: 'image/png' }
// A chat with an image whose picked file this device keeps, and its fork,
// which keeps the same attachment.
const photoChat = storedThread(LOCAL_ID, {
  ...deviceChat,
  messages: [{ ...deviceChat.messages[0], attachments: [photo] }],
})
const photoFork = storedThread(FORK_ID, {
  ...photoChat,
  id: FORK_ID,
  title: 'Garden plans (fork)',
  updatedAt: '2026-04-01T09:00:00Z',
})
const ARCHIVE = new Uint8Array([80, 75, 3, 4, 1])

async function keepPhotoChats(scope: 'device' | 'tab') {
  const store = localThreadStore(scope)
  for (const thread of [photoChat, photoFork])
    await store.update(thread.id, () => thread, new Map([[photo.id, ORIGINAL]]))
}

function answerExport() {
  client.multipart.mockResolvedValue(
    new Response(new Blob([ARCHIVE]), {
      headers: { 'Content-Type': 'application/zip' },
    }),
  )
}

// The parts of the export request, in order: JSON parts parsed, and files
// by name, type and content.
async function exportRequest() {
  expect(client.multipart).toHaveBeenCalledOnce()
  const [path, form] = client.multipart.mock.calls[0] as [string, FormData]
  return {
    path,
    parts: await Promise.all(
      [...form.entries()].map(async ([name, value]) =>
        typeof value === 'string'
          ? [name, JSON.parse(value)]
          : [name, value.name, value.type, await value.text()],
      ),
    ),
  }
}

describe('exporting chats from the Data tab', () => {
  it('sends the chats on this device and their originals once without cloud sync', async () => {
    connect()
    await keepPhotoChats('device')
    answerExport()
    renderData()

    await exportChats()

    expect(await exportRequest()).toEqual({
      path: '/v1/export',
      parts: [
        ['options', { format: 'conversations' }],
        ['thread', photoChat],
        ['file', photo.id, 'image/png', 'original'],
        ['thread', photoFork],
      ],
    })
    expect(page.toast).toHaveBeenCalledExactlyOnceWith({
      title: 'Export complete',
      description: 'Your chats were exported.',
    })
    expect(downloads.map(({ name }) => name)).toEqual(['tinfoil-chats.zip'])
    expect(new Uint8Array(await downloads[0].blob.arrayBuffer())).toEqual(
      ARCHIVE,
    )
  })

  it('sends the content key with cloud sync, for the stored chats', async () => {
    connect({ cloud: true })
    await keepPhotoChats('device')
    answerExport()
    renderData()

    await exportChats()

    expect((await exportRequest()).parts).toEqual([
      ['options', { format: 'conversations', key: KEY }],
      ['thread', photoChat],
      ['file', photo.id, 'image/png', 'original'],
      ['thread', photoFork],
    ])
    expect(downloads.map(({ name }) => name)).toEqual(['tinfoil-chats.zip'])
  })

  it("sends a signed-out visitor's chats from this tab without a key", async () => {
    page.isSignedIn = false
    connect()
    await keepPhotoChats('tab')
    answerExport()
    renderData()

    await exportChats()

    expect((await exportRequest()).parts).toEqual([
      ['options', { format: 'conversations' }],
      ['thread', photoChat],
      ['file', photo.id, 'image/png', 'original'],
      ['thread', photoFork],
    ])
    expect(new Uint8Array(await downloads[0].blob.arrayBuffer())).toEqual(
      ARCHIVE,
    )
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
    expect(client.multipart).not.toHaveBeenCalled()
    expect(downloads).toEqual([])
  })

  it('reports an export the chat service refuses', async () => {
    connect({ cloud: true })
    client.multipart.mockRejectedValue(
      new HarnessError({ code: 'UPSTREAM_REFUSED', message: 'Down' }, 503),
    )
    renderData()

    await exportChats()

    expect(page.toast).toHaveBeenCalledExactlyOnceWith({
      title: 'Export failed',
      description: 'Failed to export chats. Please try again.',
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
  // The harness's reader of old chats upgrades each chat the import parsed,
  // which is in the previous client's format.
  const upgraded = (row: { id: string; title: string }) =>
    storedThread(row.id, { title: row.title, titleState: 'generated' })
  function acceptUpgrades() {
    client.post.mockImplementation(async (path: string, input) => {
      if (path !== '/v1/threads/upgrade') throw new Error(`Unexpected ${path}`)
      return {
        threads: (
          input as { threads: { id: string; title: string }[] }
        ).threads.map(upgraded),
      }
    })
  }
  const upgradeRequests = () =>
    client.post.mock.calls
      .filter(([path]) => path === '/v1/threads/upgrade')
      .map(([, input]) => input)

  it('stores ChatGPT conversations on this device without cloud sync', async () => {
    connect()
    acceptUpgrades()
    renderData()

    pickFiles('ChatGPT', [chatGptExport])
    await importStaged()

    expect(page.toast).toHaveBeenCalledExactlyOnceWith({
      title: 'Import complete',
      description: 'Imported 1 chat from ChatGPT',
    })
    const [listed] = await localThreadStore('device').list()
    expect(listed.id).toMatch(REVERSE_ID)
    expect(upgradeRequests()).toEqual([
      {
        threads: [
          expect.objectContaining({
            id: listed.id,
            title: 'Plants',
            isLocalOnly: true,
            createdAt: new Date('2026-01-01T10:00:00Z'),
            messages: [
              expect.objectContaining({
                role: 'user',
                content: 'Which herbs?',
                timestamp: new Date('2026-01-01T10:00:01Z'),
              }),
              expect.objectContaining({
                role: 'assistant',
                content: 'Basil.',
                timestamp: new Date('2026-01-01T10:00:02Z'),
              }),
            ],
          }),
        ],
      },
    ])
    expect(await localThreadStore('device').get(listed.id)).toEqual(
      upgraded({ id: listed.id, title: 'Plants' }),
    )
    expect(client.upload).not.toHaveBeenCalled()
    expect(screen.getByRole('status')).toHaveTextContent('1 chat imported')
  })

  it("stores a signed-out visitor's Claude conversations in this tab", async () => {
    page.isSignedIn = false
    connect()
    acceptUpgrades()
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
    expect(upgradeRequests()).toEqual([
      {
        threads: [
          expect.objectContaining({
            id: listed.id,
            title: 'Soup',
            messages: [
              expect.objectContaining({ role: 'user', content: 'Leek soup?' }),
              expect.objectContaining({
                role: 'assistant',
                content: 'Yes.',
                thoughts: 'Warm',
              }),
            ],
          }),
        ],
      },
    ])
    expect(await localThreadStore('tab').get(listed.id)).toEqual(
      upgraded({ id: listed.id, title: 'Soup' }),
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
