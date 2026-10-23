import { ChatInterface } from '@/components/chat/chat-interface'
import { ProjectProvider } from '@/components/project/project-provider'
import { publish } from '@/services/harness/runtime'
import { render, screen, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { client, signIn } from '../../harness-fixture'
import { resetChatStoresAroundEachTest } from '../../services/harness/thread-fixture'
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
// The lazy settings modal loads before the test, so opening it is not timed
// with loading its module.
beforeAll(async () => {
  await import('@/components/chat/settings-modal')
})
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
})
afterEach(() => {
  window.history.replaceState(null, '', '/')
})

it('opens a settings link while the encryption key is locked', async () => {
  signIn({ cloud: true, locked: true })
  publish({ profile: {}, profileReady: false })
  client.post.mockImplementation(async (path) => {
    if (path === '/v1/projects/list') return { projects: [], nextCursor: null }
    throw new Error(`Unexpected ${path}`)
  })
  window.history.replaceState(null, '', '/#settings/data')

  render(
    <ProjectProvider>
      <ChatInterface suppressIntroModals />
    </ProjectProvider>,
  )

  const dialog = await screen.findByRole('dialog', { name: 'Settings' })
  expect(
    within(dialog).getByRole('heading', { level: 3, name: 'Delete' }),
  ).toBeInTheDocument()
})
