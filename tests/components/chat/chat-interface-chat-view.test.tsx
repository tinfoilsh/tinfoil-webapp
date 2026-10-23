import { ChatInterface } from '@/components/chat/chat-interface'
import { ProjectProvider } from '@/components/project/project-provider'
import { localThreadStore } from '@/services/harness/local-threads'
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
import { beforeEach, expect, it, vi } from 'vitest'
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
    yield {
      id: 2,
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
