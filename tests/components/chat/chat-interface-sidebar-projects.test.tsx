import { ChatInterface } from '@/components/chat/chat-interface'
import { ProjectProvider } from '@/components/project/project-provider'
import {
  UI_SIDEBAR_OPEN,
  UI_SIDEBAR_PROJECTS_EXPANDED,
} from '@/constants/storage-keys'
import type { ThreadSummary } from '@/services/harness/types'
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { client, KEY, signIn } from '../../harness-fixture'
import {
  resetChatStoresAroundEachTest,
  storedThread,
} from '../../services/harness/thread-fixture'
import { refuseFetch } from './chat-interface-fixture'
import { chatPage } from './chat-page-mocks'

vi.mock('@clerk/react', async () => (await import('./chat-page-mocks')).clerk)
vi.mock('next/router', async () => (await import('./chat-page-mocks')).router)
vi.mock('next/head', async () => (await import('./chat-page-mocks')).head)
// Lazy parts load as the page loads them.
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
vi.mock('@/components/verification-sidebar', () => ({
  VerifierSidebar: () => null,
}))
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

const DESKTOP_WIDTH = 1440
const project = {
  id: 'project-one',
  name: 'Research',
  description: '',
  systemInstructions: '',
  createdAt: '2026-10-22T12:00:00Z',
  updatedAt: '2026-10-22T12:00:00Z',
  documents: [],
}

// A stored chat of the project, as its list and its window show it.
function projectChat(id: string, title: string) {
  const at = '2026-10-22T12:00:00Z'
  return {
    ...storedThread(id, {
      title,
      titleState: 'generated',
      projectId: project.id,
      createdAt: at,
      updatedAt: at,
      messages: [
        {
          id: `${id}-message`,
          role: 'user',
          createdAt: at,
          content: `${title} conversation`,
        },
      ],
    }),
    activityAt: at,
    messageCount: 1,
    hasOlder: false,
  }
}

const summaryOf = ({
  messages: _messages,
  hasOlder: _hasOlder,
  presetId: _presetId,
  ...summary
}: ReturnType<typeof projectChat>): ThreadSummary => summary

beforeEach(() => {
  vi.stubGlobal('innerWidth', DESKTOP_WIDTH)
  sessionStorage.setItem(UI_SIDEBAR_OPEN, 'true')
  sessionStorage.setItem(UI_SIDEBAR_PROJECTS_EXPANDED, 'true')
  chatPage.premium = true
  chatPage.router.pathname = '/[...slug]'
  chatPage.router.query = {}
  chatPage.router.push.mockReset().mockResolvedValue(true)
  chatPage.router.replace.mockReset().mockResolvedValue(true)
  refuseFetch()
  signIn({ cloud: true })
})

it("leaves a deleted open project chat for the project's new chat", async () => {
  const opened = projectChat('opened-chat', 'Opened discussion')
  const other = projectChat('other-chat', 'Other discussion')
  client.post.mockImplementation(async (path, input) => {
    if (path === '/v1/projects/list')
      return { projects: [project], nextCursor: null }
    if (path === '/v1/projects/get') return project
    if (path === '/v1/threads/list')
      return {
        threads: (input as { projectId?: string }).projectId
          ? [summaryOf(opened), summaryOf(other)]
          : [],
        pinned: [],
        nextCursor: null,
      }
    if (path === '/v1/threads/get') return structuredClone(opened)
    if (path === '/v1/threads/delete') return {}
    throw new Error(`Unexpected request: ${path}`)
  })
  render(
    <ProjectProvider initialProjectId={project.id}>
      <ChatInterface
        initialProjectId={project.id}
        initialChatId={opened.id}
        suppressIntroModals
      />
    </ProjectProvider>,
  )
  await screen.findByText('Opened discussion conversation')
  const listed = (
    await screen.findByRole('link', { name: /^Opened discussion/ })
  ).closest('[role="listitem"]') as HTMLElement
  fireEvent.click(within(listed).getByRole('button', { name: 'Delete chat' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))
  expect(chatPage.router.replace).toHaveBeenCalledExactlyOnceWith(
    `/project/${project.id}`,
    undefined,
    { shallow: true },
  )
  expect(chatPage.router.push).not.toHaveBeenCalled()
  await waitFor(() =>
    expect(
      screen.queryByRole('link', { name: /^Opened discussion/ }),
    ).not.toBeInTheDocument(),
  )
})

it('lists recent chats outside projects in search opened in a project, past pages of project chats', async () => {
  const inProject = projectChat('project-chat', 'Project discussion')
  const outside = {
    ...summaryOf(projectChat('outside-chat', 'Outside discussion')),
    projectId: null,
  }
  client.post.mockImplementation(async (path, input) => {
    if (path === '/v1/projects/list')
      return { projects: [project], nextCursor: null }
    if (path === '/v1/projects/get') return project
    if (path === '/v1/threads/list') {
      const { projectId, cursor } = input as {
        projectId?: string
        cursor?: string
      }
      // Every chat but the oldest is in the project.
      if (projectId || !cursor)
        return {
          threads: [summaryOf(inProject)],
          pinned: [],
          nextCursor: projectId ? null : 'older',
        }
      return { threads: [outside], pinned: [], nextCursor: null }
    }
    throw new Error(`Unexpected request: ${path}`)
  })
  render(
    <ProjectProvider initialProjectId={project.id}>
      <ChatInterface initialProjectId={project.id} suppressIntroModals />
    </ProjectProvider>,
  )
  await screen.findByRole('link', { name: /^Project discussion/ })
  fireEvent.keyDown(window, { key: 'k', metaKey: true })
  const recent = await screen.findByRole('listbox', { name: 'Recent chats' })
  await waitFor(() =>
    expect(
      within(recent)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Outside discussion']),
  )
  expect(
    client.post.mock.calls
      .filter(([path]) => path === '/v1/threads/list')
      .map(([, input]) => input),
  ).toEqual(
    expect.arrayContaining([
      { key: KEY, limit: 100 },
      { key: KEY, limit: 100, cursor: 'older' },
    ]),
  )
})
