import { ChatInterface } from '@/components/chat/chat-interface'
import { ProjectProvider } from '@/components/project/project-provider'
import { USER_PREFS_LOCAL_PROFILE } from '@/constants/storage-keys'
import { publish } from '@/services/harness/runtime'
import { HarnessError } from '@/services/harness/sse'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { client, signIn, testSession } from '../../harness-fixture'
import { resetChatStoresAroundEachTest } from '../../services/harness/thread-fixture'
import { refuseFetch } from './chat-interface-fixture'
import { chatPage, errorHandling } from './chat-page-mocks'

// The Clerk account's metadata, which records onboarding completed on any
// device.
const account = vi.hoisted(() => ({
  unsafeMetadata: {} as Record<string, unknown>,
}))
// Whether the page last let the passkey hook start.
const passkeyStart = vi.hoisted(() => ({ initialized: undefined as unknown }))

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
vi.mock('@/hooks/use-passkey-backup', async () => {
  const { passkeyBackup } = await import('./chat-page-mocks')
  return {
    usePasskeyBackup: (options: { initialized: boolean }) => {
      passkeyStart.initialized = options.initialized
      return passkeyBackup.usePasskeyBackup()
    },
  }
})
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
  passkeyStart.initialized = undefined
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

it('starts passkey prompts only once onboarding is dismissed', async () => {
  signIn({ profile: {} })
  render(view())
  await screen.findByRole('heading', { name: 'Why Tinfoil Chat' })
  expect(passkeyStart.initialized).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  await screen.findByRole('heading', { name: 'Private, by Design.' })
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  await screen.findByRole('heading', { name: 'Tending the Garden' })
  expect(passkeyStart.initialized).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: 'Get Started' }))
  await act(async () => {})
  expect(passkeyStart.initialized).toBe(true)
  expect(
    JSON.parse(localStorage.getItem(USER_PREFS_LOCAL_PROFILE)!),
  ).toMatchObject({ hasSeenOnboarding: true })
})

it('waits for the cloud profile to decide onboarding before passkey prompts', async () => {
  const api = signIn({ cloud: true })
  let load!: (profile: object) => void
  client.post.mockImplementation(async (path: string) => {
    if (path === '/v1/session') return structuredClone(testSession)
    if (path === '/v1/profile/get')
      return new Promise((resolve) => {
        load = resolve
      })
    if (path === '/v1/threads/list') return { threads: [], nextCursor: null }
    if (path === '/v1/projects/list') return { projects: [], nextCursor: null }
    throw new Error(`Unexpected harness request: ${path}`)
  })
  // The page has opened and the account's profile has not loaded yet.
  publish({ profile: {}, keyReady: false, profileReady: false })
  const loading = api.refresh()
  render(view())
  await settle()
  expect(passkeyStart.initialized).toBe(false)
  await act(async () => {
    load({ hasSeenOnboarding: true })
    await loading
  })
  expect(passkeyStart.initialized).toBe(true)
  expect(
    screen.queryByRole('heading', { name: 'Why Tinfoil Chat' }),
  ).not.toBeInTheDocument()
})

it('starts passkey recovery for an account whose key is refused', async () => {
  account.unsafeMetadata = { has_completed_onboarding: true }
  const api = signIn({ cloud: true })
  client.post.mockImplementation(async (path: string) => {
    if (path === '/v1/session') return structuredClone(testSession)
    if (path === '/v1/profile/get')
      throw new HarnessError(
        { code: 'KEY_REQUIRED', message: 'A content key is required' },
        401,
      )
    if (path === '/v1/threads/list') return { threads: [], nextCursor: null }
    if (path === '/v1/projects/list') return { projects: [], nextCursor: null }
    throw new Error(`Unexpected harness request: ${path}`)
  })
  publish({ profile: {}, keyReady: false, profileReady: false })
  render(view())
  await settle()
  expect(passkeyStart.initialized).toBe(false)
  await act(() => api.refresh())
  expect(passkeyStart.initialized).toBe(true)
})

it('finishes onboarding quietly while the key is refused', async () => {
  signIn({ cloud: true, locked: true })
  errorHandling.logError.mockClear()
  render(view())
  await screen.findByRole('heading', { name: 'Why Tinfoil Chat' })
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  await screen.findByRole('heading', { name: 'Private, by Design.' })
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  await screen.findByRole('heading', { name: 'Tending the Garden' })

  fireEvent.click(screen.getByRole('button', { name: 'Get Started' }))

  await waitFor(() =>
    expect(errorHandling.logError).toHaveBeenCalledExactlyOnceWith(
      'Failed to save onboarding completion',
      expect.objectContaining({ code: 'KEY_REQUIRED' }),
      { component: 'ChatInterface', action: 'completeOnboarding' },
    ),
  )
  await waitFor(() =>
    expect(
      screen.queryByRole('heading', { name: 'Tending the Garden' }),
    ).not.toBeInTheDocument(),
  )
  expect(
    screen.queryByText('Your encryption key is locked'),
  ).not.toBeInTheDocument()
})
