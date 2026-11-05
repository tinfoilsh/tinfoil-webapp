import { ChatInterface } from '@/components/chat/chat-interface'
import { getRendererRegistry } from '@/components/chat/renderers/client'
import { useSpeak } from '@/components/chat/speech-context'
import type {
  Frame,
  HarnessEvent,
  Thread,
  Turn,
} from '@/services/harness/types'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { client, signIn } from '../../harness-fixture'
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
  '@/hooks/use-projects',
  async () => (await import('./chat-page-mocks')).projects,
)
vi.mock(
  '@/hooks/use-subscription-status',
  async () => (await import('./chat-page-mocks')).subscription,
)
vi.mock(
  '@/hooks/use-passkey-backup',
  async () => (await import('./chat-page-mocks')).passkeyBackup,
)
vi.mock(
  '@/components/project',
  async () => (await import('./chat-page-mocks')).project,
)
vi.mock(
  '@/components/chat/chat-sidebar',
  async () => (await import('./chat-page-mocks')).chatSidebar,
)
vi.mock(
  '@/utils/error-handling',
  async () => (await import('./chat-page-mocks')).errorHandling,
)
// Each read-aloud button reads the chat's speech through this hook as it
// renders, so its calls count the renders of the replies that offer one.
vi.mock('@/components/chat/speech-context', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/components/chat/speech-context')>()
  return { ...actual, useSpeak: vi.fn(actual.useSpeak) }
})

const THREAD_ID = 'thread-1'
const thread: Thread = {
  id: THREAD_ID,
  title: 'A chat',
  titleState: 'generated',
  createdAt: '2026-04-01T09:00:00Z',
  updatedAt: '2026-04-01T09:00:00Z',
  activityAt: '2026-04-01T09:00:03Z',
  model: 'test-model',
  projectId: null,
  presetId: null,
  pinned: false,
  webSearchEnabled: true,
  contextUsage: null,
  messageCount: 4,
  activeRun: null,
  hasOlder: false,
  messages: [
    {
      id: 'u1',
      role: 'user',
      createdAt: '2026-04-01T09:00:00Z',
      content: 'First question',
    },
    {
      id: 'a1',
      role: 'assistant',
      createdAt: '2026-04-01T09:00:01Z',
      timeline: [{ id: 'b1', type: 'content', content: 'First answer' }],
    },
    {
      id: 'u2',
      role: 'user',
      createdAt: '2026-04-01T09:00:02Z',
      content: 'Second question',
    },
    {
      id: 'a2',
      role: 'assistant',
      createdAt: '2026-04-01T09:00:03Z',
      timeline: [{ id: 'b2', type: 'content', content: 'Second answer' }],
    },
  ],
}

beforeEach(() => {
  vi.stubGlobal('innerWidth', 1440)
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

it('renders only the streaming reply as it grows', async () => {
  signIn({ cloud: true })
  const run = scriptRun()
  client.post.mockImplementation(async (path: string) => {
    if (path === '/v1/threads/get') return structuredClone(thread)
    if (path === '/v1/threads/list') return { threads: [], nextCursor: null }
    throw new Error(`Unexpected ${path}`)
  })
  render(<ChatInterface initialChatId={THREAD_ID} suppressIntroModals />)
  await screen.findByText('Second answer')
  expect(screen.getAllByRole('button', { name: 'Read aloud' })).toHaveLength(2)
  const input = screen.getByRole('textbox', { name: /message/i })
  fireEvent.change(input, { target: { value: 'Third question' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  await waitFor(() => expect(run.turns).toHaveLength(1))
  run.emit(
    {
      type: 'RUN_STARTED',
      threadId: THREAD_ID,
      runId: 'run-1',
      instance: 'instance-1',
    },
    chunk('Streaming'),
  )
  await screen.findByText('Streaming')

  const renders = vi.spyOn(getRendererRegistry(), 'getMessageRenderer')
  const speechReads = vi.mocked(useSpeak).mock.calls.length
  run.emit(chunk(' reply'))
  await screen.findByText('Streaming reply')
  run.emit(chunk(' grows'))
  await screen.findByText('Streaming reply grows')

  expect(new Set(renders.mock.calls.map(([message]) => message.id))).toEqual(
    new Set(['reply']),
  )
  expect(vi.mocked(useSpeak).mock.calls.length).toBe(speechReads)
  run.end()
})
