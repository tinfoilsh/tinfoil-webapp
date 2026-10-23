import { ChatInterface } from '@/components/chat/chat-interface'
import { ProjectProvider } from '@/components/project/project-provider'
import { act, render, screen } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { signIn } from '../../harness-fixture'
import { resetChatStoresAroundEachTest } from '../../services/harness/thread-fixture'
import { refuseFetch } from './chat-interface-fixture'
import { chatPage } from './chat-page-mocks'

// The Clerk account's metadata, which records onboarding completed on any
// device.
const account = vi.hoisted(() => ({
  unsafeMetadata: {} as Record<string, unknown>,
}))

vi.mock('@clerk/react', async () => {
  const { chatPage } = await import('./chat-page-mocks')
  return {
    useAuth: () => ({
      ...chatPage.auth,
      getToken: async () => (chatPage.auth.userId ? 'clerk-jwt' : null),
    }),
    useUser: () => ({
      user: chatPage.auth.userId
        ? {
            id: chatPage.auth.userId,
            firstName: 'Ada',
            unsafeMetadata: account.unsafeMetadata,
            update: vi.fn(async () => {}),
          }
        : null,
    }),
    useReverification: (callback: unknown) => callback,
  }
})
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
beforeEach(async () => {
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
  account.unsafeMetadata = {}
  refuseFetch()
  // The onboarding chunk is loaded, so it shows as soon as the page asks.
  await import('@/components/onboarding/onboarding-view')
})

function view() {
  return (
    <ProjectProvider>
      <ChatInterface />
    </ProjectProvider>
  )
}

// Lets the page settle: its effects, and a lazily shown onboarding.
async function settle() {
  await screen.findByRole('textbox', { name: 'Message' })
  for (let i = 0; i < 3; i++)
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)))
}

it.each([
  ['shows onboarding to an account that has not seen it', {}, true],
  [
    'skips onboarding the account completed on another device',
    { has_completed_onboarding: true },
    false,
  ],
])('%s', async (_, metadata, shown) => {
  account.unsafeMetadata = metadata
  signIn({ profile: {} })
  render(view())
  await settle()
  expect(
    screen.queryByRole('heading', { name: 'Why Tinfoil Chat' }) !== null,
  ).toBe(shown)
})
