import { ChatInterface } from '@/components/chat/chat-interface'
import { ProjectProvider } from '@/components/project/project-provider'
import { HIDDEN_PUBLISH_MS } from '@/services/harness/store'
import type {
  Frame,
  Message,
  StoredThread,
  Turn,
} from '@/services/harness/types'
import {
  HIDDEN_BEFORE_RELOAD_MS,
  RECHECK_MS,
  watchForNewerDeployment,
} from '@/services/reload-when-updated'
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import { client, signIn } from '../../harness-fixture'
import {
  resetChatStoresAroundEachTest,
  storedThread,
} from '../../services/harness/thread-fixture'
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

// The page makes no request outside the harness but the check of the
// deployment the site serves, a newer one than the page's.
let requests: ReturnType<typeof answerDeploymentOnly>

function answerDeploymentOnly() {
  const fetch = vi.fn(async (url: string) => {
    if (url === '/deployment.json')
      return { ok: true, json: async () => ({ id: 'dpl_new' }) } as Response
    throw new Error(`Unexpected request: ${url}`)
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}

beforeEach(() => {
  vi.stubGlobal('innerWidth', 1440)
  chatPage.auth = { isLoaded: true, isSignedIn: true, userId: 'alice' }
  chatPage.premium = false
  chatPage.router.pathname = '/'
  chatPage.router.query = {}
  chatPage.router.asPath = '/'
  chatPage.router.replace.mockReset().mockResolvedValue(true)
  chatPage.router.push.mockReset().mockResolvedValue(true)
  vi.spyOn(window.location, 'reload').mockImplementation(() => {})
  requests = answerDeploymentOnly()
})

afterEach(() => {
  vi.useRealTimers()
})

const view = () => (
  <ProjectProvider>
    <ChatInterface suppressIntroModals />
  </ProjectProvider>
)

const deploymentChecks = () =>
  requests.mock.calls.filter(([url]) => url === '/deployment.json').length

// The user leaves the page out of sight, which watches for the deployment
// the site serves from then on.
function leavePage() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  document.dispatchEvent(new Event('visibilitychange'))
  onTestFinished(watchForNewerDeployment('dpl_old'))
}

const pass = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
    await vi.advanceTimersByTimeAsync(0)
  })

// A device run that answers its turn, and finishes once `finishing` settles
// with the thread it made.
function scriptDeviceRun(finishing: Promise<void>) {
  client.events.mockImplementation(async function* (
    _path: string,
    input: Omit<Turn, 'thread'> & { thread?: StoredThread },
  ): AsyncGenerator<Frame> {
    const thread = {
      ...storedThread(input.threadId!, {
        lastRequestId: input.clientRequestId,
        messages: [
          ...(input.thread?.messages ?? []),
          {
            id: input.clientRequestId,
            role: 'user',
            createdAt: '2026-10-22T12:00:00Z',
            content: input.content ?? '',
          },
          {
            id: 'reply',
            role: 'assistant',
            createdAt: '2026-10-22T12:00:01Z',
            content: 'Noted',
            timeline: [{ id: 'b1', type: 'content', content: 'Noted' }],
          },
        ],
      }),
      recordVersion: 1,
    }
    yield {
      id: 0,
      event: {
        type: 'RUN_STARTED',
        threadId: input.threadId!,
        runId: 'run',
        instance: 'instance-1',
      },
    }
    yield {
      id: 1,
      event: {
        type: 'MESSAGES_SNAPSHOT',
        messages: thread.messages as Message[],
        hasOlder: false,
      },
    }
    await finishing
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
}

async function send(content: string) {
  const input = await screen.findByRole('textbox', { name: 'Message' })
  fireEvent.change(input, { target: { value: content } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
}

const shownReply = (text: string) =>
  waitFor(() =>
    within(screen.getByRole('log', { name: 'Conversation' })).getByText(text),
  )

const startNewChat = () =>
  fireEvent.click(
    within(screen.getByRole('banner')).getByRole('link', { name: 'New chat' }),
  )

it('waits to reload while a message is being written', async () => {
  signIn()
  render(view())
  const composer = await screen.findByRole('textbox', { name: 'Message' })
  fireEvent.change(composer, { target: { value: 'A message I have not sent' } })
  act(() => composer.blur())

  leavePage()
  await pass(HIDDEN_BEFORE_RELOAD_MS + RECHECK_MS)
  expect(deploymentChecks()).toBe(0)

  fireEvent.change(composer, { target: { value: '' } })
  await pass(RECHECK_MS)
  expect(deploymentChecks()).toBe(1)
  expect(window.location.reload).toHaveBeenCalledOnce()
})

it('waits to reload while a reply goes on in a chat the page left', async () => {
  signIn()
  let finish!: () => void
  scriptDeviceRun(
    new Promise<void>((resolve) => {
      finish = resolve
    }),
  )
  render(view())
  await send('Plan a trip')
  await shownReply('Noted')
  startNewChat()
  await waitFor(() =>
    expect(screen.queryByRole('log', { name: 'Conversation' })).toBeNull(),
  )
  // The sidebar shows the chat left behind still answering.
  expect(screen.getByText('Generating response')).toBeInTheDocument()

  leavePage()
  await pass(HIDDEN_BEFORE_RELOAD_MS + RECHECK_MS)
  expect(deploymentChecks()).toBe(0)

  await act(async () => finish())
  // A page out of sight takes its turns, and shows changes, on timers.
  while (screen.queryByText('Generating response'))
    await pass(HIDDEN_PUBLISH_MS)
  await pass(RECHECK_MS)
  expect(window.location.reload).toHaveBeenCalledOnce()
})

it('waits to reload while a temporary chat, which only the page keeps, holds messages', async () => {
  signIn()
  scriptDeviceRun(Promise.resolve())
  render(view())
  fireEvent.click(await screen.findByRole('button', { name: 'Temporary chat' }))
  await send('Off the record')
  await shownReply('Noted')
  await waitFor(() =>
    expect(
      screen.queryByRole('button', { name: 'Stop generation' }),
    ).toBeNull(),
  )

  leavePage()
  await pass(HIDDEN_BEFORE_RELOAD_MS + RECHECK_MS)
  expect(deploymentChecks()).toBe(0)

  startNewChat()
  await pass(RECHECK_MS)
  expect(window.location.reload).toHaveBeenCalledOnce()
})
