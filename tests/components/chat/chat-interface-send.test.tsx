import { ChatInterface } from '@/components/chat/chat-interface'
import { ProjectProvider } from '@/components/project/project-provider'
import {
  UI_SIDEBAR_OPEN,
  UI_SIDEBAR_PROJECTS_EXPANDED,
} from '@/constants/storage-keys'
import ChatPage from '@/pages/[...slug]'
import HomePage from '@/pages/index'
import NewChatPage from '@/pages/newchat'
import { localThreadStore } from '@/services/harness/local-threads'
import { publish } from '@/services/harness/runtime'
import type { Frame, Turn } from '@/services/harness/types'
import { indexedDBStorage } from '@/services/storage/indexed-db'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
      event: { type: 'RUN_STARTED', runId: 'reply', threadId: input.threadId! },
    }
    await reply.promise
    yield {
      id: 1,
      event: {
        type: 'TEXT_MESSAGE_CHUNK',
        messageId: 'answer',
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
    chatPage.router.pathname = '/[...slug]'
    chatPage.router.query = { slug: ['chat', input.threadId!] }
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
  await act(async () => reading.resolve())
  await waitFor(() =>
    expect(
      screen.queryByRole('status', { name: 'Waiting for response' }),
    ).not.toBeInTheDocument(),
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
  chatPage.router.pathname = '/[...slug]'
  chatPage.router.query = { slug: ['project', project.id] }
  rerender(<ChatPage />)
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

it('shows the chat loading shell while the key is locked and until history arrives', async () => {
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
  expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
    'Loading chat',
  )
  expect(screen.getByRole('textbox', { name: /message/i })).toBeDisabled()
  vi.spyOn(api, 'key').mockReturnValue(KEY)
  await act(async () => publish({ keyReady: true }))
  expect(
    screen.getByRole('status', { name: 'Loading chat history' }),
  ).toBeVisible()
  await act(async () => history.resolve())
  expect(screen.getByRole('article', { name: 'You said' })).toHaveTextContent(
    'Saved question',
  )
})
