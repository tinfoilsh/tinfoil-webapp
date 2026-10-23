import { ChatInterface } from '@/components/chat/chat-interface'
import { ProjectProvider } from '@/components/project/project-provider'
import { UI_SIDEBAR_OPEN } from '@/constants/storage-keys'
import { publish } from '@/services/harness/runtime'
import type { ThreadSummary } from '@/services/harness/types'
import { act, render, screen } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { client, KEY, signIn } from '../../harness-fixture'
import {
  resetChatStoresAroundEachTest,
  storedThread,
} from '../../services/harness/thread-fixture'
import { refuseFetch } from './chat-interface-fixture'
import { chatPage } from './chat-page-mocks'

const page = vi.hoisted(() => ({ toast: vi.fn() }))

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
vi.mock('@/hooks/use-toast', () => ({
  toast: page.toast,
  useToast: () => ({ toast: page.toast }),
}))

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
const projectChat: ThreadSummary = {
  ...storedThread('project-chat', {
    title: 'Project discussion',
    projectId: project.id,
  }),
  messageCount: 2,
}
const mainChat: ThreadSummary = {
  ...storedThread('main-chat', { title: 'Weekend plans' }),
  messageCount: 2,
}
const listPage = (threads: ThreadSummary[]) => ({
  threads,
  pinned: [],
  nextCursor: null,
})

// The harness's answer to each route a test expects, by path.
let routes: Record<string, (input: Record<string, unknown>) => unknown>
const requested = (path: string) =>
  client.post.mock.calls
    .filter(([called]) => called === path)
    .map(([, input]) => input as Record<string, unknown>)

function projectView(id = project.id) {
  return (
    <ProjectProvider initialProjectId={id}>
      <ChatInterface initialProjectId={id} suppressIntroModals />
    </ProjectProvider>
  )
}

beforeEach(() => {
  vi.stubGlobal('innerWidth', DESKTOP_WIDTH)
  sessionStorage.setItem(UI_SIDEBAR_OPEN, 'true')
  chatPage.premium = true
  chatPage.router.push.mockReset().mockResolvedValue(true)
  chatPage.router.replace.mockReset().mockResolvedValue(true)
  page.toast.mockReset()
  refuseFetch()
  signIn({ cloud: true })
  routes = {
    '/v1/projects/list': () => ({ projects: [project], nextCursor: null }),
    '/v1/projects/get': () => structuredClone(project),
    '/v1/threads/list': (input) =>
      listPage(input.projectId ? [projectChat] : [mainChat, projectChat]),
  }
  client.post.mockImplementation(
    async (path: string, input: Record<string, unknown>) => {
      const route = routes[path]
      if (!route) throw new Error(`Unexpected request: ${path}`)
      return route(input)
    },
  )
})

it("shows a project route's project loading until the content key opens it", async () => {
  publish({ keyReady: false, profileReady: false })
  render(projectView())

  expect(
    screen.getByRole('heading', { name: 'Loading...' }),
  ).toBeInTheDocument()
  expect(
    screen.queryByRole('button', { name: 'Projects' }),
  ).not.toBeInTheDocument()
  expect(requested('/v1/projects/get')).toEqual([])

  act(() => publish({ keyReady: true, profileReady: true }))

  expect(
    await screen.findByRole('heading', { name: project.name }),
  ).toBeInTheDocument()
  expect(requested('/v1/projects/get')).toEqual([{ key: KEY, id: project.id }])
})
