import { ChatInterface } from '@/components/chat/chat-interface'
import { ProjectProvider } from '@/components/project/project-provider'
import { DB_NAME, DB_VERSION } from '@/services/storage/indexed-db'
import { fireEvent, render, screen } from '@testing-library/react'
import { IDBKeyRange as FakeIDBKeyRange, IDBFactory } from 'fake-indexeddb'
import { beforeEach, expect, it, vi } from 'vitest'
import { signIn } from '../../harness-fixture'
import { refuseFetch } from './chat-interface-fixture'
import { chatPage } from './chat-page-mocks'

vi.mock('@clerk/react', async () => (await import('./chat-page-mocks')).clerk)
vi.mock('next/router', async () => (await import('./chat-page-mocks')).router)
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

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  vi.stubGlobal('IDBKeyRange', FakeIDBKeyRange)
  vi.stubGlobal('innerWidth', 1440)
  vi.spyOn(window.location, 'reload').mockImplementation(() => {})
  chatPage.auth = { isLoaded: true, isSignedIn: true, userId: 'alice' }
  chatPage.router.pathname = '/'
  chatPage.router.query = {}
  chatPage.router.asPath = '/'
  refuseFetch()
})

function openDatabase(version: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, version)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve(request.result)
  })
}

// The page shares one database for the whole file, which a newer version
// leaves unusable, so one test follows it from waiting through to outdated.
it('asks to close other tabs while the chats wait to update, then to reload once a newer version updates them', async () => {
  // A tab of an earlier version that cannot answer, as one the browser froze.
  const earlierTab = await openDatabase(DB_VERSION - 1)
  earlierTab.onversionchange = () => undefined
  signIn()
  render(
    <ProjectProvider>
      <ChatInterface suppressIntroModals />
    </ProjectProvider>,
  )

  await screen.findByRole('heading', {
    name: 'Close your other Tinfoil Chat tabs',
  })
  expect(screen.queryByRole('button', { name: 'Temporary chat' })).toBeNull()

  earlierTab.close()

  await screen.findByRole('button', { name: 'Temporary chat' })
  expect(
    screen.queryByRole('heading', {
      name: 'Close your other Tinfoil Chat tabs',
    }),
  ).toBeNull()

  // A tab of a newer version opens only once this page lets go.
  const newerTab = await openDatabase(DB_VERSION + 1)
  newerTab.close()

  await screen.findByRole('heading', { name: 'Tinfoil Chat was updated' })
  expect(screen.queryByRole('button', { name: 'Temporary chat' })).toBeNull()
  expect(window.location.reload).not.toHaveBeenCalled()

  fireEvent.click(screen.getByRole('button', { name: 'Reload' }))

  expect(window.location.reload).toHaveBeenCalledOnce()
})
