import { ChatInterface } from '@/components/chat/chat-interface'
import { useDrag } from '@/components/chat/drag-context'
import { ProjectProvider } from '@/components/project/project-provider'
import { UI_SIDEBAR_OPEN } from '@/constants/storage-keys'
import type {
  Frame,
  HarnessEvent,
  Thread,
  ThreadSummary,
  Turn,
} from '@/services/harness/types'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MotionGlobalConfig } from 'framer-motion'
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { client, signIn } from '../../harness-fixture'
import { storedThread } from '../../services/harness/thread-fixture'
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
// In a project the project's sidebar is the only part of the page that
// reads the drag state, so these calls count its renders.
vi.mock('@/components/chat/drag-context', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/components/chat/drag-context')>()
  return { ...actual, useDrag: vi.fn(actual.useDrag) }
})

const project = {
  id: 'project-one',
  name: 'Research',
  description: '',
  systemInstructions: '',
  createdAt: '2026-10-22T12:00:00Z',
  updatedAt: '2026-10-22T12:00:00Z',
  documents: [],
}
const projectChat: Thread = {
  ...storedThread('project-chat', {
    title: 'Project discussion',
    titleState: 'generated',
    messages: [
      {
        id: 'u1',
        role: 'user',
        createdAt: '2026-10-22T12:00:00Z',
        content: 'What did the survey find?',
      },
      {
        id: 'a1',
        role: 'assistant',
        createdAt: '2026-10-22T12:00:01Z',
        content: 'It found a lot.',
        timeline: [{ id: 'b1', type: 'content', content: 'It found a lot.' }],
      },
    ],
  }),
  createdAt: '2026-10-22T12:00:00Z',
  updatedAt: '2026-10-22T12:00:01Z',
  activityAt: '2026-10-22T12:00:01Z',
  projectId: project.id,
  activeRun: null,
  contextUsage: null,
  messageCount: 2,
  hasOlder: false,
}
const { messages: _messages, hasOlder: _hasOlder, ...summary } = projectChat

// The sidebars swap at once instead of animating.
beforeAll(() => {
  MotionGlobalConfig.skipAnimations = true
})
afterAll(() => {
  MotionGlobalConfig.skipAnimations = false
})

beforeEach(() => {
  vi.stubGlobal('innerWidth', 1440)
  sessionStorage.setItem(UI_SIDEBAR_OPEN, 'true')
  chatPage.premium = true
  chatPage.router.replace.mockReset().mockResolvedValue(true)
  refuseFetch()
})

// The run the harness streams, frame by frame as the test emits them.
function scriptRun() {
  const frames: HarnessEvent[] = []
  let wake: (() => void) | undefined
  let ended = false
  const turns: Turn[] = []
  client.events.mockImplementation(async function* (
    _path: string,
    input: Turn,
  ): AsyncGenerator<Frame> {
    turns.push(input)
    let id = 0
    for (;;) {
      while (frames.length) yield { id: id++, event: frames.shift()! }
      if (ended) return
      await new Promise<void>((resolve) => {
        wake = resolve
      })
    }
  })
  return {
    turns,
    emit(...events: HarnessEvent[]) {
      frames.push(...events)
      wake?.()
    },
    end() {
      ended = true
      wake?.()
    },
  }
}

const chunk = (delta: string): HarnessEvent => ({
  type: 'TEXT_MESSAGE_CHUNK',
  messageId: 'reply',
  role: 'assistant',
  delta,
})

it("does not render a project's sidebar again as a reply streams", async () => {
  signIn({ cloud: true })
  const run = scriptRun()
  client.post.mockImplementation(
    async (path: string, input: Record<string, unknown>) => {
      if (path === '/v1/projects/list')
        return { projects: [project], nextCursor: null }
      if (path === '/v1/projects/get') return structuredClone(project)
      if (path === '/v1/threads/list')
        return {
          threads: [summary as ThreadSummary],
          pinned: [],
          nextCursor: null,
        }
      if (path === '/v1/threads/get' && input.id === projectChat.id)
        return structuredClone(projectChat)
      throw new Error(`Unexpected request: ${path}`)
    },
  )
  render(
    <ProjectProvider initialProjectId={project.id}>
      <ChatInterface
        initialProjectId={project.id}
        initialChatId={projectChat.id}
        suppressIntroModals
      />
    </ProjectProvider>,
  )
  await screen.findByText('It found a lot.')
  expect(
    await screen.findByRole('heading', { name: project.name }),
  ).toBeInTheDocument()
  expect(
    await screen.findByRole('link', { name: /^Project discussion/ }),
  ).toBeInTheDocument()
  const input = screen.getByRole('textbox', { name: /message/i })
  fireEvent.change(input, { target: { value: 'And the details?' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  await waitFor(() => expect(run.turns).toHaveLength(1))
  run.emit(
    {
      type: 'RUN_STARTED',
      threadId: projectChat.id,
      runId: 'run-1',
      instance: 'instance-1',
    },
    chunk('Streaming'),
  )
  await screen.findByText('Streaming')

  const sidebarRenders = vi.mocked(useDrag).mock.calls.length
  run.emit(chunk(' reply'))
  await screen.findByText('Streaming reply')
  run.emit(chunk(' grows'))
  await screen.findByText('Streaming reply grows')

  expect(vi.mocked(useDrag).mock.calls.length).toBe(sidebarRenders)
  run.end()
})
