import { ChatInterface } from '@/components/chat/chat-interface'
import { ProjectProvider } from '@/components/project/project-provider'
import {
  UI_SIDEBAR_OPEN,
  UI_SIDEBAR_PROJECTS_EXPANDED,
} from '@/constants/storage-keys'
import ChatPage from '@/pages/chat/[[...slug]]'
import HomePage from '@/pages/index'
import NewChatPage from '@/pages/newchat'
import ProjectPage from '@/pages/project/[[...slug]]'
import { localThreadStore } from '@/services/harness/local-threads'
import { publish } from '@/services/harness/runtime'
import { HarnessError } from '@/services/harness/sse'
import type { Frame, Turn } from '@/services/harness/types'
import { indexedDBStorage } from '@/services/storage/indexed-db'
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { client, KEY, signIn } from '../../harness-fixture'
import {
  resetChatStoresAroundEachTest,
  storedThread,
} from '../../services/harness/thread-fixture'
import { refuseFetch } from './chat-interface-fixture'
import { chatPage } from './chat-page-mocks'

vi.mock('@clerk/react', async () => (await import('./chat-page-mocks')).clerk)
vi.mock('next/router', async () => (await import('./chat-page-mocks')).router)
vi.mock('next/head', async () => (await import('./chat-page-mocks')).head)
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

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

beforeEach(() => {
  vi.stubGlobal('innerWidth', 1440)
  chatPage.premium = false
  chatPage.router.pathname = '/'
  chatPage.router.query = {}
  chatPage.router.replace.mockReset().mockResolvedValue(true)
  chatPage.router.push.mockReset().mockResolvedValue(true)
  refuseFetch()
})

function scriptRun() {
  const accepted = gate()
  const reply = gate()
  const finished = gate()
  client.events.mockImplementation(async function* (
    _path: string,
    input: Turn,
  ): AsyncGenerator<Frame> {
    await accepted.promise
    yield {
      id: 0,
      event: {
        type: 'RUN_STARTED',
        runId: 'reply',
        threadId: input.threadId!,
        instance: 'instance-1',
      },
    }
    await reply.promise
    yield {
      id: 1,
      event: {
        type: 'TEXT_MESSAGE_CHUNK',
        messageId: 'answer',
        role: 'assistant',
        delta: 'The answer is here.',
      },
    }
    await finished.promise
    yield {
      id: 2,
      event: {
        type: 'RUN_FINISHED',
        runId: 'reply',
        threadId: input.threadId!,
        metadata: {},
      },
    }
  })
  client.post.mockImplementation(async (path) => {
    if (path === '/v1/threads/list') return { threads: [], nextCursor: null }
    if (path === '/v1/threads/cancel') return { cancelled: true }
    throw new Error(`Unexpected ${path}`)
  })
  return { accepted, reply, finished }
}

async function send() {
  const input = await screen.findByRole('textbox', { name: /message/i })
  fireEvent.change(input, { target: { value: 'Explain this to me' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
}

it.each(['/', '/newchat'])(
  'keeps the conversation mounted from %s through the first streamed reply',
  async (route) => {
    signIn({ cloud: true })
    const { accepted, reply, finished } = scriptRun()
    chatPage.router.pathname = route
    const { rerender } = render(route === '/' ? <HomePage /> : <NewChatPage />)
    await send()
    expect(screen.getByRole('article', { name: 'You said' })).toHaveTextContent(
      'Explain this to me',
    )
    expect(
      screen.getByRole('status', { name: 'Waiting for response' }),
    ).toBeVisible()
    const conversation = screen.getByRole('log', { name: 'Conversation' })
    const scrollContainer = screen.getByRole('main', { name: 'Conversation' })
    await act(async () => accepted.resolve())
    await waitFor(() => expect(chatPage.router.replace).toHaveBeenCalled())
    const input = client.events.mock.calls[0][1] as Turn
    chatPage.router.pathname = '/chat/[[...slug]]'
    chatPage.router.query = { slug: [input.threadId!] }
    rerender(<ChatPage />)
    expect(screen.getByRole('log', { name: 'Conversation' })).toBe(conversation)
    expect(screen.getByRole('main', { name: 'Conversation' })).toBe(
      scrollContainer,
    )
    expect(
      screen.queryByRole('status', { name: 'Loading chat history' }),
    ).not.toBeInTheDocument()
    await act(async () => reply.resolve())
    expect(screen.getByRole('article', { name: 'Al said' })).toHaveTextContent(
      'The answer is here.',
    )
    expect(
      screen.queryByRole('status', { name: 'Waiting for response' }),
    ).not.toBeInTheDocument()
    await act(async () => finished.resolve())
    expect(client.events).toHaveBeenCalledTimes(1)
    expect(
      client.post.mock.calls.some(([path]) => path === '/v1/threads/get'),
    ).toBe(false)

    chatPage.router.pathname = '/'
    chatPage.router.query = {}
    chatPage.router.replace.mockClear()
    rerender(<HomePage />)
    expect(
      screen.queryByRole('article', { name: 'You said' }),
    ).not.toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: /message/i })).toHaveValue('')
    expect(chatPage.router.replace).not.toHaveBeenCalled()
  },
)

it.each(['the send button', 'Enter'])(
  'sends the message without surrounding spaces from %s',
  async (method) => {
    signIn({ cloud: true })
    const { accepted, reply, finished } = scriptRun()
    render(
      <ProjectProvider>
        <ChatInterface suppressIntroModals />
      </ProjectProvider>,
    )
    const input = await screen.findByRole('textbox', { name: /message/i })
    fireEvent.change(input, { target: { value: '  Explain this to me \n' } })
    if (method === 'Enter') fireEvent.keyDown(input, { key: 'Enter' })
    else fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => expect(client.events).toHaveBeenCalledOnce())
    expect((client.events.mock.calls[0][1] as Turn).content).toBe(
      'Explain this to me',
    )
    await act(async () => {
      accepted.resolve()
      reply.resolve()
      finished.resolve()
    })
  },
)

it('titles a new chat Untitled as soon as its first message is sent', async () => {
  signIn({ cloud: true })
  const { accepted, reply, finished } = scriptRun()
  render(
    <ProjectProvider>
      <ChatInterface suppressIntroModals />
    </ProjectProvider>,
  )
  await send()

  const header = within(screen.getByRole('banner'))
  expect(header.getByRole('heading', { level: 1 })).toHaveTextContent(
    'Untitled',
  )
  await act(async () => {
    accepted.resolve()
    reply.resolve()
    finished.resolve()
  })
})

it('shows the message and loading dot before device storage is ready, and can stop before sending', async () => {
  signIn()
  scriptRun()
  const reading = gate()
  const getChat = indexedDBStorage.getChat.bind(indexedDBStorage)
  vi.spyOn(indexedDBStorage, 'getChat').mockImplementationOnce(async (id) => {
    await reading.promise
    return getChat(id)
  })
  render(
    <ProjectProvider>
      <ChatInterface suppressIntroModals />
    </ProjectProvider>,
  )
  await send()
  expect(screen.getByRole('article', { name: 'You said' })).toHaveTextContent(
    'Explain this to me',
  )
  expect(
    screen.getByRole('status', { name: 'Waiting for response' }),
  ).toBeVisible()
  expect(client.events).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Stop generation' }))
  expect(
    screen.queryByRole('status', { name: 'Waiting for response' }),
  ).not.toBeInTheDocument()
  await act(async () => reading.resolve())
  await waitFor(async () =>
    expect(await localThreadStore('device').list()).toHaveLength(1),
  )
  expect(client.events).not.toHaveBeenCalled()
  const [kept] = await localThreadStore('device').list()
  expect(
    (await localThreadStore('device').get(kept.id))?.messages.map(
      (m) => m.content,
    ),
  ).toEqual(['Explain this to me'])
})

it('applies device-only mode when a blank page navigates to a local new chat', async () => {
  signIn({ cloud: true })
  const { accepted, reply, finished } = scriptRun()
  const { rerender } = render(<HomePage />)
  await screen.findByRole('textbox', { name: /message/i })
  chatPage.router.pathname = '/newchat'
  chatPage.router.query = { storage: 'local' }
  rerender(<NewChatPage />)
  await send()
  await waitFor(() => expect(client.events).toHaveBeenCalledTimes(1))
  const input = client.events.mock.calls[0][1] as Turn
  expect(input.local).toBe(true)
  expect(input.key).toBeUndefined()
  await act(async () => {
    accepted.resolve()
    reply.resolve()
    finished.resolve()
  })
})

it('keeps the shell and loaded project when its URL changes, and exits it when the URL leaves', async () => {
  signIn({ cloud: true })
  chatPage.premium = true
  sessionStorage.setItem(UI_SIDEBAR_OPEN, 'true')
  sessionStorage.setItem(UI_SIDEBAR_PROJECTS_EXPANDED, 'true')
  const project = {
    id: 'research',
    name: 'Research',
    description: '',
    systemInstructions: '',
    documents: [],
    createdAt: '2026-10-22T12:00:00Z',
    updatedAt: '2026-10-22T12:00:00Z',
  }
  client.post.mockImplementation(async (path) => {
    if (path === '/v1/projects/list')
      return { projects: [project], nextCursor: null }
    if (path === '/v1/projects/get') return project
    if (path === '/v1/threads/list') return { threads: [], nextCursor: null }
    throw new Error(`Unexpected ${path}`)
  })
  const { rerender } = render(<HomePage />)
  const main = await screen.findByRole('main', { name: 'Conversation' })
  fireEvent.click(await screen.findByRole('link', { name: /^Research\b/ }))
  await waitFor(() =>
    expect(chatPage.router.replace).toHaveBeenLastCalledWith(
      '/project/research',
      undefined,
      { shallow: true },
    ),
  )
  chatPage.router.pathname = '/project/[[...slug]]'
  chatPage.router.query = { slug: [project.id] }
  rerender(<ProjectPage />)
  expect(screen.getByRole('main', { name: 'Conversation' })).toBe(main)
  expect(
    await screen.findByRole('heading', { name: project.name }),
  ).toBeInTheDocument()
  expect(
    client.post.mock.calls.filter(([path]) => path === '/v1/projects/get'),
  ).toHaveLength(1)
  chatPage.router.pathname = '/'
  chatPage.router.query = {}
  rerender(<HomePage />)
  await waitFor(() =>
    expect(
      screen.queryByRole('heading', { name: project.name }),
    ).not.toBeInTheDocument(),
  )
  expect(screen.getByRole('main', { name: 'Conversation' })).toBe(main)
})

it('abandons a device turn still being prepared when another chat is opened', async () => {
  signIn()
  const other = storedThread('other-chat', {
    messages: [
      {
        id: 'other-message',
        role: 'user',
        content: 'A different conversation',
        createdAt: '2026-10-22T12:00:00Z',
      },
    ],
  })
  await localThreadStore('device').add(other)
  scriptRun()
  const reading = gate()
  const getChat = indexedDBStorage.getChat.bind(indexedDBStorage)
  vi.spyOn(indexedDBStorage, 'getChat').mockImplementationOnce(async (id) => {
    await reading.promise
    return getChat(id)
  })
  const { rerender } = render(
    <ProjectProvider>
      <ChatInterface suppressIntroModals />
    </ProjectProvider>,
  )
  await send()
  expect(
    screen.getByRole('status', { name: 'Waiting for response' }),
  ).toBeVisible()
  rerender(
    <ProjectProvider>
      <ChatInterface
        initialChatId={other.id}
        isLocalChatUrl
        suppressIntroModals
      />
    </ProjectProvider>,
  )
  await screen.findByText('A different conversation')
  await act(async () => reading.resolve())
  expect(
    screen.queryByRole('status', { name: 'Waiting for response' }),
  ).not.toBeInTheDocument()
  expect(screen.queryByText('Explain this to me')).not.toBeInTheDocument()
  expect(client.events).not.toHaveBeenCalled()
  expect((await localThreadStore('device').list()).map((t) => t.id)).toEqual([
    other.id,
  ])
})

it('cancels the accepted run when Stop was clicked before acknowledgment', async () => {
  signIn({ cloud: true })
  const { accepted, reply, finished } = scriptRun()
  render(
    <ProjectProvider>
      <ChatInterface suppressIntroModals />
    </ProjectProvider>,
  )
  await send()
  await waitFor(() => expect(client.events).toHaveBeenCalledTimes(1))
  fireEvent.click(screen.getByRole('button', { name: 'Stop generation' }))
  expect(
    client.post.mock.calls.some(([path]) => path === '/v1/threads/cancel'),
  ).toBe(false)
  await act(async () => accepted.resolve())
  const input = client.events.mock.calls[0][1] as Turn
  expect(client.post).toHaveBeenCalledWith(
    '/v1/threads/cancel',
    {
      key: KEY,
      threadId: input.threadId,
      runId: 'reply',
    },
    expect.anything(),
  )
  await act(async () => {
    reply.resolve()
    finished.resolve()
  })
})

it('clears a failed preparation and retries it without duplicating the message', async () => {
  signIn()
  const { accepted, reply, finished } = scriptRun()
  const reading = gate()
  vi.spyOn(indexedDBStorage, 'getChat').mockImplementationOnce(async () => {
    await reading.promise
    throw new Error('Storage unavailable')
  })
  render(
    <ProjectProvider>
      <ChatInterface suppressIntroModals />
    </ProjectProvider>,
  )
  await send()
  expect(
    screen.getByRole('status', { name: 'Waiting for response' }),
  ).toBeVisible()
  await act(async () => reading.resolve())
  expect(
    screen.queryByRole('status', { name: 'Waiting for response' }),
  ).not.toBeInTheDocument()
  expect(screen.getByRole('article', { name: 'You said' })).toHaveTextContent(
    'Explain this to me',
  )
  fireEvent.click(screen.getByRole('button', { name: 'Expand error details' }))
  expect(screen.getByText('Storage unavailable')).toBeInTheDocument()
  expect(client.events).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Resend message' }))
  expect(
    screen.getByRole('status', { name: 'Waiting for response' }),
  ).toBeVisible()
  await waitFor(() => expect(client.events).toHaveBeenCalledTimes(1))
  await act(async () => {
    accepted.resolve()
    reply.resolve()
    finished.resolve()
  })
  expect(screen.getAllByRole('article', { name: 'You said' })).toHaveLength(1)
  expect(screen.getByRole('article', { name: 'Al said' })).toHaveTextContent(
    'The answer is here.',
  )
})

it('shows a chat the locked key keeps closed as unavailable, then loads it once unlocked', async () => {
  const api = signIn({ cloud: true, locked: true })
  const history = gate()
  const thread = {
    ...storedThread('locked-chat'),
    messageCount: 1,
    hasOlder: false,
    messages: [
      {
        id: 'question',
        role: 'user' as const,
        content: 'Saved question',
        createdAt: '2026-10-22T12:00:00Z',
      },
    ],
  }
  client.post.mockImplementation(async (path) => {
    if (path === '/v1/threads/list') return { threads: [], nextCursor: null }
    if (path === '/v1/threads/get') {
      await history.promise
      return thread
    }
    throw new Error(`Unexpected ${path}`)
  })
  render(
    <ProjectProvider>
      <ChatInterface initialChatId={thread.id} suppressIntroModals />
    </ProjectProvider>,
  )
  expect(
    await screen.findByRole('heading', { name: 'Unlock chat history' }),
  ).toBeVisible()
  const header = within(screen.getByRole('banner'))
  expect(header.queryByRole('heading', { level: 1 })).not.toBeInTheDocument()
  expect(header.queryByText('Loading chat')).not.toBeInTheDocument()
  const composer = document.querySelector('[data-chat-input-area]')!
  expect(composer).not.toHaveAttribute('aria-busy')
  expect(screen.getByRole('textbox', { name: /message/i })).toBeDisabled()
  vi.spyOn(api, 'key').mockReturnValue(KEY)
  await act(async () => publish({ keyReady: true }))
  expect(
    screen.getByRole('status', { name: 'Loading chat history' }),
  ).toBeVisible()
  expect(header.getByRole('heading', { level: 1 })).toHaveTextContent(
    'Loading chat',
  )
  expect(composer).toHaveAttribute('aria-busy', 'true')
  await act(async () => history.resolve())
  expect(screen.getByRole('article', { name: 'You said' })).toHaveTextContent(
    'Saved question',
  )
})

// A run that streams the start of its reply, unless it stops before it
// replies, then ends once `end` settles: stopped, with the reply the harness
// committed as interrupted, or not.
function scriptStoppedRun(
  end: Promise<void>,
  { cancelled = true, started = Promise.resolve(), replied = true } = {},
) {
  client.events.mockImplementationOnce(async function* (
    _path: string,
    input: Turn,
  ): AsyncGenerator<Frame> {
    await started
    yield {
      id: 0,
      event: {
        type: 'RUN_STARTED',
        runId: 'reply',
        threadId: input.threadId!,
        instance: 'instance-1',
      },
    }
    if (replied)
      yield {
        id: 1,
        event: {
          type: 'TEXT_MESSAGE_CHUNK',
          messageId: 'answer',
          role: 'assistant',
          delta: 'The answer is',
        },
      }
    await end
    yield {
      id: 2,
      event: {
        type: 'RUN_FINISHED',
        runId: 'reply',
        threadId: input.threadId!,
        metadata: {
          cancelled,
          messages: replied ? [{ id: 'answer', isInterrupted: cancelled }] : [],
        },
      },
    }
  })
}

// Answers the chat list, and each stop with `stop`.
function answerStops(stop: (input: unknown) => unknown = () => ({})) {
  const stops: unknown[] = []
  client.post.mockImplementation(async (path, input) => {
    if (path === '/v1/threads/list') return { threads: [], nextCursor: null }
    if (path === '/v1/threads/cancel') {
      stops.push(input)
      return stop(input)
    }
    throw new Error(`Unexpected ${path}`)
  })
  return stops
}

const renderChat = () =>
  render(
    <ProjectProvider>
      <ChatInterface suppressIntroModals />
    </ProjectProvider>,
  )

it('stops a reply at once with Escape, and says the user canceled it, also once the chat is read again', async () => {
  signIn({ cloud: true })
  const stopped = gate()
  scriptStoppedRun(stopped.promise)
  const stops = answerStops()
  renderChat()
  await send()
  await screen.findByText('The answer is')
  // A dialog holding the focus keeps Escape for itself.
  const dialog = document.body.appendChild(document.createElement('div'))
  dialog.setAttribute('role', 'dialog')
  fireEvent.keyDown(dialog.appendChild(document.createElement('button')), {
    key: 'Escape',
  })
  dialog.remove()
  expect(stops).toEqual([])

  fireEvent.keyDown(document.body, { key: 'Escape' })

  expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument()
  expect(
    screen.queryByRole('button', { name: 'Stop generation' }),
  ).not.toBeInTheDocument()
  // It shows as stopped before the harness ends it.
  expect(screen.getByText('Response canceled by user')).toBeInTheDocument()
  const { threadId } = client.events.mock.calls[0][1] as Turn
  await waitFor(() =>
    expect(stops).toEqual([{ key: KEY, threadId, runId: 'reply' }]),
  )
  fireEvent.keyDown(document.body, { key: 'Escape' })
  await act(async () => stopped.resolve())
  expect(screen.getByText('Response canceled by user')).toBeInTheDocument()
  expect(stops).toHaveLength(1)
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()

  const { clientRequestId, threadId: id } = client.events.mock
    .calls[0][1] as Turn
  const stored = {
    ...storedThread(id!, {
      messages: [
        {
          id: clientRequestId,
          role: 'user',
          content: 'Explain this to me',
          createdAt: '2026-04-01T09:00:00Z',
        },
        {
          id: 'answer',
          role: 'assistant',
          content: 'The answer is',
          createdAt: '2026-04-01T09:00:01Z',
          isInterrupted: true,
        },
      ],
    }),
    hasOlder: false,
  }
  client.post.mockImplementation(async (path) => {
    if (path === '/v1/threads/list') return { threads: [], nextCursor: null }
    if (path === '/v1/threads/get') return stored
    throw new Error(`Unexpected ${path}`)
  })
  await act(async () => publish({ chatRevision: 'stopped' }))
  await waitFor(() =>
    expect(client.post).toHaveBeenCalledWith(
      '/v1/threads/get',
      expect.objectContaining({ id }),
      expect.anything(),
    ),
  )
  expect(screen.getByText('Response canceled by user')).toBeInTheDocument()
  expect(screen.queryByText('Response stopped')).not.toBeInTheDocument()
})

it('stops a reply that has not started, and says so under the message', async () => {
  signIn({ cloud: true })
  const accepted = gate()
  const stopped = gate()
  scriptStoppedRun(stopped.promise, {
    started: accepted.promise,
    replied: false,
  })
  const stops = answerStops(() => stopped.resolve())
  renderChat()
  await send()
  await waitFor(() => expect(client.events).toHaveBeenCalledTimes(1))

  fireEvent.click(screen.getByRole('button', { name: 'Stop generation' }))

  expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument()
  expect(
    screen.queryByRole('status', { name: 'Waiting for response' }),
  ).not.toBeInTheDocument()
  expect(screen.getByText('Response canceled by user')).toBeInTheDocument()
  expect(stops).toEqual([])
  await act(async () => accepted.resolve())
  expect(stops).toHaveLength(1)
  expect(screen.queryByText('The answer is')).not.toBeInTheDocument()
  expect(screen.getByText('Response canceled by user')).toBeInTheDocument()
})

it('shows no error for a stop that arrives after the reply ended', async () => {
  signIn({ cloud: true })
  const ended = gate()
  scriptStoppedRun(ended.promise, { cancelled: false })
  const stops = answerStops(() => {
    throw new HarnessError(
      {
        code: 'RUN_NOT_FOUND',
        message: 'The run is not live on this instance',
        action: 'reload',
      },
      404,
    )
  })
  renderChat()
  await send()
  await screen.findByText('The answer is')

  fireEvent.click(screen.getByRole('button', { name: 'Stop generation' }))
  await waitFor(() => expect(stops).toHaveLength(1))
  expect(screen.getByText('Response canceled by user')).toBeInTheDocument()
  await act(async () => ended.resolve())

  expect(screen.getByRole('article', { name: 'Al said' })).toHaveTextContent(
    'The answer is',
  )
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  expect(screen.queryByText(/^Response /)).not.toBeInTheDocument()
})

it('sends a message written while the reply stops once it has stopped, and keeps a second', async () => {
  signIn({ cloud: true })
  const stopped = gate()
  scriptStoppedRun(stopped.promise)
  scriptStoppedRun(Promise.resolve(), { cancelled: false })
  answerStops()
  renderChat()
  await send()
  await screen.findByText('The answer is')
  fireEvent.click(screen.getByRole('button', { name: 'Stop generation' }))

  const input = screen.getByRole('textbox', { name: /message/i })
  fireEvent.change(input, { target: { value: 'Something else' } })
  await act(async () =>
    fireEvent.click(screen.getByRole('button', { name: 'Send' })),
  )

  // The harness ends a turn queued behind a reply it stops.
  expect(client.events).toHaveBeenCalledTimes(1)
  // Another message stays in the composer until the first has gone.
  const cleared = screen.getByRole('textbox', { name: /message/i })
  expect(cleared).toHaveValue('')
  fireEvent.change(cleared, { target: { value: 'Another thing' } })
  await act(async () =>
    fireEvent.click(screen.getByRole('button', { name: 'Send' })),
  )
  expect(screen.getByRole('textbox', { name: /message/i })).toHaveValue(
    'Another thing',
  )
  await act(async () => stopped.resolve())
  await waitFor(() => expect(client.events).toHaveBeenCalledTimes(2))
  expect(client.events.mock.calls[1][1]).toMatchObject({
    kind: 'send',
    content: 'Something else',
  })
})

it('says a reply the service stopped stopped, without blaming the user', async () => {
  signIn({ cloud: true })
  scriptStoppedRun(Promise.resolve())
  answerStops()
  renderChat()

  await send()

  expect(await screen.findByText('Response stopped')).toBeInTheDocument()
  expect(
    screen.queryByText('Response canceled by user'),
  ).not.toBeInTheDocument()
})
