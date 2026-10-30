import { ChatInterface } from '@/components/chat/chat-interface'
import { ProjectProvider } from '@/components/project/project-provider'
import { UI_SIDEBAR_OPEN } from '@/constants/storage-keys'
import { publish } from '@/services/harness/runtime'
import { HarnessError } from '@/services/harness/sse'
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { client, signIn, testSession } from '../../harness-fixture'
import {
  resetChatStoresAroundEachTest,
  storedThread,
} from '../../services/harness/thread-fixture'
import { refuseFetch } from './chat-interface-fixture'
import { chatPage } from './chat-page-mocks'

vi.mock('@clerk/react', async () => ({
  ...(await import('./chat-page-mocks')).clerk,
  useReverification: (callback: unknown) => callback,
}))
vi.mock('next/router', async () => (await import('./chat-page-mocks')).router)
vi.mock('next/head', async () => (await import('./chat-page-mocks')).head)
vi.mock('next/dynamic', async () => {
  const { lazy, Suspense } = await import('react')
  return {
    default: (
      load: () => Promise<React.ComponentType<Record<string, unknown>>>,
    ) => {
      const Component = lazy(async () => ({ default: await load() }))
      return function Loaded(props: Record<string, unknown>) {
        return (
          <Suspense fallback={null}>
            <Component {...props} />
          </Suspense>
        )
      }
    },
  }
})
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
vi.mock('@/hooks/use-upgrade-to-pro', () => ({
  useUpgradeToPro: () => ({ startUpgrade: vi.fn() }),
}))
vi.mock(
  '@/utils/error-handling',
  async () => (await import('./chat-page-mocks')).errorHandling,
)

resetChatStoresAroundEachTest()
beforeEach(() => {
  const setAttribute = HTMLIFrameElement.prototype.setAttribute
  vi.spyOn(HTMLIFrameElement.prototype, 'setAttribute').mockImplementation(
    function (this: HTMLIFrameElement, name, value) {
      if (name !== 'src') setAttribute.call(this, name, value)
    },
  )
  vi.spyOn(HTMLIFrameElement.prototype, 'contentWindow', 'get').mockReturnValue(
    null,
  )
  vi.stubGlobal('innerWidth', 1440)
  chatPage.premium = false
  chatPage.router.pathname = '/'
  chatPage.router.query = {}
  refuseFetch()
  signIn()
})

function view(initialChatId?: string) {
  return (
    <ProjectProvider>
      <ChatInterface initialChatId={initialChatId} suppressIntroModals />
    </ProjectProvider>
  )
}

it('waits for profile loading and offers retry for a connection failure instead of asking for a key', async () => {
  const api = signIn({ cloud: true })
  publish({ profileReady: false, keyReady: false })
  let reject!: (error: Error) => void
  const pending = new Promise<unknown>((_, fail) => {
    reject = fail
  })
  let profiles = 0
  client.post.mockImplementation(async (path) => {
    if (path === '/v1/session') return testSession
    if (path === '/v1/profile/get')
      return ++profiles === 1 ? pending : { hasSeenOnboarding: true }
    if (path === '/v1/projects/list') return { projects: [], nextCursor: null }
    if (path === '/v1/threads/list') return { threads: [], nextCursor: null }
    if (path === '/v1/threads/get')
      return {
        ...storedThread('saved', {
          messages: [
            {
              id: 'message',
              role: 'user',
              content: 'Recovered history',
              createdAt: '2026-10-22T12:00:00Z',
            },
          ],
        }),
        hasOlder: false,
        messageCount: 1,
      }
    throw new Error(`Unexpected ${path}`)
  })
  const refreshing = api.refresh()
  render(view('saved'))
  await screen.findByRole('status', { name: 'Loading chat history' })
  expect(
    screen.queryByRole('heading', { name: 'Unlock chat history' }),
  ).not.toBeInTheDocument()
  await act(async () => {
    reject(new TypeError('Profile connection failed'))
    await refreshing
  })
  expect(
    await screen.findByRole('heading', { name: "Couldn't load chat" }),
  ).toBeInTheDocument()
  expect(
    screen.queryByRole('heading', { name: 'Unlock chat history' }),
  ).not.toBeInTheDocument()
  expect(
    within(screen.getByRole('banner')).queryByRole('heading', { level: 1 }),
  ).not.toBeInTheDocument()
  expect(document.querySelector('[data-chat-input-area]')).not.toHaveAttribute(
    'aria-busy',
  )
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
  expect(await screen.findByText('Recovered history')).toBeInTheDocument()
  expect(profiles).toBe(2)
})

it('offers key recovery after the profile request actually refuses the key', async () => {
  const api = signIn({ cloud: true })
  publish({ profileReady: false, keyReady: false })
  client.post.mockImplementation(async (path) => {
    if (path === '/v1/profile/get')
      throw new HarnessError(
        {
          code: 'KEY_MISMATCH',
          message: 'Another key is required',
          action: 'unlock',
        },
        409,
      )
    throw new Error(`Unexpected ${path}`)
  })
  render(view('locked-chat'))
  await act(() => api.refreshProfile())
  expect(
    await screen.findByRole('heading', { name: 'Unlock chat history' }),
  ).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Unlock' })).toBeEnabled()
})

it.each(['pointer', 'focus', 'escape'])(
  'dismisses the model picker by %s',
  async (method) => {
    render(view())
    const trigger = await screen.findByRole('button', { name: /Current model/ })
    fireEvent.click(trigger)
    expect(
      screen.getByRole('menu', { name: 'Select a model' }),
    ).toBeInTheDocument()
    if (method === 'pointer')
      fireEvent.mouseDown(screen.getByRole('textbox', { name: 'Message' }))
    else if (method === 'focus')
      fireEvent.focusIn(screen.getByRole('textbox', { name: 'Message' }))
    else fireEvent.keyDown(document, { key: 'Escape' })
    expect(
      screen.queryByRole('menu', { name: 'Select a model' }),
    ).not.toBeInTheDocument()
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
  },
)

it('keeps Auto open so its intelligence can be selected immediately', async () => {
  render(view())
  fireEvent.click(await screen.findByRole('button', { name: /Current model/ }))
  fireEvent.click(screen.getByRole('menuitemradio', { name: 'Auto' }))
  expect(
    screen.getByRole('slider', { name: 'Auto intelligence' }),
  ).toBeInTheDocument()
})

it('honors the Settings shortcut tab', async () => {
  sessionStorage.setItem(UI_SIDEBAR_OPEN, 'true')
  render(view())
  fireEvent.click(await screen.findByRole('button', { name: 'Ada' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: /^Settings/ }))
  await screen.findByRole('dialog', { name: 'Settings' })
  expect(
    await screen.findByRole('checkbox', { name: 'Redact sidebar chat titles' }),
  ).toBeInTheDocument()
})

it('closes the verifier when opening Settings', async () => {
  render(view())
  fireEvent.click(
    await screen.findByRole('button', { name: 'Open verification panel' }),
  )
  const panel = (await screen.findByTitle('Tinfoil Verification Center'))
    .parentElement!
  expect(panel).not.toHaveAttribute('inert')
  fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
  await screen.findByRole('dialog', { name: 'Settings' })
  expect(panel).toHaveAttribute('inert')
})

it('keeps one sidebar accessible after narrowing the viewport', async () => {
  sessionStorage.setItem(UI_SIDEBAR_OPEN, 'true')
  render(view())
  fireEvent.click(
    await screen.findByRole('button', { name: 'Open verification panel' }),
  )
  const panel = (await screen.findByTitle('Tinfoil Verification Center'))
    .parentElement!
  expect(panel).not.toHaveAttribute('inert')
  act(() => {
    vi.stubGlobal('innerWidth', 900)
    window.dispatchEvent(new Event('resize'))
  })
  await waitFor(() => expect(panel).toHaveAttribute('inert'))
})

it.each(['missing', 'connection', 'key'])(
  'shows an actionable history screen after a %s failure',
  async (failure) => {
    signIn({ cloud: true })
    const saved = {
      ...storedThread('saved-chat', {
        messages: [
          {
            id: 'question',
            role: 'user' as const,
            content: 'A saved question',
            createdAt: '2026-10-22T12:00:00Z',
          },
        ],
      }),
      messageCount: 1,
      hasOlder: false,
    }
    let attempts = 0
    client.post.mockImplementation(async (path) => {
      if (path === '/v1/threads/list') return { threads: [], nextCursor: null }
      if (path === '/v1/threads/get') {
        if (++attempts > 1) return saved
        if (failure === 'connection') throw new TypeError('Network unavailable')
        throw new HarnessError(
          {
            code: failure === 'key' ? 'KEY_MISMATCH' : 'THREAD_NOT_FOUND',
            message: 'Chat unavailable',
            action: failure === 'key' ? 'unlock' : 'stop',
          },
          failure === 'key' ? 409 : 404,
        )
      }
      throw new Error(`Unexpected ${path}`)
    })
    render(view(saved.id))
    const title =
      failure === 'key'
        ? 'Unable to decrypt chat'
        : failure === 'missing'
          ? 'Chat not found'
          : "Couldn't load chat"
    await screen.findByRole('heading', { name: title })
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeDisabled()
    if (failure === 'connection') {
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
      expect(await screen.findByText('A saved question')).toBeInTheDocument()
      expect(screen.getByRole('textbox', { name: 'Message' })).toBeEnabled()
      expect(
        client.post.mock.calls
          .filter(([path]) => path === '/v1/threads/get')
          .map(([, input]) => input),
      ).toEqual([
        { id: saved.id, key: expect.any(String) },
        { id: saved.id, key: expect.any(String) },
      ])
    } else
      expect(
        screen.getByRole('button', {
          name: failure === 'key' ? 'Unlock' : 'Start new chat',
        }),
      ).toBeEnabled()
  },
)

it('keeps the source list available from a completed answer', async () => {
  signIn({ cloud: true })
  const sources = [
    { url: 'https://example.com/first', title: 'First source' },
    { url: 'https://example.org/second', title: 'Second source' },
  ]
  client.post.mockImplementation(async (path) => {
    if (path === '/v1/threads/list') return { threads: [], nextCursor: null }
    if (path === '/v1/threads/get')
      return {
        ...storedThread('sources', {
          messages: [
            {
              id: 'answer',
              role: 'assistant',
              createdAt: '2026-10-22T12:00:00Z',
              content: 'An answer with sources.',
              timeline: [
                {
                  id: 'search',
                  type: 'tool_call',
                  name: 'web_search',
                  arguments: '{}',
                  complete: true,
                  display: { status: 'completed', sources },
                },
                {
                  id: 'text',
                  type: 'content',
                  content: 'An answer with sources.',
                },
              ],
              annotations: [
                {
                  type: 'url_citation',
                  url_citation: {
                    ...sources[0],
                    start_index: 0,
                    end_index: 23,
                  },
                },
              ],
            },
          ],
        }),
        messageCount: 1,
        hasOlder: false,
      }
    throw new Error(`Unexpected ${path}`)
  })
  render(view('sources'))
  fireEvent.click(await screen.findByRole('button', { name: 'Show 2 sources' }))
  const dialog = screen.getByRole('dialog', { name: 'Sources' })
  expect(
    within(dialog)
      .getAllByRole('link')
      .map((link) => link.getAttribute('href')),
  ).toEqual(sources.map((source) => source.url))
})

it('falls back to an available model when a saved chat names a retired one', async () => {
  signIn({ cloud: true })
  client.post.mockImplementation(async (path) => {
    if (path === '/v1/threads/list') return { threads: [], nextCursor: null }
    if (path === '/v1/threads/get')
      return {
        ...storedThread('retired-model-chat', {
          model: 'retired-model',
          messages: [
            {
              id: 'saved',
              role: 'user',
              content: 'Model fallback conversation',
              createdAt: '2026-10-22T12:00:00Z',
            },
          ],
        }),
        messageCount: 1,
        hasOlder: false,
      }
    throw new Error(`Unexpected ${path}`)
  })
  render(view('retired-model-chat'))
  await screen.findByText('Model fallback conversation')
  const trigger = screen.getAllByRole('button', {
    name: 'Current model Test model',
  })[0]
  fireEvent.click(trigger)
  expect(
    within(
      screen.getAllByRole('menu', { name: 'Select a model' })[0],
    ).getByRole('menuitemradio', { name: 'Test model' }),
  ).toHaveAttribute('aria-checked', 'true')
})

it('shows cloud-list loading and keeps cached rows visible through a retryable refresh failure', async () => {
  signIn({ cloud: true })
  sessionStorage.setItem(UI_SIDEBAR_OPEN, 'true')
  let resolve!: () => void
  const pending = new Promise<void>((done) => {
    resolve = done
  })
  const first = {
    ...storedThread('first-row', { title: 'First listed chat' }),
    messageCount: 2,
  }
  const second = { ...first, id: 'second-row', title: 'Second listed chat' }
  let attempts = 0
  client.post.mockImplementation(async (path) => {
    if (path === '/v1/projects/list') return { projects: [], nextCursor: null }
    if (path === '/v1/threads/list') {
      if (++attempts === 2) throw new Error('Chats unavailable')
      await pending
      return {
        threads: attempts === 1 ? [first] : [first, second],
        nextCursor: null,
      }
    }
    throw new Error(`Unexpected ${path}`)
  })
  render(view())
  expect(
    await screen.findByRole('status', { name: 'Loading chats' }),
  ).toBeInTheDocument()
  await act(async () => resolve())
  await screen.findByRole('link', { name: first.title })
  await act(async () => publish({ chatRevision: 'changed' }))
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Chats unavailable',
  )
  expect(screen.getByRole('link', { name: first.title })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
  expect(
    await screen.findByRole('link', { name: second.title }),
  ).toBeInTheDocument()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  expect(attempts).toBe(3)
})
