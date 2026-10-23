import { ChatInterface } from '@/components/chat/chat-interface'
import { ProjectProvider } from '@/components/project/project-provider'
import { localThreadStore } from '@/services/harness/local-threads'
import { publish } from '@/services/harness/runtime'
import { HarnessError } from '@/services/harness/sse'
import type {
  Frame,
  Message,
  StoredThread,
  Turn,
} from '@/services/harness/types'
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import { client, KEY, signIn } from '../../harness-fixture'
import {
  rawRows,
  resetChatStoresAroundEachTest,
  storedThread,
} from '../../services/harness/thread-fixture'
import { refuseFetch } from './chat-interface-fixture'
import { chatPage } from './chat-page-mocks'

vi.mock('@clerk/react', async () => (await import('./chat-page-mocks')).clerk)
vi.mock('next/router', async () => (await import('./chat-page-mocks')).router)
// React places the title the page declares in the document head.
vi.mock('next/head', () => ({
  default: ({ children }: { children?: React.ReactNode }) => children,
}))
vi.mock('next/dynamic', async () => (await import('./chat-page-mocks')).dynamic)
vi.mock(
  '@/components/ui/logo-loading',
  async () => (await import('./chat-page-mocks')).logoLoading,
)
vi.mock(
  '@/hooks/use-subscription-status',
  async () => (await import('./chat-page-mocks')).subscription,
)
vi.mock(
  '@/hooks/use-passkey-backup',
  async () => (await import('./chat-page-mocks')).passkeyBackup,
)
vi.mock('@/components/chat/sidebar-account-menu', () => ({
  SidebarAccountMenu: () => null,
}))
vi.mock('@/hooks/use-upgrade-to-pro', () => ({
  useUpgradeToPro: () => ({ startUpgrade: vi.fn() }),
}))
vi.mock(
  '@/utils/error-handling',
  async () => (await import('./chat-page-mocks')).errorHandling,
)

resetChatStoresAroundEachTest()

const SIGNED_IN = { isLoaded: true, isSignedIn: true, userId: 'alice' }

beforeEach(() => {
  vi.stubGlobal('innerWidth', 1440)
  chatPage.auth = { ...SIGNED_IN }
  chatPage.premium = false
  chatPage.router.pathname = '/'
  chatPage.router.query = {}
  chatPage.router.asPath = '/'
  chatPage.router.replace.mockReset().mockResolvedValue(true)
  chatPage.router.push.mockReset().mockResolvedValue(true)
  refuseFetch()
})

function view(props: Partial<Parameters<typeof ChatInterface>[0]> = {}) {
  return (
    <ProjectProvider>
      <ChatInterface suppressIntroModals {...props} />
    </ProjectProvider>
  )
}

// A device run that returns the thread its turn made, with the reply and
// the title the harness gave it.
function scriptDeviceRuns(title = 'Trip ideas') {
  const returned: StoredThread[] = []
  client.events.mockImplementation(async function* (
    _path: string,
    input: Turn,
  ): AsyncGenerator<Frame> {
    const thread = storedThread(input.threadId!, {
      title,
      titleState: 'generated',
      lastRequestId: input.clientRequestId,
      messages: [
        ...(input.thread?.messages ?? []),
        {
          id: input.clientRequestId,
          role: 'user',
          createdAt: '2026-10-22T12:00:00Z',
          content: input.content,
        },
        {
          id: `reply-${returned.length}`,
          role: 'assistant',
          createdAt: '2026-10-22T12:00:01Z',
          timeline: [{ id: 'b1', type: 'content', content: 'Noted' }],
        },
      ],
    })
    returned.push(thread)
    yield {
      id: 0,
      event: { type: 'RUN_STARTED', threadId: input.threadId!, runId: 'run' },
    }
    yield {
      id: 1,
      event: {
        type: 'MESSAGES_SNAPSHOT',
        messages: thread.messages as Message[],
        hasOlder: false,
      },
    }
    const { messages, ...summary } = thread
    yield {
      id: 2,
      event: {
        type: 'STATE_SNAPSHOT',
        snapshot: {
          thread: { ...summary, messageCount: messages.length },
          queue: [],
        },
      },
    }
    yield {
      id: 3,
      event: {
        type: 'RUN_FINISHED',
        threadId: input.threadId!,
        runId: 'run',
        metadata: { thread },
      },
    }
  })
  return returned
}

async function send(content: string) {
  const input = await screen.findByRole('textbox', { name: /message/i })
  fireEvent.change(input, { target: { value: content } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
}

it('offers a signed-out visitor a temporary chat that is kept out of the tab', async () => {
  chatPage.auth = { isLoaded: true, isSignedIn: false, userId: null }
  signIn({ userId: null })
  const returned = scriptDeviceRuns()
  render(view())

  fireEvent.click(await screen.findByRole('button', { name: 'Temporary chat' }))
  const exit = screen.getByRole('button', { name: 'Exit temporary chat' })
  expect(exit).toHaveAttribute('aria-pressed', 'true')
  await send('Off the record')
  await screen.findByText('Noted')

  expect((client.events.mock.calls[0][1] as Turn).local).toBe(true)
  expect(returned).toHaveLength(1)
  expect(sessionStorage.getItem('tinfoil-sync-session-chats')).toBeNull()
  expect(await rawRows('chats')).toEqual([])
})

it('saves a temporary chat on this device with its title', async () => {
  signIn()
  const returned = scriptDeviceRuns('Trip ideas')
  render(view())
  fireEvent.click(await screen.findByRole('button', { name: 'Temporary chat' }))
  await send('Plan a trip')
  await screen.findByText('Noted')
  const threadId = (client.events.mock.calls[0][1] as Turn).threadId!
  expect(await rawRows('chats')).toEqual([])
  expect(chatPage.router.replace).not.toHaveBeenCalled()

  fireEvent.click(screen.getByRole('button', { name: 'Save chat' }))

  await waitFor(() =>
    expect(chatPage.router.replace).toHaveBeenCalledWith(
      `/chat/local/${threadId}`,
      undefined,
      { shallow: true },
    ),
  )
  expect(await localThreadStore('device').get(threadId)).toEqual(returned[0])
  const header = within(screen.getByRole('banner'))
  expect(header.getByRole('heading', { level: 1 })).toHaveTextContent(
    'Trip ideas',
  )
  expect(header.getByText('Only saved locally')).toBeInTheDocument()
  expect(header.queryByText('Temporary chat')).not.toBeInTheDocument()
  expect(
    screen.queryByRole('button', { name: /Save chat|Temporary chat/ }),
  ).not.toBeInTheDocument()

  await send('And then?')
  await waitFor(async () =>
    expect(await localThreadStore('device').get(threadId)).toEqual(returned[1]),
  )
  expect(client.events.mock.calls[1][1]).toMatchObject({
    threadId,
    local: true,
    thread: returned[0],
  })
})

it('saves a temporary chat to the cloud with cloud sync', async () => {
  signIn({ cloud: true })
  const returned = scriptDeviceRuns('Trip ideas')
  const imported: unknown[] = []
  client.post.mockImplementation(async (path, input) => {
    if (path === '/v1/projects/list') return { projects: [], nextCursor: null }
    if (path === '/v1/threads/list') return { threads: [], nextCursor: null }
    if (path === '/v1/threads/import') {
      imported.push(input)
      const { messages, ...summary } = returned[0]
      return { ...summary, messageCount: messages.length }
    }
    if (path === '/v1/threads/get')
      return {
        ...returned[0],
        messageCount: returned[0].messages.length,
        hasOlder: false,
      }
    throw new Error(`Unexpected ${path}`)
  })
  render(view())
  fireEvent.click(await screen.findByRole('button', { name: 'Temporary chat' }))
  await send('Plan a trip')
  await screen.findByText('Noted')
  const threadId = (client.events.mock.calls[0][1] as Turn).threadId!

  fireEvent.click(screen.getByRole('button', { name: 'Save chat' }))

  await waitFor(() =>
    expect(chatPage.router.replace).toHaveBeenCalledWith(
      `/chat/${threadId}`,
      undefined,
      { shallow: true },
    ),
  )
  expect(imported).toEqual([{ key: KEY, threadId, thread: returned[0] }])
  expect(await rawRows('chats')).toEqual([])
  const header = within(screen.getByRole('banner'))
  expect(header.getByRole('heading', { level: 1 })).toHaveTextContent(
    'Trip ideas',
  )
  expect(header.queryByText('Temporary chat')).not.toBeInTheDocument()
  expect(header.queryByText('Only saved locally')).not.toBeInTheDocument()
})

it('keeps an attached document when the chat becomes temporary', async () => {
  signIn()
  scriptDeviceRuns()
  const descriptor = {
    id: 'att_notes',
    kind: 'document',
    fileName: 'notes.txt',
    mimeType: 'text/plain',
    size: 5,
    textContent: 'notes',
  }
  client.upload.mockResolvedValueOnce({ attachment: descriptor })
  render(view())
  await screen.findByRole('button', { name: 'Temporary chat' })
  fireEvent.change(document.querySelector('input[type="file"]')!, {
    target: {
      files: [new File(['notes'], 'notes.txt', { type: 'text/plain' })],
    },
  })
  await waitFor(() => expect(client.upload).toHaveBeenCalledOnce())

  fireEvent.click(screen.getByRole('button', { name: 'Temporary chat' }))
  expect(
    screen.getByRole('button', { name: 'Exit temporary chat' }),
  ).toHaveAttribute('aria-pressed', 'true')
  await send('Summarize these')
  await screen.findByText('Noted')

  expect(client.events.mock.calls[0][1]).toMatchObject({
    local: true,
    content: 'Summarize these',
    attachments: [descriptor],
  })
  expect(await rawRows('chats')).toEqual([])
})

it('starts a normal chat after a temporary one', async () => {
  signIn()
  const returned = scriptDeviceRuns()
  render(view())
  fireEvent.click(await screen.findByRole('button', { name: 'Temporary chat' }))
  await send('Off the record')
  await screen.findByText('Noted')

  fireEvent.click(
    within(screen.getByRole('banner')).getByRole('link', { name: 'New chat' }),
  )

  expect(
    await screen.findByRole('button', { name: 'Temporary chat' }),
  ).toHaveAttribute('aria-pressed', 'false')
  await send('Keep this')
  await screen.findByText('Noted')
  const kept = client.events.mock.calls[1][1] as Turn
  expect(kept.threadId).not.toBe(
    (client.events.mock.calls[0][1] as Turn).threadId,
  )
  await waitFor(async () =>
    expect((await rawRows('chats')).map((row) => row.id)).toEqual([
      kept.threadId,
    ]),
  )
  await waitFor(async () =>
    expect(await localThreadStore('device').get(kept.threadId!)).toEqual(
      returned[1],
    ),
  )
})

const TRIP = storedThread('trip-chat', {
  title: 'Trip ideas',
  titleState: 'generated',
  messages: [
    {
      id: 'question',
      role: 'user',
      createdAt: '2026-10-22T12:00:00Z',
      content: 'Where should we go?',
    },
  ],
})

it('names the tab after a titled chat once it loads', async () => {
  signIn()
  await localThreadStore('device').add(TRIP)
  const { rerender } = render(view())
  await screen.findByRole('button', { name: 'Temporary chat' })
  expect(document.title).toBe('Tinfoil Chat')

  rerender(view({ initialChatId: TRIP.id, isLocalChatUrl: true }))
  expect(document.title).toBe('Tinfoil Chat')
  await screen.findByText('Where should we go?')

  expect(document.title).toBe('Trip ideas · Tinfoil Chat')
})

it('keeps the base tab title when chat titles are turned off', async () => {
  signIn({ profile: { browserTabChatTitleEnabled: false } })
  await localThreadStore('device').add(TRIP)
  render(view({ initialChatId: TRIP.id, isLocalChatUrl: true }))
  await screen.findByText('Where should we go?')
  expect(
    within(screen.getByRole('banner')).getByRole('heading', { level: 1 }),
  ).toHaveTextContent('Trip ideas')

  expect(document.title).toBe('Tinfoil Chat')
})

it('keeps the base tab title for a temporary chat the harness named', async () => {
  signIn()
  scriptDeviceRuns('Trip ideas')
  render(view())
  fireEvent.click(await screen.findByRole('button', { name: 'Temporary chat' }))
  await send('Plan a trip')
  await screen.findByText('Noted')
  expect(
    within(screen.getByRole('banner')).getByRole('heading', { level: 1 }),
  ).toHaveTextContent('Trip ideas')

  expect(document.title).toBe('Tinfoil Chat')
})

it.each([
  ['missing', 'Chat not found'],
  ['unreachable', "Couldn't load chat"],
  ['encrypted with another key', 'Unable to decrypt chat'],
])(
  'shows no title or times above a chat that is %s',
  async (failure, heading) => {
    signIn({ cloud: true })
    client.post.mockImplementation(async (path) => {
      if (path === '/v1/projects/list')
        return { projects: [], nextCursor: null }
      if (path === '/v1/threads/list') return { threads: [], nextCursor: null }
      if (path === '/v1/threads/get') {
        if (failure === 'unreachable') throw new TypeError('Network down')
        throw new HarnessError(
          failure === 'missing'
            ? { code: 'THREAD_NOT_FOUND', message: 'No such chat' }
            : { code: 'KEY_MISMATCH', message: 'Another key' },
          failure === 'missing' ? 404 : 409,
        )
      }
      throw new Error(`Unexpected ${path}`)
    })
    render(view({ initialChatId: 'gone-chat' }))
    await screen.findByRole('heading', { name: heading })

    const header = within(screen.getByRole('banner'))
    expect(
      header.getByRole('button', { name: 'Open verification panel' }),
    ).toBeInTheDocument()
    expect(header.queryByRole('heading', { level: 1 })).not.toBeInTheDocument()
    expect(header.queryByText(/ ago$/)).not.toBeInTheDocument()
  },
)

it.each([
  [
    'this browser',
    { isLocalChatUrl: true },
    'This local chat may have been deleted from your browser.',
  ],
  [
    'the cloud',
    {},
    'This chat may have been deleted or is no longer available.',
  ],
])(
  'explains a chat missing from %s and starts a new one',
  async (_where, route, explanation) => {
    signIn({ cloud: true })
    client.post.mockImplementation(async (path) => {
      if (path === '/v1/projects/list')
        return { projects: [], nextCursor: null }
      if (path === '/v1/threads/list') return { threads: [], nextCursor: null }
      if (path === '/v1/threads/get')
        throw new HarnessError(
          { code: 'THREAD_NOT_FOUND', message: 'No such chat' },
          404,
        )
      throw new Error(`Unexpected ${path}`)
    })
    render(view({ initialChatId: 'gone-chat', ...route }))
    await screen.findByRole('heading', { name: 'Chat not found' })
    const status = within(
      screen.getByRole('region', { name: 'Chat history unavailable' }),
    )
    expect(status.getByRole('alert')).toHaveTextContent(explanation)

    fireEvent.click(status.getByRole('button', { name: 'Start new chat' }))

    expect(chatPage.router.replace).toHaveBeenCalledExactlyOnceWith(
      '/',
      undefined,
      { shallow: true },
    )
    expect(chatPage.router.push).not.toHaveBeenCalled()
  },
)

it('explains a chat that failed to load once and offers a new chat', async () => {
  signIn({ cloud: true })
  client.post.mockImplementation(async (path) => {
    if (path === '/v1/projects/list') return { projects: [], nextCursor: null }
    if (path === '/v1/threads/list') return { threads: [], nextCursor: null }
    if (path === '/v1/threads/get')
      throw new HarnessError(
        { code: 'UPSTREAM_REFUSED', message: 'sync: 502 bad gateway' },
        502,
      )
    throw new Error(`Unexpected ${path}`)
  })
  render(view({ initialChatId: 'broken-chat' }))
  await screen.findByRole('heading', { name: "Couldn't load chat" })
  const region = screen.getByRole('region', {
    name: 'Chat history unavailable',
  })
  const status = within(region)
  expect(screen.getAllByRole('alert')).toEqual([status.getByRole('alert')])
  expect(status.getByRole('alert')).toHaveTextContent(
    'A network error occurred while loading this chat. Please try again.',
  )
  expect(status.getByRole('button', { name: 'Try again' })).toBeEnabled()

  fireEvent.click(status.getByRole('button', { name: 'Start new chat' }))

  expect(chatPage.router.replace).toHaveBeenCalledExactlyOnceWith(
    '/',
    undefined,
    { shallow: true },
  )
  expect(chatPage.router.push).not.toHaveBeenCalled()
})

it('explains a chat service that could not start without its raw error', async () => {
  signIn()
  publish({
    session: undefined,
    error: 'harness: dial tcp 10.0.0.7:443: connection refused',
  })
  render(view())

  await screen.findByRole('heading', { name: 'Something went wrong' })
  expect(screen.getByRole('alert')).toHaveTextContent(
    "Tinfoil Chat is experiencing some technical difficulties. We're working on resolving it. Please try again later.",
  )
  expect(screen.queryByText(/connection refused/)).not.toBeInTheDocument()
})

// A cloud chat of three turns, shown from its latest one.
const TURNS = [1, 2, 3].flatMap((turn) => [
  {
    id: `u${turn}`,
    role: 'user' as const,
    createdAt: `2026-10-22T12:0${turn}:00Z`,
    content: `Question ${turn}`,
  },
  {
    id: `a${turn}`,
    role: 'assistant' as const,
    createdAt: `2026-10-22T12:0${turn}:30Z`,
    timeline: [
      { id: `b${turn}`, type: 'content' as const, content: `Answer ${turn}` },
    ],
  },
])

function scriptLongChat() {
  signIn({ cloud: true })
  const page = (messages: typeof TURNS, hasOlder: boolean) => ({
    ...storedThread('long-chat', { title: 'Long chat', messages }),
    titleState: 'generated',
    messageCount: TURNS.length,
    hasOlder,
  })
  const pages: unknown[] = []
  client.post.mockImplementation(async (path, input) => {
    if (path === '/v1/projects/list') return { projects: [], nextCursor: null }
    if (path === '/v1/threads/list') return { threads: [], nextCursor: null }
    if (path === '/v1/threads/get') {
      const { before } = input as { before?: string }
      if (!before) return page(TURNS.slice(4), true)
      pages.push(input)
      return before === 'u3'
        ? page(TURNS.slice(2, 4), true)
        : page(TURNS.slice(0, 2), false)
    }
    throw new Error(`Unexpected ${path}`)
  })
  render(view({ initialChatId: 'long-chat' }))
  return pages
}

const shownMessages = () =>
  within(screen.getByRole('log', { name: 'Conversation' }))
    .getAllByRole('article')
    .map((article) => article.textContent)

it('shows every earlier message of a long chat from the conversation', async () => {
  const pages = scriptLongChat()
  await screen.findByText('Question 3')
  const log = within(screen.getByRole('log', { name: 'Conversation' }))

  fireEvent.click(log.getByRole('button', { name: 'Show 4 earlier messages' }))

  await waitFor(() =>
    expect(
      log.queryByRole('button', { name: /earlier messages/ }),
    ).not.toBeInTheDocument(),
  )
  expect(pages).toEqual([
    { key: KEY, id: 'long-chat', before: 'u3' },
    { key: KEY, id: 'long-chat', before: 'u2' },
  ])
  expect(shownMessages()).toEqual(
    TURNS.map((message) =>
      expect.stringContaining(
        message.role === 'user' ? message.content : message.timeline[0].content,
      ),
    ),
  )
})

it('prints a long chat with its earlier messages', async () => {
  const printed: string[] = []
  vi.doMock('html2pdf.js', () => ({
    default: () => {
      const chain = {
        set: () => chain,
        from: (element: HTMLElement) => {
          printed.push(element.textContent ?? '')
          return chain
        },
        outputPdf: async () => new Blob(['pdf']),
      }
      return chain
    },
  }))
  onTestFinished(() => {
    vi.doUnmock('html2pdf.js')
  })
  vi.stubGlobal(
    'open',
    vi.fn(() => null),
  )
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:printed')
  const pages = scriptLongChat()
  await screen.findByText('Question 3')

  fireEvent.keyDown(window, { key: 'p', metaKey: true })

  await waitFor(() => expect(printed).toHaveLength(1))
  expect(pages).toHaveLength(2)
  const order = TURNS.map((message) =>
    printed[0].indexOf(
      message.role === 'user' ? message.content : message.timeline[0].content,
    ),
  )
  expect(order.every((at) => at >= 0)).toBe(true)
  expect(order).toEqual([...order].sort((a, b) => a - b))
  expect(window.open).toHaveBeenCalledExactlyOnceWith('blob:printed', '_blank')
})
