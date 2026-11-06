import { ChatInterface } from '@/components/chat/chat-interface'
import { UI_SIDEBAR_OPEN } from '@/constants/storage-keys'
import type {
  Frame,
  HarnessEvent,
  Message,
  Thread,
  Turn,
} from '@/services/harness/types'
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { client, KEY, signIn, testSession } from '../../harness-fixture'
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
vi.mock('@/components/project/project-context', () => ({
  useProject: () => ({ activeProject: null, deleteProject: vi.fn() }),
}))
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

const THREAD_ID = 'thread-1'
const USAGE = { usedTokens: 155_000, limitTokens: 210_000, percentage: 73.8 }
const USAGE_LABEL = 'Context window 74% used (~155k of 210k tokens)'

const messages: Message[] = [
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
]

function threadOf(shown: Message[]): Thread {
  return {
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
    webSearchEnabled: false,
    contextUsage: USAGE,
    messageCount: shown.length,
    activeRun: null,
    hasOlder: false,
    messages: shown,
  }
}

const summaryOf = ({
  messages: _messages,
  hasOlder: _hasOlder,
  ...summary
}: Thread) => summary

const compacting = {
  ...testSession,
  features: {
    ...testSession.features,
    compaction: true,
    manualCompaction: true,
  },
}

beforeEach(() => {
  vi.stubGlobal('innerWidth', 1440)
  sessionStorage.setItem(UI_SIDEBAR_OPEN, 'true')
  chatPage.router.replace.mockReset().mockResolvedValue(true)
  refuseFetch()
})

// Each run the harness streams, frame by frame as the test emits them.
function scriptRuns() {
  const turns: Turn[] = []
  const frames: HarnessEvent[] = []
  let wake: (() => void) | undefined
  let ended = false
  client.events.mockImplementation(async function* (
    _path: string,
    input: Turn,
  ): AsyncGenerator<Frame> {
    turns.push(input)
    ended = false
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

// Opens the stored chat, whose list and stops the harness answers.
async function openChat(shown = messages) {
  const stops: unknown[] = []
  client.post.mockImplementation(async (path: string, input: unknown) => {
    if (path === '/v1/threads/get') return structuredClone(threadOf(shown))
    if (path === '/v1/threads/list')
      return { threads: [summaryOf(threadOf(shown))], nextCursor: null }
    if (path === '/v1/threads/cancel') {
      stops.push(input)
      return {}
    }
    throw new Error(`Unexpected ${path}`)
  })
  render(<ChatInterface initialChatId={THREAD_ID} suppressIntroModals />)
  await screen.findByText(
    shown.at(-1)?.timeline?.[0]?.content ?? 'Second answer',
  )
  return stops
}

function compactFromIndicator() {
  fireEvent.click(screen.getByRole('button', { name: USAGE_LABEL }))
  fireEvent.click(
    within(screen.getByRole('dialog', { name: 'Context window' })).getByRole(
      'button',
      { name: 'Compact chat' },
    ),
  )
}

const started = (runId: string, shown = messages): HarnessEvent[] => [
  { type: 'RUN_STARTED', threadId: THREAD_ID, runId, instance: 'instance-1' },
  { type: 'MESSAGES_SNAPSHOT', messages: shown, hasOlder: false },
  { type: 'COMPACTION_START', messageId: 'c1', beforeMessageId: 'u2' },
]

// The chat, whose last reply the service stopped as it thought again.
const stoppedThinking: Message[] = [
  ...messages.slice(0, 3),
  {
    ...messages[3],
    isInterrupted: true,
    timeline: [
      { id: 'b2', type: 'content', content: 'Second answer' },
      { id: 't2', type: 'thinking', content: 'Weighing whether to say more' },
    ],
  },
]

const marker: Message = {
  id: 'c1',
  role: 'compaction',
  createdAt: '2026-04-01T09:00:04Z',
  content: '## Goals and context\nThe user asked two questions.',
  compaction: {
    messages: 2,
    startedAt: 1,
    endedAt: 2,
    model: 'long-summary',
    version: 2,
  },
}

it('compacts a chat from its context indicator, leaving its last reply as it was while the summary is written', async () => {
  signIn({ cloud: true, session: compacting })
  const run = scriptRuns()
  await openChat(stoppedThinking)
  expect(screen.getByText('Thought')).toBeInTheDocument()

  compactFromIndicator()

  await waitFor(() => expect(run.turns).toHaveLength(1))
  expect(run.turns[0]).toMatchObject({
    kind: 'compact',
    threadId: THREAD_ID,
    key: KEY,
    options: { model: 'test-model' },
  })
  expect(run.turns[0]).not.toHaveProperty('content')
  expect(
    screen.queryByRole('dialog', { name: 'Context window' }),
  ).not.toBeInTheDocument()
  run.emit(...started('run-compact', stoppedThinking))
  await screen.findByRole('note', {
    name: 'Earlier messages above are being summarized for the assistant',
  })
  expect(
    screen.getByRole('button', { name: `Compacting… ${USAGE_LABEL}` }),
  ).toBeInTheDocument()
  // The run streams no reply, so the last one neither thinks again nor
  // loses what a finished reply offers.
  expect(screen.getByText('Thought')).toBeInTheDocument()
  expect(screen.queryByText('Thinking')).not.toBeInTheDocument()
  expect(screen.getAllByRole('button', { name: 'Read aloud' })).toHaveLength(2)

  run.emit(
    {
      type: 'COMPACTION_END',
      messageId: 'c1',
      beforeMessageId: 'u2',
      outcome: 'completed',
      marker,
    },
    {
      type: 'STATE_SNAPSHOT',
      snapshot: {
        thread: {
          ...summaryOf(threadOf(stoppedThinking)),
          contextUsage: {
            usedTokens: 21_000,
            limitTokens: 210_000,
            percentage: 10,
          },
        },
        queue: [],
        rateLimit: testSession.rateLimit,
      },
    },
    {
      type: 'RUN_FINISHED',
      threadId: THREAD_ID,
      runId: 'run-compact',
      metadata: {},
    },
  )
  run.end()

  expect(
    await screen.findByRole('button', {
      name: 'Context window 10% used (~21k of 210k tokens)',
    }),
  ).toBeInTheDocument()
  expect(
    screen.getByRole('button', { name: 'Compacted 2 earlier messages' }),
  ).toBeInTheDocument()
})

it('stops a compaction without saying the user stopped the reply before it', async () => {
  signIn({ cloud: true, session: compacting })
  const run = scriptRuns()
  const stops = await openChat(stoppedThinking)
  expect(screen.getByText('Response stopped')).toBeInTheDocument()
  compactFromIndicator()
  await waitFor(() => expect(run.turns).toHaveLength(1))
  run.emit(...started('run-compact', stoppedThinking))
  await screen.findByRole('note', {
    name: 'Earlier messages above are being summarized for the assistant',
  })

  fireEvent.click(screen.getByRole('button', { name: 'Stop generation' }))

  await waitFor(() =>
    expect(stops).toEqual([
      { key: KEY, threadId: THREAD_ID, runId: 'run-compact' },
    ]),
  )
  expect(
    screen.queryByText('Response canceled by user'),
  ).not.toBeInTheDocument()
  await act(async () => {
    run.emit(
      {
        type: 'COMPACTION_END',
        messageId: 'c1',
        beforeMessageId: 'u2',
        outcome: 'failed',
      },
      {
        type: 'RUN_FINISHED',
        threadId: THREAD_ID,
        runId: 'run-compact',
        metadata: { cancelled: true, messages: [] },
      },
    )
    run.end()
  })
  await waitFor(() =>
    expect(
      screen.queryByRole('note', {
        name: 'Earlier messages above are being summarized for the assistant',
      }),
    ).not.toBeInTheDocument(),
  )
  expect(
    screen.queryByText('Response canceled by user'),
  ).not.toBeInTheDocument()
  expect(screen.getByText('Response stopped')).toBeInTheDocument()
})

it('compacts again when the user retries a compaction that failed', async () => {
  signIn({ cloud: true, session: compacting })
  const run = scriptRuns()
  await openChat()
  compactFromIndicator()
  await waitFor(() => expect(run.turns).toHaveLength(1))
  run.emit(
    ...started('run-compact'),
    {
      type: 'COMPACTION_END',
      messageId: 'c1',
      beforeMessageId: 'u2',
      outcome: 'failed',
    },
    {
      type: 'RUN_ERROR',
      threadId: THREAD_ID,
      runId: 'run-compact',
      code: 'COMPACTION_FAILED',
      message: 'The chat could not be compacted to fit the context window',
      action: 'retry',
    },
  )
  run.end()
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'This chat could not be compacted',
  )

  fireEvent.click(screen.getByRole('button', { name: 'Try again' }))

  await waitFor(() => expect(run.turns).toHaveLength(2))
  expect(run.turns[1]).toMatchObject({ kind: 'compact', threadId: THREAD_ID })
  run.emit(...started('run-again'))
  await screen.findByRole('note', {
    name: 'Earlier messages above are being summarized for the assistant',
  })
  expect(screen.getAllByRole('button', { name: 'Read aloud' })).toHaveLength(2)
  run.end()
})

it('offers no compaction of a chat whose only exchange is its latest', async () => {
  signIn({ cloud: true, session: compacting })
  scriptRuns()
  await openChat(messages.slice(2))

  fireEvent.click(screen.getByRole('button', { name: USAGE_LABEL }))

  expect(
    within(screen.getByRole('dialog', { name: 'Context window' })).getByRole(
      'button',
      { name: 'Compact chat' },
    ),
  ).toBeDisabled()
})

it('offers no compaction while the harness does not', async () => {
  signIn({ cloud: true })
  scriptRuns()
  await openChat()

  expect(
    screen.queryByRole('button', { name: USAGE_LABEL }),
  ).not.toBeInTheDocument()
  expect(screen.getByRole('img', { name: USAGE_LABEL })).toBeInTheDocument()
})
