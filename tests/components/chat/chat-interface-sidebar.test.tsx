import { ChatInterface } from '@/components/chat/chat-interface'
import { PLACEHOLDER_CHAT_TITLE } from '@/constants/chat'
import { UI_SIDEBAR_OPEN } from '@/constants/storage-keys'
import { localThreadStore } from '@/services/harness/local-threads'
import type {
  Frame,
  HarnessEvent,
  Thread,
  ThreadSummary,
  Turn,
} from '@/services/harness/types'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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
