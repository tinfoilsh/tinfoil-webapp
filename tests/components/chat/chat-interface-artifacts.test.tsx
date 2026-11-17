import { ChatInterface } from '@/components/chat/chat-interface'
import { ProjectProvider } from '@/components/project/project-provider'
import { UI_SIDEBAR_OPEN } from '@/constants/storage-keys'
import { HarnessError } from '@/services/harness/sse'
import type { Artifact, Thread, ThreadSummary } from '@/services/harness/types'
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { MotionGlobalConfig } from 'framer-motion'
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { client, KEY, signIn, testSession } from '../../harness-fixture'
import {
  resetChatStoresAroundEachTest,
  storedThread,
} from '../../services/harness/thread-fixture'
import { refuseFetch } from './chat-interface-fixture'
import { chatPage } from './chat-page-mocks'

vi.mock('@clerk/react', async () => ({
  ...(await import('./chat-page-mocks')).clerk,
  useReverification: (callback: unknown) => callback,
}))
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

// The sidebars and their sections swap at once instead of animating.
beforeAll(() => {
  MotionGlobalConfig.skipAnimations = true
})
afterAll(() => {
  MotionGlobalConfig.skipAnimations = false
})

const DESKTOP_WIDTH = 1440
const MS_PER_DAY = 86_400_000
const project = {
  id: 'project-one',
  name: 'Research',
  description: '',
  systemInstructions: '',
  createdAt: '2026-10-22T12:00:00Z',
  updatedAt: '2026-10-22T12:00:00Z',
  documents: [],
}
const summary = (
  id: string,
  title: string,
  projectId: string | null,
): ThreadSummary => ({
  ...storedThread(id, { title, titleState: 'generated' }),
  createdAt: '2026-04-01T09:00:00Z',
  updatedAt: '2026-04-01T09:00:00Z',
  activityAt: '2026-04-01T09:00:00Z',
  projectId,
  activeRun: null,
  contextUsage: null,
  messageCount: 2,
})
const weekend = summary('weekend-chat', 'Weekend plans', null)
const survey = summary('survey-chat', 'Survey results', project.id)

// An artifact as the harness lists it, drawn three days ago.
const artifact = (
  thread: ThreadSummary,
  toolCallId: string,
  fields: Partial<Artifact> = {},
): Artifact => ({
  threadId: thread.id,
  threadTitle: thread.title,
  projectId: thread.projectId,
  messageId: `${thread.id}-reply`,
  toolCallId,
  title: '',
  sourceType: 'markdown',
  createdAt: new Date(Date.now() - 3 * MS_PER_DAY).toISOString(),
  ...fields,
})
const itinerary = artifact(weekend, 'call_itinerary', {
  title: 'Trip itinerary',
  sourceType: 'url',
})
const packing = artifact(weekend, 'call_packing', { title: 'Packing list' })
const budget = artifact(weekend, 'call_budget', { title: 'Trip budget' })
const chart = artifact(survey, 'call_chart', {
  title: 'Response chart',
  sourceType: 'html',
})
const findings = artifact(survey, 'call_findings', { title: 'Findings' })
// A Markdown source whose only heading names it in the artifact sidebar.
const markdownSource = (heading: string) => ({
  type: 'markdown',
  markdown: `# ${heading}`,
})
const opened = (listed: Artifact, source: unknown) => ({
  artifact: listed,
  arguments: JSON.stringify({ title: listed.title, source }),
})

// The harness's answer to each route a test expects, by path.
let routes: Record<string, (input: Record<string, unknown>) => unknown>
const requested = (path: string) =>
  client.post.mock.calls
    .filter(([called]) => called === path)
    .map(([, input]) => input as Record<string, unknown>)

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

// Signs in to a harness that lists artifacts unless told it does not.
function signInTo({ artifacts = true }: { artifacts?: boolean } = {}) {
  signIn({
    cloud: true,
    session: {
      ...testSession,
      features: { ...testSession.features, artifacts },
    },
  })
  client.post.mockImplementation(
    async (path: string, input: Record<string, unknown>) => {
      const route = routes[path]
      if (!route) throw new Error(`Unexpected request: ${path}`)
      return route(input)
    },
  )
}

const page = (projectId: string | null = null) => (
  <ProjectProvider initialProjectId={projectId}>
    <ChatInterface initialProjectId={projectId} suppressIntroModals />
  </ProjectProvider>
)

// The rows of the open artifact list, by what each shows.
const rows = () => screen.getAllByRole('listitem').map((row) => row.textContent)

async function openAllArtifacts() {
  fireEvent.click(await screen.findByRole('button', { name: 'Artifacts' }))
  return screen.findByRole('dialog', { name: 'Artifacts' })
}

beforeEach(() => {
  vi.stubGlobal('innerWidth', DESKTOP_WIDTH)
  sessionStorage.setItem(UI_SIDEBAR_OPEN, 'true')
  chatPage.premium = true
  chatPage.router.push.mockReset().mockResolvedValue(true)
  chatPage.router.replace.mockReset().mockResolvedValue(true)
  refuseFetch()
  routes = {
    '/v1/projects/list': () => ({ projects: [project], nextCursor: null }),
    '/v1/projects/get': () => structuredClone(project),
    '/v1/threads/list': (input) => ({
      threads: input.projectId ? [survey] : [weekend, survey],
      pinned: [],
      nextCursor: null,
    }),
  }
  signInTo()
})

it('lists the artifacts of every stored chat a page at a time, each once', async () => {
  // The harness lists a chat again when the chat list files it again
  // between two pages.
  routes['/v1/artifacts/list'] = ({ cursor }) =>
    cursor === 'page-2'
      ? { artifacts: [packing, chart], nextCursor: '' }
      : { artifacts: [itinerary, packing], nextCursor: 'page-2' }
  render(page())

  const dialog = await openAllArtifacts()

  await within(dialog).findByText('Trip itinerary')
  expect(rows()).toEqual([
    'Trip itineraryHosted preview · Weekend plans · 3d ago',
    'Packing listMarkdown artifact · Weekend plans · 3d ago',
  ])
  expect(requested('/v1/artifacts/list')).toEqual([{ key: KEY }])

  fireEvent.click(within(dialog).getByRole('button', { name: 'Load more' }))

  await within(dialog).findByText('Response chart')
  expect(rows()).toEqual([
    'Trip itineraryHosted preview · Weekend plans · 3d ago',
    'Packing listMarkdown artifact · Weekend plans · 3d ago',
    'Response chartHTML artifact · Survey results · 3d ago',
  ])
  expect(requested('/v1/artifacts/list')).toEqual([
    { key: KEY },
    { key: KEY, cursor: 'page-2' },
  ])
  expect(
    within(dialog).queryByRole('button', { name: 'Load more' }),
  ).not.toBeInTheDocument()
})

it('opens an artifact from the list in the artifact sidebar, leaving the open chat', async () => {
  routes['/v1/artifacts/list'] = () => ({
    artifacts: [packing],
    nextCursor: '',
  })
  routes['/v1/artifacts/get'] = () =>
    opened(packing, markdownSource('Pack light'))
  render(page())
  const dialog = await openAllArtifacts()

  fireEvent.click(await within(dialog).findByText('Packing list'))

  await screen.findByRole('button', { name: 'Close artifact sidebar' })
  expect(
    await screen.findByRole('heading', { name: 'Pack light' }),
  ).toBeInTheDocument()
  expect(requested('/v1/artifacts/get')).toEqual([
    {
      key: KEY,
      threadId: weekend.id,
      messageId: packing.messageId,
      toolCallId: packing.toolCallId,
    },
  ])
  expect(screen.queryByRole('dialog', { name: 'Artifacts' })).toBeNull()
  expect(requested('/v1/threads/get')).toEqual([])
  expect(chatPage.router.replace).not.toHaveBeenCalled()
})

it('opens only the artifact asked for last', async () => {
  routes['/v1/artifacts/list'] = () => ({
    artifacts: [budget, packing],
    nextCursor: '',
  })
  const first = deferred<unknown>()
  const second = deferred<unknown>()
  routes['/v1/artifacts/get'] = ({ toolCallId }) =>
    toolCallId === budget.toolCallId ? first.promise : second.promise
  render(page())
  const dialog = await openAllArtifacts()

  fireEvent.click(await within(dialog).findByText('Trip budget'))
  fireEvent.click(within(dialog).getByText('Packing list'))
  await waitFor(() => expect(requested('/v1/artifacts/get')).toHaveLength(2))
  await act(async () =>
    second.resolve(opened(packing, markdownSource('Pack light'))),
  )
  await act(async () =>
    first.resolve(opened(budget, markdownSource('Spend little'))),
  )

  expect(
    await screen.findByRole('heading', { name: 'Pack light' }),
  ).toBeInTheDocument()
  expect(screen.queryByRole('heading', { name: 'Spend little' })).toBeNull()
})

it("opens an artifact's chat from the list", async () => {
  routes['/v1/artifacts/list'] = () => ({
    artifacts: [itinerary],
    nextCursor: '',
  })
  const stored: Thread = {
    ...weekend,
    presetId: null,
    hasOlder: false,
    messages: [
      {
        id: 'weekend-question',
        role: 'user',
        createdAt: '2026-04-01T09:00:00Z',
        content: 'Where should we go?',
      },
    ],
  }
  routes['/v1/threads/get'] = () => structuredClone(stored)
  render(page())
  const dialog = await openAllArtifacts()

  fireEvent.click(
    await within(dialog).findByRole('button', {
      name: 'Open the chat Weekend plans',
    }),
  )

  expect(await screen.findByText('Where should we go?')).toBeInTheDocument()
  expect(requested('/v1/threads/get')).toEqual([{ key: KEY, id: weekend.id }])
  expect(chatPage.router.replace).toHaveBeenCalledWith(
    `/chat/${weekend.id}`,
    undefined,
    { shallow: true },
  )
  expect(screen.queryByRole('dialog', { name: 'Artifacts' })).toBeNull()
  expect(requested('/v1/artifacts/get')).toEqual([])
})

it('keeps an artifact it cannot draw in the list, and opens no sidebar for it', async () => {
  const model = artifact(weekend, 'call_model', {
    title: 'Floor plan',
    sourceType: 'cad',
  })
  routes['/v1/artifacts/list'] = () => ({ artifacts: [model], nextCursor: '' })
  routes['/v1/artifacts/get'] = () =>
    opened(model, { type: 'cad', cad: 'SOLID' })
  render(page())
  const dialog = await openAllArtifacts()
  expect(await within(dialog).findByRole('listitem')).toHaveTextContent(
    'Floor planArtifact · Weekend plans · 3d ago',
  )

  fireEvent.click(within(dialog).getByText('Floor plan'))

  expect(await within(dialog).findByRole('alert')).toBeInTheDocument()
  expect(
    screen.queryByRole('button', { name: 'Close artifact sidebar' }),
  ).toBeNull()
  expect(
    within(dialog).getByRole('button', { name: 'Open the chat Weekend plans' }),
  ).toBeEnabled()
})

it('says why the list could not be read, and reads it again when asked', async () => {
  routes['/v1/artifacts/list'] = () => {
    throw new HarnessError({
      code: 'UPSTREAM_REFUSED',
      action: 'retry',
      message: 'The chats could not be read',
    })
  }
  render(page())
  const dialog = await openAllArtifacts()
  expect(await within(dialog).findByRole('alert')).toHaveTextContent(
    'The chats could not be read',
  )

  routes['/v1/artifacts/list'] = () => ({ artifacts: [], nextCursor: '' })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Try again' }))

  expect(
    await within(dialog).findByText('No artifacts yet.'),
  ).toBeInTheDocument()
  expect(within(dialog).queryByRole('alert')).toBeNull()
  expect(requested('/v1/artifacts/list')).toEqual([{ key: KEY }, { key: KEY }])
})

it('keeps the pages read when a later one fails, and offers it again', async () => {
  let refuse = true
  routes['/v1/artifacts/list'] = ({ cursor }) => {
    if (!cursor) return { artifacts: [itinerary], nextCursor: 'page-2' }
    if (refuse)
      throw new HarnessError({
        code: 'UPSTREAM_REFUSED',
        action: 'retry',
        message: 'The chats could not be read',
      })
    return { artifacts: [chart], nextCursor: '' }
  }
  render(page())
  const dialog = await openAllArtifacts()
  fireEvent.click(
    await within(dialog).findByRole('button', { name: 'Load more' }),
  )
  expect(await within(dialog).findByRole('alert')).toHaveTextContent(
    'The chats could not be read',
  )
  expect(within(dialog).getByText('Trip itinerary')).toBeInTheDocument()

  refuse = false
  fireEvent.click(within(dialog).getByRole('button', { name: 'Load more' }))

  await within(dialog).findByText('Response chart')
  expect(within(dialog).getByText('Trip itinerary')).toBeInTheDocument()
  expect(within(dialog).queryByRole('alert')).toBeNull()
  expect(requested('/v1/artifacts/list')).toEqual([
    { key: KEY },
    { key: KEY, cursor: 'page-2' },
    { key: KEY, cursor: 'page-2' },
  ])
})

it("lists a project's artifacts in the project's sidebar", async () => {
  routes['/v1/artifacts/list'] = () => ({
    artifacts: [findings],
    nextCursor: '',
  })
  routes['/v1/artifacts/get'] = () =>
    opened(findings, markdownSource('Most agree'))
  render(page(project.id))
  await screen.findByRole('heading', { name: project.name })

  fireEvent.click(screen.getByRole('button', { name: 'Artifacts' }))

  fireEvent.click(await screen.findByText('Findings'))
  expect(
    await screen.findByRole('heading', { name: 'Most agree' }),
  ).toBeInTheDocument()
  expect(requested('/v1/artifacts/list')).toEqual([
    { key: KEY, projectId: project.id },
  ])
  expect(requested('/v1/artifacts/get')).toEqual([
    {
      key: KEY,
      threadId: survey.id,
      messageId: findings.messageId,
      toolCallId: findings.toolCallId,
    },
  ])
})

it.each([
  { where: 'the chat sidebar', projectId: null, shown: 'Chats' },
  {
    where: "a project's sidebar",
    projectId: project.id,
    shown: 'Exit Project',
  },
])(
  'offers no artifacts in $where from a harness that does not list them',
  async ({ projectId, shown }) => {
    signInTo({ artifacts: false })
    render(page(projectId))

    await screen.findByRole('button', { name: shown })
    expect(screen.queryByRole('button', { name: 'Artifacts' })).toBeNull()
    expect(requested('/v1/artifacts/list')).toEqual([])
  },
)
