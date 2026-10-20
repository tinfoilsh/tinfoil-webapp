import { SettingsModal } from '@/components/chat/settings-modal'
import { localThreadStore } from '@/services/harness/local-threads'
import { HarnessError } from '@/services/harness/sse'
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { client, KEY, signIn } from '../../harness-fixture'
import {
  rawRows,
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

// The parts of the one multipart request, in order: JSON parts parsed, and
// files by name, type and content.
async function sentForm() {
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

    expect(await sentForm()).toEqual({
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

    expect((await sentForm()).parts).toEqual([
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

    expect((await sentForm()).parts).toEqual([
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

  it('explains an export refused while other archives fill the temporary space', async () => {
    connect({ cloud: true })
    client.multipart.mockRejectedValue(
      new HarnessError(
        { code: 'TEMP_SPACE_BUSY', message: 'retry shortly', retryAfter: 30 },
        503,
      ),
    )
    renderData()

    await exportChats()

    expect(page.toast).toHaveBeenCalledExactlyOnceWith({
      title: 'Export failed',
      description:
        'The chat service is busy with other archives. Try again shortly.',
      variant: 'destructive',
    })
    expect(downloads).toEqual([])
  })

  it('explains a Claude projects export refused while other archives fill the temporary space', async () => {
    connect({ cloud: true })
    client.multipart.mockRejectedValue(
      new HarnessError(
        { code: 'TEMP_SPACE_BUSY', message: 'retry shortly', retryAfter: 30 },
        503,
      ),
    )
    renderData({ isPremium: true })

    fireEvent.click(
      screen.getByRole('button', { name: 'Export Projects for Claude' }),
    )

    expect(
      await screen.findByText(
        'The chat service is busy with other archives. Try again shortly.',
      ),
    ).toBeVisible()
    const [path, form] = client.multipart.mock.calls[0] as [string, FormData]
    expect([path, JSON.parse(form.get('options') as string)]).toEqual([
      '/v1/export',
      { format: 'claude-projects', key: KEY },
    ])
    expect(downloads).toEqual([])
  })
})

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
  ['[{"title":"Plants","mapping":{}}]'],
  'conversations.json',
  { type: 'application/json' },
)

// A chat the chat service converted for this device, with its image's copy
// for models.
const herbs = {
  id: 'att_herbs',
  kind: 'image' as const,
  fileName: 'herbs.png',
  mimeType: 'image/png',
  size: 8,
  base64: 'bW9kZWw=',
}
const imported = storedThread('import_plants', {
  title: 'Plants',
  titleState: 'generated',
  messages: [
    {
      id: 'u1',
      role: 'user',
      createdAt: '2026-01-01T10:00:01Z',
      content: 'Which herbs?',
      attachments: [herbs],
    },
  ],
})
// The chat as the import's line carries it, with the original inline.
const importedLine = {
  ...imported,
  messages: [
    {
      ...imported.messages[0],
      attachments: [{ ...herbs, originalBase64: 'b3JpZ2luYWw=' }],
    },
  ],
}

// An import's response: a line per chat for this device, then the last line.
function answerImport(threads: object[], done: object) {
  client.multipart.mockResolvedValue(
    new Response(
      [...threads.map((thread) => ({ thread })), { done }]
        .map((line) => `${JSON.stringify(line)}\n`)
        .join(''),
    ),
  )
}

describe('importing chats from the Data tab', () => {
  async function importStaged(label = 'Import conversations') {
    fireEvent.click(screen.getByRole('button', { name: label }))
    await waitFor(() => expect(page.toast).toHaveBeenCalled())
  }

  it('stores the chats the chat service returns on this device without cloud sync', async () => {
    connect()
    answerImport([importedLine], {
      jobId: null,
      warnings: ['1 attachment could not be read.'],
    })
    renderData()

    pickFiles('ChatGPT', [chatGptExport])
    await importStaged()

    expect(await sentForm()).toEqual({
      path: '/v1/import',
      parts: [
        ['options', { target: 'device' }],
        [
          'file',
          'conversations.json',
          'application/json',
          await chatGptExport.text(),
        ],
      ],
    })
    expect(page.toast).toHaveBeenCalledExactlyOnceWith({
      title: 'Import complete',
      description: 'Imported 1 chat from ChatGPT',
    })
    expect(await localThreadStore('device').get(imported.id)).toEqual(imported)
    expect(await rawRows('attachmentOriginals')).toEqual([
      {
        chatId: imported.id,
        attachmentId: 'att_herbs',
        base64: 'b3JpZ2luYWw=',
        mimeType: 'image/png',
      },
    ])
    expect(client.post).not.toHaveBeenCalled()
    const status = screen.getByRole('status')
    expect(status).toHaveTextContent('1 chat imported')
    expect(status).toHaveTextContent('1 attachment could not be read.')
  })

  it('counts the chats stored on this device while the import runs', async () => {
    connect()
    const line = (value: object) =>
      new TextEncoder().encode(`${JSON.stringify(value)}\n`)
    let send!: ReadableStreamDefaultController<Uint8Array>
    client.multipart.mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start: (controller) => {
            send = controller
          },
        }),
      ),
    )
    renderData()

    pickFiles('ChatGPT', [chatGptExport])
    fireEvent.click(
      screen.getByRole('button', { name: 'Import conversations' }),
    )
    send.enqueue(line({ thread: importedLine }))

    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        'Importing chats...1 chat imported so far',
      ),
    )
    expect(page.toast).not.toHaveBeenCalled()
    send.enqueue(line({ done: { jobId: null, warnings: [] } }))
    send.close()
    await waitFor(() =>
      expect(page.toast).toHaveBeenCalledExactlyOnceWith({
        title: 'Import complete',
        description: 'Imported 1 chat from ChatGPT',
      }),
    )
  })

  it('keeps the chats stored before an import fails partway and shows why', async () => {
    connect()
    client.multipart.mockResolvedValue(
      new Response(
        [
          { thread: importedLine },
          {
            error: {
              code: 'UPSTREAM_REFUSED',
              message: 'Storage refused the chats.',
            },
          },
        ]
          .map((line) => `${JSON.stringify(line)}\n`)
          .join(''),
      ),
    )
    renderData()

    pickFiles('ChatGPT', [chatGptExport])
    await importStaged()

    expect(page.toast).toHaveBeenCalledExactlyOnceWith({
      title: 'Import failed',
      description: 'Could not start the ChatGPT import',
      variant: 'destructive',
    })
    expect(
      within(screen.getByRole('status')).getByText(
        'Storage refused the chats.',
      ),
    ).toBeVisible()
    expect(await localThreadStore('device').get(imported.id)).toEqual(imported)
  })

  it("stores a signed-out visitor's chats in this tab", async () => {
    page.isSignedIn = false
    connect()
    answerImport([imported], { jobId: null, warnings: [] })
    renderData()

    pickFiles('Claude', [new File(['[]'], 'conversations.json')])
    await importStaged()

    expect((await sentForm()).parts[0]).toEqual([
      'options',
      { target: 'device' },
    ])
    expect(page.toast).toHaveBeenCalledExactlyOnceWith({
      title: 'Import complete',
      description: 'Imported 1 chat from Claude',
    })
    expect(await localThreadStore('device').list()).toEqual([])
    expect(await localThreadStore('tab').get(imported.id)).toEqual(imported)
  })

  it('imports to the cloud with cloud sync and follows the job it started', async () => {
    connect({ cloud: true })
    answerImport([], { jobId: 'job-1', warnings: [] })
    client.post.mockImplementation(async (path: string) => {
      if (path !== '/v1/import/status') throw new Error(`Unexpected ${path}`)
      return { status: 'running', imported: 0, failed: 0, total: 1 }
    })
    renderData()

    pickFiles('ChatGPT', [chatGptExport])
    await importStaged()

    expect((await sentForm()).parts[0]).toEqual([
      'options',
      { target: 'cloud', key: KEY },
    ])
    expect(client.post).toHaveBeenCalledExactlyOnceWith(
      '/v1/import/status',
      { jobId: 'job-1' },
      expect.any(AbortSignal),
    )
    expect(page.toast).toHaveBeenCalledExactlyOnceWith({
      title: 'Import started',
      description:
        "Your ChatGPT export is being imported securely. We'll email you when it's done.",
    })
    expect(await localThreadStore('device').list()).toEqual([])
  })

  it('shows what the cloud job could not import as it was', async () => {
    connect({ cloud: true })
    answerImport([], { jobId: 'job-1', warnings: [] })
    const statuses = [
      {
        status: 'running',
        imported: 0,
        failed: 0,
        total: 2,
        warnings: ['1 project was skipped.'],
      },
      {
        status: 'partial',
        imported: 1,
        failed: 1,
        total: 2,
        warnings: ['1 project was skipped.', '1 chat had no messages.'],
      },
    ]
    client.post.mockImplementation(async (path: string) => {
      if (path === '/v1/projects/list')
        return { projects: [], nextCursor: null }
      if (path !== '/v1/import/status') throw new Error(`Unexpected ${path}`)
      return statuses.shift()
    })
    renderData()

    pickFiles('ChatGPT', [chatGptExport])
    await importStaged()

    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        '1 project was skipped.',
      ),
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'Check import progress' }),
    )
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        '1 chat had no messages.',
      ),
    )
    expect(screen.getByRole('status')).toHaveTextContent('1 chat imported')
  })

  it("sends Claude's project files to the cloud without cloud sync", async () => {
    connect()
    answerImport([], { jobId: 'job-1', warnings: [] })
    client.post.mockImplementation(async (path: string) => {
      if (path === '/v1/projects/list')
        return { projects: [], nextCursor: null }
      if (path !== '/v1/import/status') throw new Error(`Unexpected ${path}`)
      return { status: 'completed', imported: 0, failed: 0, total: 0 }
    })
    renderData({ isPremium: true })

    pickFiles('Claude', [new File(['{}'], 'projects.json')], 1)
    await importStaged('Import projects')

    expect((await sentForm()).parts[0]).toEqual([
      'options',
      { target: 'cloud', key: KEY },
    ])
    // The imported projects are listed once the job completes.
    await waitFor(() =>
      expect(
        client.post.mock.calls.map(([path, input]) => [path, input]),
      ).toEqual([
        ['/v1/import/status', { jobId: 'job-1' }],
        ['/v1/projects/list', { key: KEY, cursor: null }],
      ]),
    )
  })

  it.each([
    [
      'ARCHIVE_TOO_LARGE',
      413,
      'This archive is too large for the chat service to process.',
    ],
    [
      'TEMP_SPACE_BUSY',
      503,
      'The chat service is busy with other archives. Try again shortly.',
    ],
    [
      'PROJECTS_REQUIRE_CLOUD',
      400,
      'This file includes projects, which are kept in the cloud. Turn on cloud sync, then try again.',
    ],
    [
      'IMPORT_INVALID',
      400,
      'This file could not be read. Select a Tinfoil backup or a ChatGPT, Claude, or Tinfoil export as you downloaded it.',
    ],
    [
      'IMPORT_TOO_LARGE',
      413,
      'This file is larger than the import limits allow. Try a smaller export or backup.',
    ],
    [
      'PAYLOAD_TOO_LARGE',
      413,
      'This is more than the chat service accepts. Remove some large images or documents, or choose a smaller file, then try again.',
    ],
  ])('explains an import refused with %s', async (code, status, copy) => {
    connect()
    client.multipart.mockRejectedValue(
      new HarnessError({ code, message: `harness says ${code}` }, status),
    )
    renderData()

    pickFiles('ChatGPT', [chatGptExport])
    await importStaged()

    expect(page.toast).toHaveBeenCalledExactlyOnceWith({
      title: 'Import failed',
      description: 'Could not start the ChatGPT import',
      variant: 'destructive',
    })
    expect(within(screen.getByRole('status')).getByText(copy)).toBeVisible()
    expect(screen.queryByText(`harness says ${code}`)).toBeNull()
    expect(await localThreadStore('device').list()).toEqual([])
  })
})
