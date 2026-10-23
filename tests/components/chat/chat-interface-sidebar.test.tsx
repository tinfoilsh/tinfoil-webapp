import { ChatInterface } from '@/components/chat/chat-interface'
import { PLACEHOLDER_CHAT_TITLE } from '@/constants/chat'
import { UI_SIDEBAR_OPEN } from '@/constants/storage-keys'
import { localThreadStore } from '@/services/harness/local-threads'
import { publish } from '@/services/harness/runtime'
import type {
  Frame,
  HarnessEvent,
  Thread,
  ThreadSummary,
  Turn,
} from '@/services/harness/types'
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { client, signIn } from '../../harness-fixture'
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
vi.mock('@/components/project/project-context', () => ({
  useProject: () => ({ activeProject: null, deleteProject: vi.fn() }),
}))
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

const DESKTOP_WIDTH = 1440

// A chat the harness stores, as its list and its window show it.
function cloudChat(
  id: string,
  title: string,
  activityAt: string,
  fields: Partial<Thread> = {},
): Thread {
  return {
    ...storedThread(id, {
      title,
      titleState: 'generated',
      createdAt: activityAt,
      updatedAt: activityAt,
      messages: [
        {
          id: `${id}-message`,
          role: 'user',
          createdAt: activityAt,
          content: `${title} conversation`,
        },
      ],
    }),
    activityAt,
    messageCount: 1,
    hasOlder: false,
    ...fields,
  }
}

const summaryOf = ({
  messages: _messages,
  hasOlder: _hasOlder,
  presetId: _presetId,
  ...summary
}: Thread): ThreadSummary => summary

beforeEach(() => {
  vi.stubGlobal('innerWidth', DESKTOP_WIDTH)
  sessionStorage.setItem(UI_SIDEBAR_OPEN, 'true')
  chatPage.premium = false
  chatPage.router.pathname = '/'
  chatPage.router.query = {}
  chatPage.router.push.mockReset().mockResolvedValue(true)
  chatPage.router.replace.mockReset().mockResolvedValue(true)
  refuseFetch()
})

// A chat's row in the sidebar, by the title it starts with.
const row = (title: string) =>
  screen.findByRole('link', { name: new RegExp(`^${title}`) })

// The runs the harness streams, frame by frame as the test emits them.
function scriptRuns() {
  const frames: HarnessEvent[] = []
  let wake: (() => void) | undefined
  let ended = false
  const turns: Turn[] = []
  client.events.mockImplementation(async function* (
    _path: string,
    input: Turn,
  ): AsyncGenerator<Frame> {
    turns.push(input)
    let id = 0
    for (;;) {
      while (frames.length) yield { id: id++, event: frames.shift()! }
      if (ended) return
      await new Promise<void>((resolve) => {
        wake = resolve
      })
    }
  })
  return {
    turns,
    emit(...events: HarnessEvent[]) {
      frames.push(...events)
      wake?.()
    },
    end() {
      ended = true
      wake?.()
    },
  }
}

async function send(text: string) {
  const input = await screen.findByRole('textbox', { name: /message/i })
  fireEvent.change(input, { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
}

it('lists a stored chat still waiting for its title as Untitled', async () => {
  signIn({ cloud: true })
  const waiting = cloudChat(
    'waiting-chat',
    PLACEHOLDER_CHAT_TITLE,
    '2026-10-22T12:00:00Z',
    { titleState: 'placeholder' },
  )
  client.post.mockImplementation(async (path) => {
    if (path === '/v1/threads/list')
      return { threads: [summaryOf(waiting)], nextCursor: null }
    throw new Error(`Unexpected request: ${path}`)
  })
  render(<ChatInterface suppressIntroModals />)
  expect(await row('Untitled')).toHaveAttribute('href', '/chat/waiting-chat')
  expect(
    screen.queryByRole('link', { name: /New Chat/ }),
  ).not.toBeInTheDocument()
})

it('lists a new chat on this device as Untitled once it is sent', async () => {
  signIn()
  const runs = scriptRuns()
  render(<ChatInterface suppressIntroModals />)
  await send('Explain this to me')
  await waitFor(() => expect(runs.turns).toHaveLength(1))
  const threadId = runs.turns[0].threadId!
  expect(await row('Untitled')).toHaveAttribute(
    'href',
    `/chat/local/${threadId}`,
  )
  expect(
    screen.queryByRole('link', { name: /New Chat/ }),
  ).not.toBeInTheDocument()
  expect((await localThreadStore('device').get(threadId))?.title).toBe(
    PLACEHOLDER_CHAT_TITLE,
  )
  runs.end()
})

it('lists a new stored chat while its first reply streams, then once', async () => {
  signIn({ cloud: true })
  const runs = scriptRuns()
  let listed: ThreadSummary[] = []
  client.post.mockImplementation(async (path) => {
    if (path === '/v1/threads/list')
      return { threads: listed, nextCursor: null }
    throw new Error(`Unexpected request: ${path}`)
  })
  render(<ChatInterface suppressIntroModals />)
  await send('Explain this to me')
  await waitFor(() => expect(runs.turns).toHaveLength(1))
  const threadId = runs.turns[0].threadId!
  const started = '2026-10-22T12:00:00Z'
  const created = summaryOf(
    cloudChat(threadId, PLACEHOLDER_CHAT_TITLE, started, {
      titleState: 'placeholder',
      activeRun: { runId: 'reply', expiresAt: '2026-10-22T12:10:00Z' },
    }),
  )
  runs.emit(
    { type: 'RUN_STARTED', threadId, runId: 'reply' },
    { type: 'STATE_SNAPSHOT', snapshot: { thread: created, queue: [] } },
    { type: 'TEXT_MESSAGE_CHUNK', messageId: 'answer', delta: 'Here it is.' },
  )
  await screen.findByText('Here it is.')
  const untitled = await row('Untitled')
  expect(untitled).toHaveAttribute('href', `/chat/${threadId}`)
  expect(untitled).toHaveAttribute('aria-current', 'page')
  expect(within(untitled).getByText('Generating response')).toBeInTheDocument()

  runs.emit({
    type: 'STATE_DELTA',
    threadId,
    delta: [
      { op: 'replace', path: '/thread/title', value: 'Explaining things' },
      { op: 'replace', path: '/thread/titleState', value: 'generated' },
    ],
  })
  // The title types itself over the placeholder.
  await waitFor(() =>
    expect(
      screen.getByRole('link', { current: 'page' }).textContent,
    ).not.toMatch(/^Untitled/),
  )
  expect(
    screen.queryByRole('link', { name: /^Explaining things/ }),
  ).not.toBeInTheDocument()
  const titled = await screen.findByRole(
    'link',
    { name: /^Explaining things/ },
    { timeout: 3000 },
  )

  const finished = {
    ...created,
    title: 'Explaining things',
    titleState: 'generated' as const,
    messageCount: 2,
    activeRun: null,
  }
  listed = [finished]
  runs.emit(
    { type: 'STATE_SNAPSHOT', snapshot: { thread: finished, queue: [] } },
    { type: 'RUN_FINISHED', threadId, runId: 'reply' },
  )
  await waitFor(() =>
    expect(
      within(titled).queryByText('Generating response'),
    ).not.toBeInTheDocument(),
  )
  await waitFor(() =>
    expect(
      client.post.mock.calls.filter(([path]) => path === '/v1/threads/list'),
    ).toHaveLength(2),
  )
  expect(screen.getAllByRole('link', { name: /^Explaining things/ })).toEqual([
    titled,
  ])
  runs.end()
})

it('keeps a stored chat marked running after moving to another chat', async () => {
  signIn({ cloud: true })
  const runs = scriptRuns()
  const older = cloudChat('older-chat', 'Older chat', '2026-10-20T12:00:00Z')
  const newer = cloudChat('newer-chat', 'Newer chat', '2026-10-22T12:00:00Z')
  let listed = [summaryOf(newer), summaryOf(older)]
  client.post.mockImplementation(async (path, input) => {
    if (path === '/v1/threads/list')
      return { threads: listed, nextCursor: null }
    if (path === '/v1/threads/get') {
      const { id } = input as { id: string }
      return structuredClone(id === older.id ? older : newer)
    }
    throw new Error(`Unexpected request: ${path}`)
  })
  render(<ChatInterface initialChatId={older.id} suppressIntroModals />)
  await screen.findByText('Older chat conversation')
  await send('More please')
  await waitFor(() => expect(runs.turns).toHaveLength(1))
  const running = {
    ...summaryOf(older),
    activityAt: '2026-10-22T13:00:00Z',
    messageCount: 2,
    activeRun: { runId: 'reply', expiresAt: '2026-10-22T13:10:00Z' },
  }
  runs.emit(
    { type: 'RUN_STARTED', threadId: older.id, runId: 'reply' },
    { type: 'STATE_SNAPSHOT', snapshot: { thread: running, queue: [] } },
  )
  const olderRow = await row('Older chat')
  await waitFor(() =>
    expect(within(olderRow).getByText('Generating response')).toBeVisible(),
  )

  fireEvent.click(await row('Newer chat'))
  await screen.findByText('Newer chat conversation')
  expect(
    within(await row('Older chat')).getByText('Generating response'),
  ).toBeInTheDocument()

  // The list reports the reply finished.
  listed = [{ ...running, activeRun: null }, summaryOf(newer)]
  await act(async () => publish({ chatRevision: 'reply-finished' }))
  await waitFor(() =>
    expect(
      within(screen.getByRole('link', { name: /^Older chat/ })).queryByText(
        'Generating response',
      ),
    ).not.toBeInTheDocument(),
  )
  runs.end()
})

// The chats the sidebar lists, top to bottom.
const listedOrder = () =>
  screen
    .getAllByRole('link')
    .map((link) => link.getAttribute('href'))
    .filter((href) => href?.startsWith('/chat/'))

it('moves a chat to the top of the list as soon as a message is sent', async () => {
  signIn({ cloud: true })
  const runs = scriptRuns()
  const older = cloudChat('older-chat', 'Older chat', '2026-10-20T12:00:00Z')
  const newer = cloudChat('newer-chat', 'Newer chat', '2026-10-22T12:00:00Z')
  client.post.mockImplementation(async (path) => {
    if (path === '/v1/threads/list')
      return { threads: [summaryOf(newer), summaryOf(older)], nextCursor: null }
    if (path === '/v1/threads/get') return structuredClone(older)
    throw new Error(`Unexpected request: ${path}`)
  })
  render(<ChatInterface initialChatId={older.id} suppressIntroModals />)
  await screen.findByText('Older chat conversation')
  expect(listedOrder()).toEqual(['/chat/newer-chat', '/chat/older-chat'])

  // The harness starts no reply, so the list cannot have reported one.
  await send('More please')
  expect(listedOrder()).toEqual(['/chat/older-chat', '/chat/newer-chat'])
  runs.end()
})
