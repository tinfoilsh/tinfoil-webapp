import { ChatInterface } from '@/components/chat/chat-interface'
import { UI_SIDEBAR_OPEN } from '@/constants/storage-keys'
import { writeChatListCache } from '@/services/harness/chat-list-cache'
import { publish } from '@/services/harness/runtime'
import type { ThreadSummary } from '@/services/harness/types'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { client, signIn, testSession } from '../../harness-fixture'
import {
  resetChatStoresAroundEachTest,
  storedThread,
} from '../../services/harness/thread-fixture'
import { refuseFetch } from './chat-interface-fixture'
import { chatPage } from './chat-page-mocks'

vi.mock('@clerk/react', async () => (await import('./chat-page-mocks')).clerk)
vi.mock('next/router', async () => (await import('./chat-page-mocks')).router)
vi.mock('next/head', async () => (await import('./chat-page-mocks')).head)
// Lazy parts load as the page loads them; the cloud sync setup they open
// shows only that it opened.
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
vi.mock('@/components/modals/cloud-sync-setup-modal', () => ({
  CloudSyncSetupModal: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? <div role="dialog" aria-label="Cloud sync setup" /> : null,
}))
vi.mock('@/components/verification-sidebar', () => ({
  VerifierSidebar: () => null,
}))
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

beforeEach(() => {
  vi.stubGlobal('innerWidth', DESKTOP_WIDTH)
  sessionStorage.setItem(UI_SIDEBAR_OPEN, 'true')
  chatPage.premium = false
  chatPage.router.pathname = '/'
  chatPage.router.query = {}
  refuseFetch()
})

it('offers to unlock locked chats instead of loading them forever', async () => {
  signIn({ cloud: true, locked: true })
  render(<ChatInterface suppressIntroModals />)
  const unlock = await screen.findByRole('button', { name: 'Unlock' })
  expect(screen.getByText('Your chats are locked')).toBeInTheDocument()
  expect(
    screen.queryByRole('status', { name: 'Loading chats' }),
  ).not.toBeInTheDocument()
  expect(
    screen.queryByRole('dialog', { name: 'Cloud sync setup' }),
  ).not.toBeInTheDocument()
  fireEvent.click(unlock)
  expect(
    await screen.findByRole('dialog', { name: 'Cloud sync setup' }),
  ).toBeInTheDocument()
  expect(
    client.post.mock.calls.filter(([path]) => path === '/v1/threads/list'),
  ).toEqual([])
})

it('offers to unlock instead of listing cached chats the refused key cannot open', async () => {
  signIn({ cloud: true, locked: true })
  writeChatListCache('alice', null, {
    threads: [
      {
        ...storedThread('cached-chat', {
          title: 'Cached chat',
          titleState: 'generated',
        }),
        createdAt: '2026-04-01T09:00:00Z',
        updatedAt: '2026-04-01T09:00:00Z',
        activityAt: '2026-04-01T09:00:00Z',
        projectId: null,
        activeRun: null,
        contextUsage: null,
        messageCount: 2,
      },
    ],
    pinned: [],
  })
  render(<ChatInterface suppressIntroModals />)
  expect(
    await screen.findByRole('button', { name: 'Unlock' }),
  ).toBeInTheDocument()
  expect(screen.getByText('Your chats are locked')).toBeInTheDocument()
  expect(
    screen.queryByRole('link', { name: 'Cached chat' }),
  ).not.toBeInTheDocument()
})

it('leaves cached favorites out of the sidebar and search while the key is refused', async () => {
  signIn({ cloud: true, locked: true })
  const cached = {
    ...storedThread('cached-favorite', {
      title: 'Cached favorite',
      titleState: 'generated',
      pinned: true,
    }),
    createdAt: '2026-04-01T09:00:00Z',
    updatedAt: '2026-04-01T09:00:00Z',
    activityAt: '2026-04-01T09:00:00Z',
    projectId: null,
    activeRun: null,
    contextUsage: null,
    messageCount: 2,
  }
  writeChatListCache('alice', null, { threads: [cached], pinned: [cached] })
  render(<ChatInterface suppressIntroModals />)
  await screen.findByRole('button', { name: 'Unlock' })

  fireEvent.keyDown(window, { key: 'k', metaKey: true })
  await screen.findByRole('dialog')
  expect(screen.queryByText('Cached favorite')).not.toBeInTheDocument()
})

it('offers to load the chats again after the profile fails to load', async () => {
  signIn({ cloud: true })
  const chat: ThreadSummary = {
    ...storedThread('listed-chat', {
      title: 'Listed chat',
      titleState: 'generated',
    }),
    createdAt: '2026-04-01T09:00:00Z',
    updatedAt: '2026-04-01T09:00:00Z',
    activityAt: '2026-04-01T09:00:00Z',
    projectId: null,
    activeRun: null,
    contextUsage: null,
    messageCount: 2,
  }
  client.post.mockImplementation(async (path) => {
    if (path === '/v1/session') return structuredClone(testSession)
    if (path === '/v1/profile/get') return {}
    if (path === '/v1/threads/list')
      return { threads: [chat], nextCursor: null }
    throw new Error(`Unexpected request: ${path}`)
  })
  publish({
    profileReady: false,
    keyReady: false,
    error: 'Your settings could not be loaded.',
  })
  render(<ChatInterface suppressIntroModals />)
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Could not load chats.Your settings could not be loaded.',
  )
  expect(
    screen.queryByRole('status', { name: 'Loading chats' }),
  ).not.toBeInTheDocument()
  await act(async () =>
    fireEvent.click(screen.getByRole('button', { name: 'Try again' })),
  )
  expect(
    await screen.findByRole('link', { name: /^Listed chat/ }),
  ).toHaveAttribute('href', '/chat/listed-chat')
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  expect(client.post.mock.calls.map(([path]) => path)).toEqual([
    '/v1/session',
    '/v1/profile/get',
    '/v1/threads/list',
  ])
})
