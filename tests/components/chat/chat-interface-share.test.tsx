import { ChatInterface } from '@/components/chat/chat-interface'
import { ProjectProvider } from '@/components/project/project-provider'
import { localThreadStore } from '@/services/harness/local-threads'
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

let writeText: ReturnType<typeof vi.fn>
beforeEach(() => {
  // The verifier's frame is not loaded.
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
  chatPage.auth = { isLoaded: true, isSignedIn: false, userId: null }
  chatPage.premium = false
  chatPage.router.pathname = '/[...slug]'
  chatPage.router.query = {}
  refuseFetch()
  writeText = vi.fn(async () => {})
  vi.spyOn(navigator, 'clipboard', 'get').mockReturnValue({
    writeText,
  } as unknown as Clipboard)
})

it('lets a signed-out visitor copy a chat as markdown without creating a link', async () => {
  signIn({ userId: null })
  client.post.mockImplementation(async (path) => {
    if (path === '/v1/threads/list') return { threads: [], nextCursor: null }
    throw new Error(`Unexpected ${path}`)
  })
  const chat = storedThread('tab-chat', {
    title: 'Visitor chat',
    titleState: 'generated',
    messages: [
      {
        id: 'question',
        role: 'user',
        content: 'What is a prime?',
        createdAt: '2026-10-22T12:00:00Z',
      },
      {
        id: 'answer',
        role: 'assistant',
        content: 'A number with exactly two divisors.',
        createdAt: '2026-10-22T12:00:01Z',
      },
    ],
  })
  await localThreadStore('tab').add(chat)
  render(
    <ProjectProvider>
      <ChatInterface
        initialChatId={chat.id}
        isLocalChatUrl
        suppressIntroModals
      />
    </ProjectProvider>,
  )
  await screen.findByText('A number with exactly two divisors.')

  fireEvent.click(screen.getByRole('button', { name: 'Share' }))

  const dialog = await screen.findByRole('dialog', {
    name: 'Share Conversation',
  })
  expect(within(dialog).getByText('Share status unavailable')).toBeVisible()
  expect(
    within(dialog).getByRole('checkbox', {
      name: 'Make this conversation shareable with anyone who has the link',
    }),
  ).toBeDisabled()
  expect(
    within(dialog).queryByRole('button', { name: /share link/i }),
  ).toBeNull()
  const markdown =
    '## User\n\nWhat is a prime?\n\n---\n\n' +
    '## Assistant\n\nA number with exactly two divisors.\n\n---'
  expect(
    within(dialog).getByLabelText('Raw conversation markdown'),
  ).toHaveTextContent(markdown, { normalizeWhitespace: false })

  await act(async () =>
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Copy to Clipboard' }),
    ),
  )

  await waitFor(() =>
    expect(writeText).toHaveBeenCalledExactlyOnceWith(markdown),
  )
  expect(client.post.mock.calls.map(([path]) => path)).not.toContain(
    '/v1/threads/share/status',
  )
})
