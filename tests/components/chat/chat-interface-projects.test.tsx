import { ChatInterface } from '@/components/chat/chat-interface'
import { ProjectProvider } from '@/components/project/project-provider'
import {
  UI_SIDEBAR_OPEN,
  UI_SIDEBAR_PROJECTS_EXPANDED,
} from '@/constants/storage-keys'
import { publish } from '@/services/harness/runtime'
import type { Thread, ThreadSummary } from '@/services/harness/types'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
// Lazy UI renders once loaded, so the Add to project prompt can be answered;
// the verification sidebar is not part of these tests.
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
const openProjectChat: Thread = {
  ...storedThread(projectChat.id, {
    title: projectChat.title,
    projectId: project.id,
    messages: [
      {
        id: 'project-question',
        role: 'user',
        createdAt: '2026-10-22T12:00:00Z',
        content: 'What did the survey find?',
      },
    ],
  }),
  messageCount: 1,
  hasOlder: false,
}
const planning = { ...project, id: 'project-two', name: 'Planning' }
const projectDocument = (id: string, filename: string) => ({
  id,
  projectId: project.id,
  filename,
  contentType: 'text/markdown',
  sizeBytes: 12,
  createdAt: '2026-10-22T12:00:00Z',
  updatedAt: '2026-10-22T12:00:00Z',
  content: `The text of ${filename}`,
})
const notes = projectDocument('doc-notes', 'notes.md')
const plan = projectDocument('doc-plan', 'plan.md')
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

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: Error) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

// The open project's Documents section, once the project has loaded.
async function openDocuments() {
  fireEvent.click(
    await screen.findByRole('button', { name: /^Documents \(\d+\)/ }),
  )
}

// The chat page at a route, as the router renders it.
function routeView({
  projectId = null,
  chatId = null,
}: {
  projectId?: string | null
  chatId?: string | null
}) {
  return (
    <ProjectProvider initialProjectId={projectId}>
      <ChatInterface
        initialProjectId={projectId}
        initialChatId={chatId}
        suppressIntroModals
      />
    </ProjectProvider>
  )
}

const projectView = (id = project.id) => routeView({ projectId: id })

// A drag's data, shared by the events of one drag as a browser shares it.
function dragData() {
  const data = new Map<string, string>()
  return {
    get types() {
      return [...data.keys()]
    },
    setData: (type: string, value: string) => void data.set(type, value),
    getData: (type: string) => data.get(type) ?? '',
  }
}

// The row a chat is dragged by; its link is never draggable itself.
const listItem = (title: string) =>
  screen
    .getByRole('link', { name: title })
    .parentElement!.closest('[draggable]')!

// How long a chat must be held over Exit Project to leave the project.
const EXIT_HOVER_DELAY_MS = 400

// Drags a project chat onto Exit Project and holds it there until the
// project closes; the drag goes on.
function dragOntoExitProject(title: string) {
  const drag = dragData()
  fireEvent.dragStart(listItem(title), { dataTransfer: drag })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    fireEvent.dragEnter(screen.getByRole('button', { name: 'Exit Project' }), {
      dataTransfer: drag,
    })
    act(() => vi.advanceTimersByTime(EXIT_HOVER_DELAY_MS))
  } finally {
    vi.useRealTimers()
  }
  return drag
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

it('keeps the document controls usable while the open project refreshes', async () => {
  routes['/v1/projects/get'] = () => ({
    ...structuredClone(project),
    documents: [notes],
  })
  render(projectView())
  await openDocuments()
  const upload = screen.getByRole('button', { name: 'Upload documents' })
  const remove = screen.getByRole('button', { name: 'Remove notes.md' })
  expect(upload).toBeEnabled()
  expect(remove).toBeEnabled()

  const refreshed = deferred<unknown>()
  routes['/v1/projects/get'] = () => refreshed.promise
  act(() => publish({ projectRevision: 'remote-change' }))
  await waitFor(() => expect(requested('/v1/projects/get')).toHaveLength(2))

  expect(upload).toBeEnabled()
  expect(remove).toBeEnabled()
  await act(async () =>
    refreshed.resolve({
      ...structuredClone(project),
      documents: [notes, plan],
    }),
  )
  expect(screen.getByRole('button', { name: 'Remove plan.md' })).toBeEnabled()
  expect(upload).toBeEnabled()
})

it('removes a document at once and keeps it gone through a refresh read before the removal', async () => {
  routes['/v1/projects/get'] = () => ({
    ...structuredClone(project),
    documents: [notes, plan],
  })
  const removal = deferred<unknown>()
  routes['/v1/projects/documents/delete'] = () => removal.promise
  render(projectView())
  await openDocuments()

  fireEvent.click(screen.getByRole('button', { name: 'Remove notes.md' }))
  expect(
    screen.queryByRole('button', { name: 'Remove notes.md' }),
  ).not.toBeInTheDocument()
  act(() => publish({ projectRevision: 'remote-change' }))
  await waitFor(() => expect(requested('/v1/projects/get')).toHaveLength(2))
  expect(
    screen.queryByRole('button', { name: 'Remove notes.md' }),
  ).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Remove plan.md' })).toBeEnabled()

  routes['/v1/projects/get'] = () => ({
    ...structuredClone(project),
    documents: [plan],
  })
  await act(async () => removal.resolve({}))
  await waitFor(() => expect(requested('/v1/projects/get')).toHaveLength(3))
  expect(
    screen.queryByRole('button', { name: 'Remove notes.md' }),
  ).not.toBeInTheDocument()
  expect(requested('/v1/projects/documents/delete')).toEqual([
    { key: KEY, projectId: project.id, documentId: notes.id },
  ])
  expect(page.toast).not.toHaveBeenCalled()
})

it('returns a document whose removal fails', async () => {
  routes['/v1/projects/get'] = () => ({
    ...structuredClone(project),
    documents: [notes, plan],
  })
  const removal = deferred<unknown>()
  routes['/v1/projects/documents/delete'] = () => removal.promise
  render(projectView())
  await openDocuments()

  fireEvent.click(screen.getByRole('button', { name: 'Remove notes.md' }))
  expect(
    screen.queryByRole('button', { name: 'Remove notes.md' }),
  ).not.toBeInTheDocument()
  await act(async () => removal.reject(new Error('Sync is unavailable')))

  expect(screen.getByRole('button', { name: 'Remove notes.md' })).toBeEnabled()
  expect(screen.getByRole('button', { name: 'Remove plan.md' })).toBeEnabled()
  expect(page.toast).toHaveBeenCalledExactlyOnceWith({
    title: 'Failed to delete document',
    description: 'The document could not be deleted. Please try again.',
    variant: 'destructive',
  })
  expect(requested('/v1/projects/get')).toHaveLength(1)
})

it('opens the project list in the chat sidebar after leaving a project', async () => {
  render(projectView())
  await screen.findByRole('heading', { name: project.name })

  fireEvent.click(screen.getByRole('button', { name: 'Exit Project' }))

  expect(
    await screen.findByRole('button', { name: 'Projects', expanded: true }),
  ).toBeInTheDocument()
  expect(
    screen.getByRole('button', { name: 'Chats', expanded: false }),
  ).toBeInTheDocument()
  expect(
    await screen.findByRole('link', { name: new RegExp(`^${project.name}`) }),
  ).toBeInTheDocument()
})

it("leaves a project mid-drag for the open chat's own address, which lists every chat", async () => {
  routes['/v1/threads/get'] = () => structuredClone(openProjectChat)
  const { rerender } = render(
    routeView({ projectId: project.id, chatId: projectChat.id }),
  )
  await screen.findByText('What did the survey find?')
  await screen.findByRole('link', { name: projectChat.title })
  chatPage.router.push.mockClear()

  dragOntoExitProject(projectChat.title)

  expect(chatPage.router.push).toHaveBeenCalledExactlyOnceWith(
    `/chat/${projectChat.id}`,
    undefined,
    { shallow: true },
  )
  rerender(routeView({ chatId: projectChat.id }))
  fireEvent.click(
    await screen.findByRole('button', { name: 'Chats', expanded: false }),
  )
  expect(
    await screen.findByRole('link', { name: mainChat.title }),
  ).toBeInTheDocument()
  expect(screen.getByText('What did the survey find?')).toBeInTheDocument()
  expect(chatPage.router.push).toHaveBeenCalledOnce()
  expect(chatPage.router.replace).not.toHaveBeenCalled()
})

it('opens a project chosen after leaving another mid-drag, before the address has changed', async () => {
  routes['/v1/projects/list'] = () => ({
    projects: [project, planning],
    nextCursor: null,
  })
  const opening = deferred<unknown>()
  routes['/v1/projects/get'] = (input) =>
    input.id === planning.id ? opening.promise : structuredClone(project)
  const { rerender } = render(projectView())
  await screen.findByRole('link', { name: projectChat.title })

  dragOntoExitProject(projectChat.title)
  expect(chatPage.router.push).toHaveBeenLastCalledWith('/', undefined, {
    shallow: true,
  })
  fireEvent.click(await screen.findByRole('link', { name: /^Planning/ }))
  await waitFor(() =>
    expect(requested('/v1/projects/get')).toEqual([
      { key: KEY, id: project.id },
      { key: KEY, id: planning.id },
    ]),
  )
  rerender(routeView({}))
  await act(async () => opening.resolve(structuredClone(planning)))

  expect(await screen.findByTitle('Rename project')).toHaveTextContent(
    planning.name,
  )
  expect(chatPage.router.push).toHaveBeenLastCalledWith(
    `/project/${planning.id}`,
    undefined,
    { shallow: true },
  )
})

// Drops files on the chat page, as from the desktop.
function dropFiles(files: File[]) {
  fireEvent.drop(screen.getByRole('textbox', { name: 'Message' }), {
    dataTransfer: { files, types: ['Files'] },
  })
}

// Holds each project document upload until the test answers it.
function holdUploads() {
  const held = new Map<string, ReturnType<typeof deferred<unknown>>>()
  client.upload.mockImplementation(async (_path: string, file: File) => {
    const upload = deferred<unknown>()
    held.set(file.name, upload)
    return upload.promise
  })
  return held
}

const uploadsSent = () =>
  client.upload.mock.calls.map(([path, file, fields]) => [
    path,
    (file as File).name,
    fields,
  ])

it('adds files from the composer to the project, showing them all uploading in its documents', async () => {
  sessionStorage.setItem(UI_SIDEBAR_OPEN, 'false')
  const held = holdUploads()
  render(projectView())
  await screen.findByTitle('Rename project')

  dropFiles([
    new File(['# Notes'], notes.filename, { type: 'text/markdown' }),
    new File(['# Plan'], plan.filename, { type: 'text/markdown' }),
  ])
  fireEvent.click(
    await screen.findByRole('button', { name: 'Yes, add to project' }),
  )

  await waitFor(() =>
    expect(uploadsSent()).toEqual([
      [
        '/v1/projects/documents/upload',
        notes.filename,
        { key: KEY, projectId: project.id },
      ],
      [
        '/v1/projects/documents/upload',
        plan.filename,
        { key: KEY, projectId: project.id },
      ],
    ]),
  )
  expect(
    screen.getByRole('button', { name: 'Close sidebar' }),
  ).toBeInTheDocument()
  expect(
    screen.getByRole('button', { name: /^Documents/, expanded: true }),
  ).toBeInTheDocument()
  expect(screen.getAllByText('Uploading...')).toHaveLength(2)

  routes['/v1/projects/get'] = () => ({
    ...structuredClone(project),
    documents: [notes, plan],
  })
  await act(async () => {
    held.get(notes.filename)!.resolve(notes)
    held.get(plan.filename)!.resolve(plan)
  })
  await waitFor(() => expect(screen.queryAllByText('Uploading...')).toEqual([]))
  expect(screen.getByRole('button', { name: 'Remove notes.md' })).toBeEnabled()
  expect(screen.getByRole('button', { name: 'Remove plan.md' })).toBeEnabled()
  expect(page.toast).not.toHaveBeenCalled()
})

it('expands the documents of an open sidebar for files added from the composer', async () => {
  holdUploads()
  render(projectView())
  await screen.findByTitle('Rename project')
  expect(
    screen.getByRole('button', { name: /^Documents/, expanded: false }),
  ).toBeInTheDocument()

  dropFiles([new File(['# Notes'], notes.filename, { type: 'text/markdown' })])
  fireEvent.click(
    await screen.findByRole('button', { name: 'Yes, add to project' }),
  )

  expect(
    await screen.findByRole('button', { name: /^Documents/, expanded: true }),
  ).toBeInTheDocument()
  expect(screen.getByText('Uploading...')).toBeInTheDocument()
})

it('offers a file dropped while its project loads once the project opens', async () => {
  const opening = deferred<unknown>()
  routes['/v1/projects/get'] = () => opening.promise
  render(projectView())
  await screen.findByRole('heading', { name: 'Loading...' })

  dropFiles([new File(['# Notes'], notes.filename, { type: 'text/markdown' })])
  await act(async () => {})
  expect(
    screen.queryByRole('heading', { name: 'Add to project context?' }),
  ).not.toBeInTheDocument()

  await act(async () => opening.resolve(structuredClone(project)))
  expect(
    await screen.findByRole('heading', { name: 'Add to project context?' }),
  ).toBeInTheDocument()
  expect(
    screen.getByText(
      (_, element) =>
        element?.tagName === 'P' &&
        element.textContent ===
          `Would you like to add ${notes.filename} to the project context for ${project.name}?`,
    ),
  ).toBeInTheDocument()
  expect(client.upload).not.toHaveBeenCalled()
  expect(page.toast).not.toHaveBeenCalled()
})

it.each([
  {
    outcome: 'fails to load',
    finish: (opening: ReturnType<typeof deferred<unknown>>) =>
      act(async () => opening.reject(new Error('Project not found'))),
    toast: {
      title: 'Project unavailable',
      description:
        'The file was not attached because the project failed to load.',
    },
  },
  {
    outcome: 'is left for another project',
    finish: async (
      _: ReturnType<typeof deferred<unknown>>,
      rerender: (ui: React.ReactElement) => void,
    ) => {
      routes['/v1/projects/get'] = () => structuredClone(planning)
      rerender(projectView(planning.id))
      await screen.findByTitle('Rename project')
    },
    toast: {
      title: 'Upload canceled',
      description: 'The file was not attached because the project changed.',
    },
  },
])(
  'drops a file waiting for a project that $outcome',
  async ({ finish, toast }) => {
    const opening = deferred<unknown>()
    routes['/v1/projects/get'] = () => opening.promise
    const { rerender } = render(projectView())
    await screen.findByRole('heading', { name: 'Loading...' })

    dropFiles([
      new File(['# Notes'], notes.filename, { type: 'text/markdown' }),
    ])
    await finish(opening, rerender)

    await waitFor(() =>
      expect(page.toast).toHaveBeenCalledExactlyOnceWith({
        ...toast,
        variant: 'destructive',
        position: 'top-right',
      }),
    )
    expect(
      screen.queryByRole('heading', { name: 'Add to project context?' }),
    ).not.toBeInTheDocument()
    expect(client.upload).not.toHaveBeenCalled()
  },
)

it('says project mode ended when the page leaves a loading project with a file waiting, after another project failed to load', async () => {
  const opening = deferred<unknown>()
  routes['/v1/projects/get'] = (input) => {
    if (input.id === project.id) throw new Error('Project not found')
    return opening.promise
  }
  const { rerender } = render(projectView())
  await waitFor(() => expect(requested('/v1/projects/get')).toHaveLength(1))
  rerender(projectView(planning.id))
  await waitFor(() => expect(requested('/v1/projects/get')).toHaveLength(2))
  expect(screen.getByRole('heading', { name: 'Loading...' })).toBeVisible()
  dropFiles([new File(['# Notes'], notes.filename, { type: 'text/markdown' })])
  await act(async () => {})

  rerender(routeView({}))

  await waitFor(() =>
    expect(page.toast).toHaveBeenCalledExactlyOnceWith({
      title: 'Upload canceled',
      description: 'The file was not attached because project mode ended.',
      variant: 'destructive',
      position: 'top-right',
    }),
  )
  expect(client.upload).not.toHaveBeenCalled()
})

// The paths requested after the first request to `path`.
const requestedAfter = (path: string) => {
  const paths = client.post.mock.calls.map(([called]) => called as string)
  const index = paths.indexOf(path)
  expect(index).toBeGreaterThanOrEqual(0)
  return paths.slice(index + 1)
}

it('confirms a chat moved out of its project and lists the project without it', async () => {
  routes['/v1/threads/update'] = (input) => ({ ...projectChat, ...input })
  render(projectView())
  await screen.findByRole('link', { name: projectChat.title })
  routes['/v1/threads/list'] = (input) =>
    listPage(
      input.projectId ? [] : [mainChat, { ...projectChat, projectId: null }],
    )

  fireEvent.click(screen.getByRole('button', { name: 'More chat options' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Move out of project' }))

  await waitFor(() =>
    expect(page.toast).toHaveBeenCalledExactlyOnceWith({
      title: 'Chat removed from project',
      description: 'The chat is now in your main chat list.',
    }),
  )
  expect(requested('/v1/threads/update')).toEqual([
    { key: KEY, id: projectChat.id, projectId: null },
  ])
  expect(requestedAfter('/v1/threads/update')).toContain('/v1/threads/list')
  expect(
    await screen.findByText('No chats in this project yet.'),
  ).toBeInTheDocument()
})

it('reports a chat dropped out of its project that stays in it', async () => {
  routes['/v1/threads/update'] = () => {
    throw new Error('Sync is unavailable')
  }
  const { rerender } = render(projectView())
  await screen.findByRole('link', { name: projectChat.title })
  const drag = dragOntoExitProject(projectChat.title)
  rerender(routeView({}))
  const chats = await screen.findByRole('button', { name: 'Chats' })
  fireEvent.dragEnter(chats, { dataTransfer: drag })

  await act(async () => {
    fireEvent.drop(chats, { dataTransfer: drag })
  })

  await waitFor(() =>
    expect(page.toast).toHaveBeenCalledExactlyOnceWith({
      title: 'Failed to remove chat',
      description: 'Please try again.',
      variant: 'destructive',
    }),
  )
  expect(requested('/v1/threads/update')).toEqual([
    { key: KEY, id: projectChat.id, projectId: null },
  ])
  expect(requestedAfter('/v1/threads/update')).toContain('/v1/threads/list')
})

it('names a new project after the projects listed and opens it', async () => {
  sessionStorage.setItem(UI_SIDEBAR_PROJECTS_EXPANDED, 'true')
  const created = { ...project, id: 'project-new', name: 'My Project #2' }
  routes['/v1/projects/create'] = () => structuredClone(created)
  routes['/v1/projects/get'] = (input) =>
    structuredClone(input.id === created.id ? created : project)
  render(routeView({}))
  await screen.findByRole('link', { name: /^Research/ })

  fireEvent.click(screen.getByRole('button', { name: 'New Project' }))

  expect(await screen.findByTitle('Rename project')).toHaveTextContent(
    created.name,
  )
  expect(requested('/v1/projects/create')).toEqual([
    { key: KEY, name: 'My Project #2', description: '' },
  ])
  expect(chatPage.router.push).toHaveBeenLastCalledWith(
    `/project/${created.id}`,
    undefined,
    { shallow: true },
  )
  expect(page.toast).not.toHaveBeenCalled()
})

it('reports a project that could not be created', async () => {
  sessionStorage.setItem(UI_SIDEBAR_PROJECTS_EXPANDED, 'true')
  routes['/v1/projects/create'] = () => {
    throw new Error('Sync is unavailable')
  }
  render(routeView({}))
  await screen.findByRole('link', { name: /^Research/ })

  fireEvent.click(screen.getByRole('button', { name: 'New Project' }))

  await waitFor(() =>
    expect(page.toast).toHaveBeenCalledExactlyOnceWith({
      title: 'Failed to create project',
      description: 'Please try again.',
      variant: 'destructive',
    }),
  )
  expect(screen.getByRole('button', { name: 'New Project' })).toBeEnabled()
  expect(requested('/v1/projects/get')).toEqual([])
})

it('shows the projects loading rather than missing until the key lets them be listed', async () => {
  sessionStorage.setItem(UI_SIDEBAR_PROJECTS_EXPANDED, 'true')
  publish({ keyReady: false, profileReady: false })
  const listing = deferred<unknown>()
  routes['/v1/projects/list'] = () => listing.promise
  render(routeView({}))
  await screen.findByRole('button', { name: 'New Project' })
  expect(screen.queryByText('No projects yet')).not.toBeInTheDocument()

  act(() => publish({ keyReady: true, profileReady: true }))
  await waitFor(() => expect(requested('/v1/projects/list')).toHaveLength(1))
  expect(screen.queryByText('No projects yet')).not.toBeInTheDocument()

  await act(async () => listing.resolve({ projects: [], nextCursor: null }))
  expect(screen.getByText('No projects yet')).toBeInTheDocument()
})
