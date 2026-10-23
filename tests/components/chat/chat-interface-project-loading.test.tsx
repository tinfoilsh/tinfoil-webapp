import { ChatInterface } from '@/components/chat/chat-interface'
import { ProjectProvider } from '@/components/project/project-provider'
import {
  UI_SIDEBAR_OPEN,
  UI_SIDEBAR_PROJECTS_EXPANDED,
} from '@/constants/storage-keys'
import type { ThreadSummary } from '@/services/harness/types'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
const otherProject = { ...project, id: 'project-two', name: 'Planning' }
const chat: ThreadSummary = {
  ...storedThread('project-chat', {
    title: 'Project discussion',
    projectId: project.id,
  }),
  messageCount: 2,
}
const otherChat: ThreadSummary = {
  ...chat,
  id: 'other-chat',
  title: 'Planning discussion',
  projectId: otherProject.id,
}
const page = (threads: ThreadSummary[]) => ({
  threads,
  pinned: [],
  nextCursor: null,
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: Error) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

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
  sessionStorage.setItem(UI_SIDEBAR_PROJECTS_EXPANDED, 'true')
  chatPage.premium = true
  refuseFetch()
  signIn({ cloud: true })
})

it.each(['populated', 'empty'])(
  'keeps the skeleton until the project chat list is confirmed %s',
  async (result) => {
    const details = deferred<typeof project>()
    const chats = deferred<ReturnType<typeof page>>()
    client.post.mockImplementation(async (path, input) => {
      if (path === '/v1/projects/list')
        return { projects: [project], nextCursor: null }
      if (path === '/v1/projects/get') return details.promise
      if (path === '/v1/threads/list')
        return (input as { projectId?: string }).projectId
          ? chats.promise
          : page([])
      throw new Error(`Unexpected ${path}`)
    })
    render(
      <ProjectProvider>
        <ChatInterface suppressIntroModals />
      </ProjectProvider>,
    )
    fireEvent.click(await screen.findByRole('link', { name: /^Research\b/ }))
    await screen.findByRole('status', { name: 'Loading chats' })
    await act(async () => details.resolve(project))
    expect(
      screen.getByRole('button', { name: 'Project Settings' }),
    ).toBeEnabled()
    expect(
      screen.getByRole('status', { name: 'Loading chats' }),
    ).toBeInTheDocument()
    expect(
      screen.queryByText('No chats in this project yet.'),
    ).not.toBeInTheDocument()

    await act(async () =>
      chats.resolve(page(result === 'populated' ? [chat] : [])),
    )
    expect(
      screen.queryByRole('status', { name: 'Loading chats' }),
    ).not.toBeInTheDocument()
    if (result === 'populated')
      expect(screen.getByRole('link', { name: chat.title })).toBeInTheDocument()
    else
      expect(
        screen.getByText('No chats in this project yet.'),
      ).toBeInTheDocument()
  },
)

it.each(['success', 'failure'])(
  'keeps the new project loader after the previous request ends in %s',
  async (outcome) => {
    const first = deferred<ReturnType<typeof page>>()
    const second = deferred<ReturnType<typeof page>>()
    client.post.mockImplementation(async (path, input) => {
      if (path === '/v1/projects/list')
        return { projects: [project, otherProject], nextCursor: null }
      if (path === '/v1/projects/get')
        return (input as { id: string }).id === project.id
          ? project
          : otherProject
      if (path === '/v1/threads/list')
        return (input as { projectId: string }).projectId === project.id
          ? first.promise
          : second.promise
      throw new Error(`Unexpected ${path}`)
    })
    const { rerender } = render(projectView())
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Project Settings' }),
      ).toBeEnabled(),
    )
    rerender(projectView(otherProject.id))
    await screen.findByRole('heading', { name: otherProject.name })
    await act(async () => {
      if (outcome === 'success') first.resolve(page([chat]))
      else first.reject(new Error('Previous project failed'))
    })
    expect(
      screen.getByRole('status', { name: 'Loading chats' }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('link', { name: chat.title }),
    ).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    await act(async () => second.resolve(page([otherChat])))
    expect(
      screen.queryByRole('status', { name: 'Loading chats' }),
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('link', { name: otherChat.title }),
    ).toBeInTheDocument()
  },
)

it('shows a retryable error instead of an empty project after a list failure', async () => {
  const failed = deferred<ReturnType<typeof page>>()
  const retry = deferred<ReturnType<typeof page>>()
  let requests = 0
  client.post.mockImplementation(async (path) => {
    if (path === '/v1/projects/list')
      return { projects: [project], nextCursor: null }
    if (path === '/v1/projects/get') return project
    if (path === '/v1/threads/list')
      return ++requests === 1 ? failed.promise : retry.promise
    throw new Error(`Unexpected ${path}`)
  })
  render(projectView())
  await screen.findByRole('status', { name: 'Loading chats' })
  await act(async () => failed.reject(new Error('Chat list unavailable')))
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Could not load chats.',
  )
  expect(
    screen.queryByText('No chats in this project yet.'),
  ).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
  expect(
    screen.getByRole('status', { name: 'Loading chats' }),
  ).toBeInTheDocument()
  await act(async () => retry.resolve(page([chat])))
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  expect(screen.getByRole('link', { name: chat.title })).toBeInTheDocument()
})

it('keeps cached project chats visible while their list refreshes', async () => {
  client.post.mockImplementation(async (path) => {
    if (path === '/v1/projects/list')
      return { projects: [project], nextCursor: null }
    if (path === '/v1/projects/get') return project
    if (path === '/v1/threads/list') return page([chat])
    throw new Error(`Unexpected ${path}`)
  })
  const first = render(projectView())
  await screen.findByRole('link', { name: chat.title })
  first.unmount()

  signIn({ cloud: true })
  const fresh = deferred<ReturnType<typeof page>>()
  client.post.mockImplementation(async (path) => {
    if (path === '/v1/projects/list')
      return { projects: [project], nextCursor: null }
    if (path === '/v1/projects/get') return project
    if (path === '/v1/threads/list') return fresh.promise
    throw new Error(`Unexpected ${path}`)
  })
  render(projectView())
  expect(
    await screen.findByRole('link', { name: chat.title }),
  ).toBeInTheDocument()
  expect(
    screen.queryByRole('status', { name: 'Loading chats' }),
  ).not.toBeInTheDocument()
  await act(async () =>
    fresh.resolve(
      page([chat, { ...chat, id: 'new-chat', title: 'New discussion' }]),
    ),
  )
  expect(
    screen.getByRole('link', { name: 'New discussion' }),
  ).toBeInTheDocument()
})
