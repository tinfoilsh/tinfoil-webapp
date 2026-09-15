import { ChatInterface } from '@/components/chat/chat-interface'
import { ProjectProvider } from '@/components/project/project-provider'
import { PAGINATION } from '@/config'
import { USER_ENCRYPTION_KEY } from '@/constants/storage-keys'
import { PROJECTS_CHANGED } from '@/hooks/use-projects'
import { encryptionService } from '@/services/encryption/encryption-service'
import { harnessAPI, publish } from '@/services/harness/runtime'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { testSession } from '../../harness-fixture'

const { backup, router } = vi.hoisted(() => ({
  backup: {
    passkeyRecoveryNeeded: false,
    manualRecoveryNeeded: false,
    passkeyFirstTimePromptAvailable: false,
  },
  router: { replace: vi.fn(), push: vi.fn(), query: {}, isReady: true },
}))

vi.mock('next/router', () => ({ useRouter: () => router }))
vi.mock('next/head', () => ({ default: () => null }))
vi.mock('framer-motion', () => import('../../mocks/motion'))
vi.mock('next/dynamic', async () => {
  const { lazy, Suspense, createElement } = await import('react')
  return {
    default: (load: () => Promise<any>) => {
      const Component = lazy(async () => ({ default: await load() }))
      return (props: any) =>
        createElement(
          Suspense,
          { fallback: null },
          createElement(Component, props),
        )
    },
  }
})
vi.mock('@clerk/nextjs', () => ({
  useAuth: () => ({ isLoaded: true, isSignedIn: true, userId: 'key-user' }),
  useUser: () => ({ isLoaded: true, user: { id: 'key-user' } }),
}))
vi.mock('@/hooks/use-passkey-backup', () => ({
  usePasskeyBackup: () => backup,
}))
vi.mock('@/hooks/use-subscription-status', () => ({
  useSubscriptionStatus: () => ({
    isLoading: false,
    chat_subscription_active: true,
  }),
}))
vi.mock('@/components/modals/cloud-sync-setup-modal', () => ({
  CloudSyncSetupModal: ({
    passkeyRecoveryNeeded,
    manualRecoveryNeeded,
  }: any) => (
    <div role="dialog" aria-label="Backups and sync">
      {passkeyRecoveryNeeded
        ? 'Recover with passkey'
        : manualRecoveryNeeded
          ? 'Restore key'
          : 'Create key'}
    </div>
  ),
}))
vi.mock('@/components/chat/chat-input', () => ({ ChatInput: () => null }))
vi.mock('@/components/chat/chat-messages', () => ({ ChatMessages: () => null }))
vi.mock('@/components/chat/model-selector', () => ({
  ModelSelector: () => null,
}))
vi.mock('@/components/chat/renderers/client', () => ({
  initializeRenderers: () => {},
}))
vi.mock('@/components/chat/genui/registry', () => ({ GENUI_WIDGETS: [] }))
vi.mock('@/components/chat/genui/GenUIInputAreaRenderer', () => ({
  GenUIInputAreaRenderer: () => null,
}))

beforeEach(() => {
  sessionStorage.clear()
  Object.assign(backup, {
    passkeyRecoveryNeeded: false,
    manualRecoveryNeeded: false,
    passkeyFirstTimePromptAvailable: false,
  })
  router.replace.mockResolvedValue(true)
  router.push.mockResolvedValue(true)
  Object.assign(harnessAPI().client, {
    ready: vi.fn().mockResolvedValue(undefined),
  })
  publish({
    session: undefined,
    keyReady: false,
    profile: { hasSeenOnboarding: true },
  })
})
afterEach(() => vi.restoreAllMocks())

const app = (
  <ProjectProvider>
    <ChatInterface />
  </ProjectProvider>
)

it('keeps a saved key through session and profile loading without opening setup', async () => {
  const key = await encryptionService.generateKey()
  localStorage.setItem(USER_ENCRYPTION_KEY, key)
  const view = render(app)
  await act(async () => publish({ session: testSession }))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  await act(async () => publish({ keyReady: true }))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(localStorage.getItem(USER_ENCRYPTION_KEY)).toBe(key)

  view.unmount()
  act(() => publish({ session: undefined, keyReady: false }))
  render(app)
  await act(async () => publish({ session: testSession }))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})

it('does not turn a profile request failure into a create-key prompt', async () => {
  localStorage.setItem(
    USER_ENCRYPTION_KEY,
    await encryptionService.generateKey(),
  )
  render(app)
  await act(async () =>
    publish({ session: testSession, error: 'Service unavailable' }),
  )
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})

it('loads projects once and refreshes them on changes without reloading when opening the sidebar', async () => {
  const api = harnessAPI()
  Object.defineProperty(api, 'userId', { value: 'key-user' })
  vi.spyOn(api, 'key').mockReturnValue('test-key')
  let projects: { id: string; name: string; updatedAt: string }[] = []
  const post = vi.mocked(api.client.post).mockImplementation(async (path) => {
    if (path === '/v1/projects/list') return { projects, nextCursor: null }
    if (path === '/v1/threads/list') return { threads: [], nextCursor: null }
    throw new Error(`Unexpected request: ${path}`)
  })
  const listRequests = () =>
    post.mock.calls.filter(([path]) => path === '/v1/projects/list')
  render(app)
  await act(async () => publish({ session: testSession, keyReady: true }))
  await waitFor(() => expect(listRequests()).toHaveLength(1))

  fireEvent.click(screen.getByRole('button', { name: 'Expand sidebar' }))
  fireEvent.click(
    screen.getByRole('button', { name: 'Projects', expanded: false }),
  )
  await act(async () => {})
  expect(listRequests()).toHaveLength(1)

  projects = [
    {
      id: 'project-1',
      name: 'New project',
      updatedAt: new Date().toISOString(),
    },
  ]
  await act(async () => window.dispatchEvent(new Event(PROJECTS_CHANGED)))
  expect(listRequests()).toHaveLength(2)
  expect(await screen.findByText('New project')).toBeInTheDocument()
})

it('keeps revealed history entries and scroll position when clicking into a chat page', async () => {
  const api = harnessAPI()
  Object.defineProperty(api, 'userId', { value: 'key-user' })
  vi.spyOn(api, 'key').mockReturnValue('test-key')
  const threads = Array.from(
    { length: PAGINATION.CHATS_PER_PAGE + 1 },
    (_, index) => ({
      id: `history-${index}`,
      title: `Chat ${index}`,
      titleState: 'manual',
      pinned: false,
      model: 'test-model',
      projectId: null,
      messageCount: 2,
      activeRun: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      webSearchEnabled: true,
    }),
  )
  const post = vi
    .mocked(api.client.post)
    .mockImplementation(async (path, input) => {
      if (path === '/v1/projects/list')
        return { projects: [], nextCursor: null }
      if (path === '/v1/threads/list') return { threads, nextCursor: null }
      if (path === '/v1/threads/get')
        return {
          ...threads.find(
            (thread) => thread.id === (input as { id: string }).id,
          ),
          messages: [],
          hasOlder: false,
        }
      throw new Error(`Unexpected request: ${path}`)
    })
  act(() => publish({ session: testSession, keyReady: true }))
  const view = render(app)
  fireEvent.click(screen.getByRole('button', { name: 'Expand sidebar' }))
  fireEvent.click(
    await screen.findByRole('button', { name: 'Load more chats' }),
  )
  const href = `/chat/history-${PAGINATION.CHATS_PER_PAGE}`
  const selected = document.querySelector<HTMLAnchorElement>(
    `a[href="${href}"]`,
  )!
  expect(selected).toBeInTheDocument()
  const scrolling = selected
    .closest('nav')!
    .querySelector<HTMLElement>('.overflow-y-auto')!
  scrolling.scrollTop = 250
  fireEvent.scroll(scrolling)
  fireEvent.click(selected)
  expect(router.push).toHaveBeenCalledWith(href, undefined, { shallow: true })
  expect(
    post.mock.calls.filter(([path]) => path === '/v1/threads/get'),
  ).toHaveLength(0)
  view.unmount()
  render(
    <ProjectProvider>
      <ChatInterface initialChatId={`history-${PAGINATION.CHATS_PER_PAGE}`} />
    </ProjectProvider>,
  )
  const retained = document.querySelector<HTMLAnchorElement>(
    `a[href="${href}"]`,
  )!
  expect(retained).toBeInTheDocument()
  expect(
    retained.closest('nav')!.querySelector('.overflow-y-auto')!.scrollTop,
  ).toBe(250)
  await waitFor(() =>
    expect(
      post.mock.calls.filter(([path]) => path === '/v1/threads/get'),
    ).toHaveLength(1),
  )
  expect(
    post.mock.calls.filter(([path]) => path === '/v1/threads/list'),
  ).toHaveLength(1)
  expect(
    post.mock.calls.filter(([path]) => path === '/v1/projects/list'),
  ).toHaveLength(1)
})

it.each([
  ['passkeyRecoveryNeeded', 'Recover with passkey'],
  ['manualRecoveryNeeded', 'Restore key'],
  ['passkeyFirstTimePromptAvailable', 'Create key'],
] as const)(
  'waits for the backup check before showing %s',
  async (flag, text) => {
    render(app)
    await act(async () => publish({ session: testSession }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    backup[flag] = true
    await act(async () => publish({}))
    expect(await screen.findByRole('dialog')).toHaveTextContent(text)
  },
)
