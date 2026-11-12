import { ChatInterface } from '@/components/chat/chat-interface'
import { UI_SIDEBAR_OPEN } from '@/constants/storage-keys'
import { CHAT_END } from '@/services/harness/protocol'
import { publish } from '@/services/harness/runtime'
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

// A harness that compacts a chat on request and keeps its latest exchange as
// it is, as one released before compactLatest does.
const keepingLatest = {
  ...testSession,
  features: {
    ...testSession.features,
    compaction: true,
    manualCompaction: true,
  },
}

const compacting = {
  ...keepingLatest,
  features: { ...keepingLatest.features, compactLatest: true },
}

beforeEach(() => {
  vi.stubGlobal('innerWidth', 1440)
  sessionStorage.setItem(UI_SIDEBAR_OPEN, 'true')
  chatPage.router.replace.mockReset().mockResolvedValue(true)
  refuseFetch()
})

// The stream of each turn the chat sends, in the order it sends them, frame
// by frame as the test emits them.
function scriptRuns() {
  const turns: Turn[] = []
  const streams: {
    frames: HarnessEvent[]
    wake?: () => void
    ended: boolean
  }[] = []
  const stream = (index: number) =>
    (streams[index] ??= { frames: [], ended: false })
  client.events.mockImplementation(async function* (
    _path: string,
    input: Turn,
  ): AsyncGenerator<Frame> {
    const own = stream(turns.push(input) - 1)
    let id = 0
    for (;;) {
      while (own.frames.length) yield { id: id++, event: own.frames.shift()! }
      if (own.ended) return
      await new Promise<void>((resolve) => {
        own.wake = resolve
      })
    }
  })
  return {
    turns,
    emit(index: number, ...events: HarnessEvent[]) {
      const own = stream(index)
      own.frames.push(...events)
      own.wake?.()
    },
    end(index: number) {
      const own = stream(index)
      own.ended = true
      own.wake?.()
    },
  }
}

// Opens the stored chat, with the harness answering its reads, its listing
// and stops.
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

// The statuses above the composer saying the chat is being, or was just,
// compacted.
const composerStatus = (name: string) =>
  within(
    screen.getByRole('textbox', { name: /message/i }).closest('form')!,
  ).queryByRole('status', { name })
const compactingStatus = () => composerStatus('Compacting conversation')
const compactedNotice = () => composerStatus('Conversation compacted')

// A run that compacts the chat: at its end, as a compaction the user asks
// for does, or before the message `before` names.
const started = (
  runId: string,
  shown = messages,
  before = CHAT_END,
): HarnessEvent[] => [
  { type: 'RUN_STARTED', threadId: THREAD_ID, runId, instance: 'instance-1' },
  { type: 'MESSAGES_SNAPSHOT', messages: shown, hasOlder: false },
  { type: 'COMPACTION_START', messageId: 'c1', beforeMessageId: before },
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

// The marker of a compaction the user asked for, which summarizes both
// exchanges.
const endMarker: Message = {
  ...marker,
  content:
    '## Goals and context\nThe user asked two questions and got answers.',
  compaction: { ...marker.compaction!, messages: 4 },
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
    compactLatest: true,
    options: { model: 'test-model' },
  })
  expect(run.turns[0]).not.toHaveProperty('content')
  expect(
    screen.queryByRole('dialog', { name: 'Context window' }),
  ).not.toBeInTheDocument()
  // The chat says so at once, before the harness starts compacting.
  expect(compactingStatus()).toBeInTheDocument()
  run.emit(0, ...started('run-compact', stoppedThinking))
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
  expect(screen.queryByText('Al is responding')).not.toBeInTheDocument()
  expect(compactingStatus()).toBeInTheDocument()

  run.emit(
    0,
    {
      type: 'COMPACTION_END',
      messageId: 'c1',
      beforeMessageId: CHAT_END,
      outcome: 'completed',
      marker: endMarker,
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
  run.end(0)

  expect(
    await screen.findByRole('button', {
      name: 'Context window 10% used (~21k of 210k tokens)',
    }),
  ).toBeInTheDocument()
  // The marker sits under the last reply, which the model no longer reads
  // either.
  const summarizedNote = screen.getByRole('note', {
    name: 'Earlier messages above were summarized and are no longer read by the assistant',
  })
  const lastReply = screen.getByText('Second answer')
  expect(
    lastReply.compareDocumentPosition(summarizedNote) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy()
  expect(lastReply.closest('[data-out-of-context]')).not.toBeNull()
  expect(
    screen.getByRole('button', { name: 'Compacted 4 earlier messages' }),
  ).toBeInTheDocument()
  expect(compactingStatus()).not.toBeInTheDocument()

  // The chat says it was compacted, also once the revision the compaction
  // saved has the chat read again.
  expect(compactedNotice()).toHaveTextContent('Summarized 4 earlier messages.')
  client.post.mockImplementation(async (path: string) => {
    if (path === '/v1/threads/get')
      return structuredClone({
        ...threadOf([...stoppedThinking, endMarker]),
        contextUsage: {
          usedTokens: 23_000,
          limitTokens: 210_000,
          percentage: 11,
        },
      })
    if (path === '/v1/threads/list')
      return {
        threads: [summaryOf(threadOf(stoppedThinking))],
        nextCursor: null,
      }
    throw new Error(`Unexpected ${path}`)
  })
  await act(async () => publish({ chatRevision: 'compacted' }))
  expect(
    await screen.findByRole('button', {
      name: 'Context window 11% used (~23k of 210k tokens)',
    }),
  ).toBeInTheDocument()

  // It shows where, as its marker sits under the reply it summarized last.
  const notice = compactedNotice()
  expect(notice).toHaveTextContent('Summarized 4 earlier messages.')
  const scrolled = vi.fn()
  const hadScroll = Object.hasOwn(Element.prototype, 'scrollIntoView')
  const scroll = Element.prototype.scrollIntoView
  Element.prototype.scrollIntoView = scrolled
  try {
    fireEvent.click(
      within(notice!).getByRole('button', { name: 'Show summary' }),
    )
  } finally {
    if (hadScroll) Element.prototype.scrollIntoView = scroll
    else delete (Element.prototype as Partial<Element>).scrollIntoView
  }
  expect(scrolled.mock.contexts).toEqual([
    screen.getByRole('note', {
      name: 'Earlier messages above were summarized and are no longer read by the assistant',
    }),
  ])
  fireEvent.click(within(notice!).getByRole('button', { name: 'Dismiss' }))
  expect(compactedNotice()).not.toBeInTheDocument()
})

it('queues a message sent while the chat compacts, and streams its reply once the compaction ends', async () => {
  signIn({ cloud: true, session: compacting })
  const run = scriptRuns()
  await openChat()
  compactFromIndicator()
  await waitFor(() => expect(run.turns).toHaveLength(1))
  run.emit(0, ...started('run-compact'))
  await waitFor(() => expect(compactingStatus()).toBeInTheDocument())

  const input = screen.getByRole('textbox', { name: /message/i })
  fireEvent.change(input, { target: { value: 'Third question' } })
  fireEvent.submit(input.closest('form')!)

  await waitFor(() => expect(run.turns).toHaveLength(2))
  expect(run.turns[1]).toMatchObject({
    kind: 'send',
    threadId: THREAD_ID,
    content: 'Third question',
  })
  // Only a turn that may compact asks for the latest exchange too.
  expect(run.turns[1]).not.toHaveProperty('compactLatest')
  const queued = {
    queueId: 'run-queued',
    kind: 'send',
    content: 'Third question',
    quote: null,
    attachments: [],
    createdAt: '2026-04-01T09:00:05Z',
  }
  run.emit(1, {
    type: 'STATE_DELTA',
    threadId: THREAD_ID,
    runId: 'run-queued',
    delta: [{ op: 'add', path: '/queue/-', value: queued }],
  })
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Remove queued message' }),
    ).toBeEnabled(),
  )
  expect(compactingStatus()).toBeInTheDocument()

  run.emit(
    0,
    {
      type: 'COMPACTION_END',
      messageId: 'c1',
      beforeMessageId: CHAT_END,
      outcome: 'completed',
      marker: endMarker,
    },
    {
      type: 'RUN_FINISHED',
      threadId: THREAD_ID,
      runId: 'run-compact',
      metadata: {},
    },
  )
  run.end(0)
  run.emit(
    1,
    {
      type: 'RUN_STARTED',
      threadId: THREAD_ID,
      runId: 'run-queued',
      instance: 'instance-1',
    },
    {
      type: 'MESSAGES_SNAPSHOT',
      messages: [
        ...messages,
        endMarker,
        {
          id: 'u3',
          role: 'user',
          createdAt: '2026-04-01T09:00:05Z',
          content: 'Third question',
        },
      ],
      hasOlder: false,
    },
    {
      type: 'STATE_SNAPSHOT',
      snapshot: {
        thread: summaryOf(threadOf(messages)),
        queue: [],
        rateLimit: testSession.rateLimit,
      },
    },
    {
      type: 'TEXT_MESSAGE_CHUNK',
      messageId: 'a3',
      role: 'assistant',
      delta: 'Third answer',
    },
  )

  expect(await screen.findByText('Third answer')).toBeInTheDocument()
  // The queued message's reply streams as any reply does.
  expect(compactingStatus()).not.toBeInTheDocument()
  expect(
    screen.queryByRole('button', { name: 'Remove queued message' }),
  ).not.toBeInTheDocument()
  expect(
    screen.getByRole('button', { name: 'Stop generation' }),
  ).toBeInTheDocument()
  expect(screen.getByText('Al is responding')).toBeInTheDocument()
  // The message it queued does not hide that the chat was compacted.
  expect(compactedNotice()).toBeInTheDocument()
  run.emit(1, {
    type: 'RUN_FINISHED',
    threadId: THREAD_ID,
    runId: 'run-queued',
    metadata: {},
  })
  run.end(1)
})

it('says the chat is compacting while a turn compacts it before the reply', async () => {
  signIn({ cloud: true, session: compacting })
  const run = scriptRuns()
  await openChat()
  const input = screen.getByRole('textbox', { name: /message/i })
  fireEvent.change(input, { target: { value: 'Third question' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  await waitFor(() => expect(run.turns).toHaveLength(1))
  const question: Message = {
    id: run.turns[0].clientRequestId,
    role: 'user',
    createdAt: '2026-04-01T09:00:05Z',
    content: 'Third question',
  }
  expect(compactingStatus()).not.toBeInTheDocument()

  run.emit(0, ...started('run-turn', [...messages, question], 'u2'))

  await waitFor(() => expect(compactingStatus()).toBeInTheDocument())
  run.emit(
    0,
    {
      type: 'COMPACTION_END',
      messageId: 'c1',
      beforeMessageId: 'u2',
      outcome: 'completed',
      marker,
    },
    {
      type: 'TEXT_MESSAGE_CHUNK',
      messageId: 'a3',
      role: 'assistant',
      delta: 'Third answer',
    },
  )
  expect(await screen.findByText('Third answer')).toBeInTheDocument()
  expect(compactingStatus()).not.toBeInTheDocument()
  run.emit(0, {
    type: 'RUN_FINISHED',
    threadId: THREAD_ID,
    runId: 'run-turn',
    metadata: {},
  })
  run.end(0)
  await waitFor(() => expect(compactedNotice()).toBeInTheDocument())

  // The next message the user sends puts the compaction behind them.
  fireEvent.change(screen.getByRole('textbox', { name: /message/i }), {
    target: { value: 'Fourth question' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))

  await waitFor(() => expect(run.turns).toHaveLength(2))
  expect(compactedNotice()).not.toBeInTheDocument()
  run.emit(
    1,
    {
      type: 'RUN_STARTED',
      threadId: THREAD_ID,
      runId: 'run-next',
      instance: 'instance-1',
    },
    {
      type: 'RUN_FINISHED',
      threadId: THREAD_ID,
      runId: 'run-next',
      metadata: {},
    },
  )
  run.end(1)
})

it('stops a compaction without saying the user stopped the reply before it', async () => {
  signIn({ cloud: true, session: compacting })
  const run = scriptRuns()
  const stops = await openChat(stoppedThinking)
  expect(screen.getByText('Response stopped')).toBeInTheDocument()
  compactFromIndicator()
  await waitFor(() => expect(run.turns).toHaveLength(1))
  run.emit(0, ...started('run-compact', stoppedThinking))
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
      0,
      {
        type: 'COMPACTION_END',
        messageId: 'c1',
        beforeMessageId: CHAT_END,
        outcome: 'failed',
      },
      {
        type: 'RUN_FINISHED',
        threadId: THREAD_ID,
        runId: 'run-compact',
        metadata: { cancelled: true, messages: [] },
      },
    )
    run.end(0)
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
    0,
    ...started('run-compact'),
    {
      type: 'COMPACTION_END',
      messageId: 'c1',
      beforeMessageId: CHAT_END,
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
  run.end(0)
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'This chat could not be compacted',
  )

  fireEvent.click(screen.getByRole('button', { name: 'Try again' }))

  await waitFor(() => expect(run.turns).toHaveLength(2))
  expect(run.turns[1]).toMatchObject({
    kind: 'compact',
    threadId: THREAD_ID,
    compactLatest: true,
  })
  run.emit(1, ...started('run-again'))
  await screen.findByRole('note', {
    name: 'Earlier messages above are being summarized for the assistant',
  })
  expect(screen.getAllByRole('button', { name: 'Read aloud' })).toHaveLength(2)
  run.end(1)
})

it('offers no compaction of a chat compacted since its last reply', async () => {
  signIn({ cloud: true, session: compacting })
  scriptRuns()
  await openChat([...messages, endMarker])

  fireEvent.click(screen.getByRole('button', { name: USAGE_LABEL }))

  expect(
    within(screen.getByRole('dialog', { name: 'Context window' })).getByRole(
      'button',
      { name: 'Compact chat' },
    ),
  ).toBeDisabled()
})

it('retries a reply that failed without asking to compact anything', async () => {
  signIn({ cloud: true, session: compacting })
  const run = scriptRuns()
  await openChat()
  fireEvent.change(screen.getByRole('textbox', { name: /message/i }), {
    target: { value: 'Third question' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  await waitFor(() => expect(run.turns).toHaveLength(1))
  run.emit(
    0,
    {
      type: 'RUN_STARTED',
      threadId: THREAD_ID,
      runId: 'run-turn',
      instance: 'instance-1',
    },
    {
      type: 'RUN_ERROR',
      threadId: THREAD_ID,
      runId: 'run-turn',
      code: 'MODEL_UNAVAILABLE',
      message: 'The model is temporarily unavailable',
      action: 'retry',
    },
  )
  run.end(0)

  fireEvent.click(await screen.findByRole('button', { name: 'Try again' }))

  await waitFor(() => expect(run.turns).toHaveLength(2))
  expect(run.turns[1]).toMatchObject({ kind: 'retry', threadId: THREAD_ID })
  expect(run.turns[1]).not.toHaveProperty('compactLatest')
  run.emit(
    1,
    {
      type: 'RUN_STARTED',
      threadId: THREAD_ID,
      runId: 'run-retry',
      instance: 'instance-1',
    },
    {
      type: 'RUN_FINISHED',
      threadId: THREAD_ID,
      runId: 'run-retry',
      metadata: {},
    },
  )
  run.end(1)
})

it('asks a harness that keeps the latest exchange to compact what comes before it', async () => {
  signIn({ cloud: true, session: keepingLatest })
  const run = scriptRuns()
  await openChat()

  compactFromIndicator()

  await waitFor(() => expect(run.turns).toHaveLength(1))
  expect(run.turns[0]).toMatchObject({ kind: 'compact', threadId: THREAD_ID })
  expect(run.turns[0]).not.toHaveProperty('compactLatest')
  run.emit(
    0,
    ...started('run-compact', messages, 'u2'),
    {
      type: 'COMPACTION_END',
      messageId: 'c1',
      beforeMessageId: 'u2',
      outcome: 'completed',
      marker,
    },
    {
      type: 'RUN_FINISHED',
      threadId: THREAD_ID,
      runId: 'run-compact',
      metadata: {},
    },
  )
  run.end(0)
  await screen.findByRole('button', { name: 'Compacted 2 earlier messages' })

  // The exchange the harness kept is all that follows its marker.
  fireEvent.click(screen.getByRole('button', { name: USAGE_LABEL }))
  expect(
    within(screen.getByRole('dialog', { name: 'Context window' })).getByRole(
      'button',
      { name: 'Compact chat' },
    ),
  ).toBeDisabled()
})

it('offers a harness that keeps the latest exchange no compaction of a chat with only that exchange', async () => {
  signIn({ cloud: true, session: keepingLatest })
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
