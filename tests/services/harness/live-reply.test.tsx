import { ChatMessages } from '@/components/chat/chat-messages'
import { initializeRenderers } from '@/components/chat/renderers/client'
import type { BaseModel } from '@/config/models'
import type { Frame, Message } from '@/services/harness/types'
import { useThread } from '@/services/harness/use-thread'
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { client } from '../../harness-fixture'

vi.mock('@/hooks/use-chat-print', () => ({ useChatPrint: () => undefined }))
vi.mock('@/utils/error-handling', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarning: vi.fn(),
}))

const models: BaseModel[] = [
  {
    id: 'test-model',
    label: 'Test model',
    shortLabel: 'Test',
    icon: '',
    description: '',
    badges: [],
    reasoning: null,
    deprecated: false,
  },
]

let send: (() => Promise<unknown>) | undefined

function Conversation() {
  const thread = useThread()
  send = () => Promise.resolve(thread.send({ content: 'Why?' }))
  if (!thread.chat.messages.length) return null
  return (
    <ChatMessages
      chatId={thread.chat.id}
      messages={thread.chat.messages}
      compactions={thread.compactions}
      isStreamingResponse={thread.running}
      isWaitingForResponse={
        thread.running && thread.chat.messages.at(-1)?.role !== 'assistant'
      }
      isDarkMode={false}
      models={models}
      selectedModel="test-model"
      autoIntelligence="high"
      setAutoIntelligence={() => {}}
    />
  )
}

// An instant of the reply, `seconds` after it began.
const at = (seconds: number) =>
  new Date(Date.UTC(2026, 9, 1) + seconds * 1000).toISOString()

// Sends a question whose reply streams these events, and finishes its run
// once `finish` settles. Resolves once the run finished.
function sendReply(
  events: Frame['event'][],
  finish: Promise<void> = Promise.resolve(),
) {
  client.events.mockImplementation(async function* (_path, input) {
    const threadId = input.threadId as string
    const frames: Frame['event'][] = [
      { type: 'RUN_STARTED', threadId, runId: 'run-1', instance: 'instance-1' },
      {
        type: 'MESSAGES_SNAPSHOT',
        messages: [
          { id: 'u1', role: 'user', createdAt: 't0', content: 'Why?' },
        ],
        hasOlder: false,
      },
      ...events,
    ]
    for (const [id, event] of frames.entries()) yield { id, event }
    await finish
    yield {
      id: frames.length,
      event: { type: 'RUN_FINISHED', threadId, runId: 'run-1', metadata: {} },
    }
  })
  render(<Conversation />)
  let sending!: Promise<unknown>
  act(() => {
    sending = send!()
  })
  return sending
}

async function streamReply(events: Frame['event'][]) {
  const sending = sendReply(events)
  await act(async () => {
    await sending
  })
}

beforeAll(() => initializeRenderers())

describe('a streamed reply', () => {
  it('says how long its reasoning took', async () => {
    await streamReply([
      {
        type: 'REASONING_MESSAGE_CHUNK',
        messageId: 'm1-reasoning',
        delta: 'Plan',
        timestamp: at(0),
      },
      {
        type: 'REASONING_MESSAGE_CHUNK',
        messageId: 'm1-reasoning',
        delta: 'ning',
        timestamp: at(2.5),
      },
      {
        type: 'TEXT_MESSAGE_CHUNK',
        messageId: 'm1',
        role: 'assistant',
        delta: 'Because.',
        timestamp: at(3),
      },
    ])

    expect(screen.getByText('Because.')).toBeInTheDocument()
    expect(screen.getByText('Thought').closest('button')).toHaveTextContent(
      'Thought for 2s',
    )
  })

  it('names the steps it took, and how long it thought', async () => {
    await streamReply([
      {
        type: 'REASONING_MESSAGE_CHUNK',
        messageId: 'm1-reasoning',
        delta: 'Look it up',
        timestamp: at(0),
      },
      {
        type: 'REASONING_MESSAGE_CHUNK',
        messageId: 'm1-reasoning',
        delta: '.',
        timestamp: at(1),
      },
      {
        type: 'TOOL_CALL_START',
        parentMessageId: 'm1',
        toolCallId: 'search-1',
        toolCallName: 'web_search',
        timestamp: at(2),
      },
      {
        type: 'TOOL_CALL_RESULT',
        messageId: 'tool-search-1',
        toolCallId: 'search-1',
        role: 'tool',
        content: { query: 'why', results: [] },
        display: { query: 'why', status: 'completed', sources: [] },
        timestamp: at(9),
      },
      {
        type: 'TEXT_MESSAGE_CHUNK',
        messageId: 'm1',
        role: 'assistant',
        delta: 'Because.',
        timestamp: at(10),
      },
    ])

    expect(
      screen.getByRole('button', { name: 'Thought and searched the web' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Thought for 1s' }),
    ).toBeInTheDocument()
  })

  it('shows a widget the harness refused as it streams', async () => {
    const draft = JSON.stringify({
      channel: 'message',
      title: 'Reply draft',
      variants: [{ label: 'Concise', body: 'Thanks.' }],
    })
    let finish!: () => void
    const sending = sendReply(
      [
        {
          type: 'TOOL_CALL_START',
          parentMessageId: 'm1',
          toolCallId: 'draft-1',
          toolCallName: 'render_message_compose',
        },
        { type: 'TOOL_CALL_ARGS', toolCallId: 'draft-1', delta: draft },
        { type: 'TOOL_CALL_END', toolCallId: 'draft-1' },
        {
          type: 'TOOL_CALL_RESULT',
          messageId: 'tool-draft-1',
          toolCallId: 'draft-1',
          role: 'tool',
          content: { status: 'error', error: 'The arguments did not match.' },
        },
        {
          type: 'TEXT_MESSAGE_CHUNK',
          messageId: 'm1',
          role: 'assistant',
          delta: 'Sorry.',
        },
      ],
      new Promise((resolve) => {
        finish = resolve
      }),
    )

    // Every frame before the run's end has applied once the reply's text shows.
    expect(await screen.findByText('Sorry.')).toBeInTheDocument()
    expect(
      screen.getByText("Couldn't display message compose"),
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        "The component data doesn't match the message compose component.",
      ),
    ).toBeInTheDocument()
    expect(screen.queryByText('Reply draft')).not.toBeInTheDocument()

    await act(async () => {
      finish()
      await sending
    })
    expect(
      screen.getByText("Couldn't display message compose"),
    ).toBeInTheDocument()
  })

  it('shows a page read once its arguments name the page', async () => {
    let name!: () => void
    const named = new Promise<void>((resolve) => {
      name = resolve
    })
    let finish!: () => void
    const finished = new Promise<void>((resolve) => {
      finish = resolve
    })
    client.events.mockImplementation(async function* (_path, input) {
      const threadId = input.threadId as string
      const events: Frame['event'][] = [
        {
          type: 'RUN_STARTED',
          threadId,
          runId: 'run-1',
          instance: 'instance-1',
        },
        {
          type: 'TEXT_MESSAGE_CHUNK',
          messageId: 'm1',
          role: 'assistant',
          delta: 'Reading.',
        },
        {
          type: 'TOOL_CALL_START',
          parentMessageId: 'm1',
          toolCallId: 'read-1',
          toolCallName: 'web_fetch',
        },
        { type: 'TOOL_CALL_ARGS', toolCallId: 'read-1', delta: '{"url": "ht' },
      ]
      for (const [id, event] of events.entries()) yield { id, event }
      await named
      yield {
        id: events.length,
        event: {
          type: 'TOOL_CALL_ARGS',
          toolCallId: 'read-1',
          delta: 'tps://docs.example/page"}',
        },
      }
      await finished
      yield {
        id: events.length + 1,
        event: { type: 'RUN_FINISHED', threadId, runId: 'run-1', metadata: {} },
      }
    })
    render(<Conversation />)
    let sending!: Promise<unknown>
    act(() => {
      sending = send!()
    })

    expect(await screen.findByText('Reading.')).toBeInTheDocument()
    expect(screen.queryByText(/^Reading \d+ link/)).not.toBeInTheDocument()
    expect(
      client.post.mock.calls.filter(
        ([path]) => path === '/v1/metadata/favicon',
      ),
    ).toEqual([])

    await act(async () => name())
    expect(await screen.findByText('Reading 1 link')).toBeInTheDocument()

    await act(async () => {
      finish()
      await sending
    })
  })

  it('shows links to the pages it found as citations while it streams', async () => {
    let finish!: () => void
    const sending = sendReply(
      [
        {
          type: 'TOOL_CALL_START',
          parentMessageId: 'm1',
          toolCallId: 'search-1',
          toolCallName: 'web_search',
        },
        {
          type: 'TOOL_CALL_RESULT',
          messageId: 'tool-search-1',
          toolCallId: 'search-1',
          role: 'tool',
          content: { query: 'tinfoil', results: [] },
          display: {
            query: 'tinfoil',
            status: 'completed',
            sources: [{ url: 'https://tinfoil.sh/', title: 'Tinfoil' }],
          },
        },
        {
          type: 'TOOL_CALL_START',
          parentMessageId: 'm1',
          toolCallId: 'read-1',
          toolCallName: 'web_fetch',
        },
        {
          type: 'TOOL_CALL_RESULT',
          messageId: 'tool-read-1',
          toolCallId: 'read-1',
          role: 'tool',
          content: { pages: [], failed: [] },
          display: {
            url: 'https://docs.example/page',
            status: 'completed',
            sources: [
              { url: 'https://docs.example/page', title: 'Fetched page' },
            ],
          },
        },
        {
          type: 'TEXT_MESSAGE_CHUNK',
          messageId: 'm1',
          role: 'assistant',
          delta:
            'See [Tinfoil](https://tinfoil.sh/), [the docs](https://docs.example/page) and [elsewhere](https://other.example/).',
        },
      ],
      new Promise((resolve) => {
        finish = resolve
      }),
    )

    expect(
      await screen.findByRole('link', { name: 'tinfoil' }),
    ).toHaveAttribute('href', 'https://tinfoil.sh/')
    expect(screen.getByRole('link', { name: 'docs' })).toHaveAttribute(
      'href',
      'https://docs.example/page',
    )
    expect(screen.getByRole('link', { name: 'elsewhere' })).toHaveAttribute(
      'href',
      'https://other.example/',
    )
    expect(
      screen.queryByRole('link', { name: 'Tinfoil' }),
    ).not.toBeInTheDocument()

    await act(async () => {
      finish()
      await sending
    })
  })
})

describe('the views of a streaming chat', () => {
  it('rebuilds only the views of the messages that changed', async () => {
    let answer!: () => void
    let finish!: () => void
    const answered = new Promise<void>((resolve) => {
      answer = resolve
    })
    const finished = new Promise<void>((resolve) => {
      finish = resolve
    })
    client.events.mockImplementation(async function* (_path, input) {
      const threadId = input.threadId as string
      yield {
        id: 0,
        event: {
          type: 'RUN_STARTED',
          threadId,
          runId: 'run-1',
          instance: 'instance-1',
        },
      }
      yield {
        id: 1,
        event: {
          type: 'MESSAGES_SNAPSHOT',
          messages: [
            { id: 'u1', role: 'user', createdAt: 't0', content: 'Why?' },
          ],
          hasOlder: false,
        },
      }
      yield {
        id: 2,
        event: {
          type: 'REASONING_MESSAGE_CHUNK',
          messageId: 'm1-reasoning',
          delta: 'Hmm',
        },
      }
      await answered
      yield {
        id: 3,
        event: {
          type: 'REASONING_MESSAGE_CHUNK',
          messageId: 'm1-reasoning',
          delta: '.',
        },
      }
      await finished
      yield {
        id: 4,
        event: { type: 'RUN_FINISHED', threadId, runId: 'run-1', metadata: {} },
      }
    })
    const { result } = renderHook(() => useThread())
    let sending!: Promise<unknown>
    act(() => {
      sending = Promise.resolve(result.current.send({ content: 'Why?' }))
    })
    const thought = () => result.current.chat.messages[1]?.timeline?.[0]
    await waitFor(() => expect(thought()).toMatchObject({ content: 'Hmm' }))
    const [question, reply] = result.current.chat.messages

    await act(async () => answer())
    await waitFor(() => expect(thought()).toMatchObject({ content: 'Hmm.' }))
    expect(result.current.chat.messages[0]).toBe(question)
    expect(result.current.chat.messages[1]).not.toBe(reply)
    expect(thought()).toMatchObject({ isThinking: true })

    await act(async () => {
      finish()
      await sending
    })
    expect(result.current.chat.messages[0]).toBe(question)
    expect(thought()).toMatchObject({ content: 'Hmm.', isThinking: false })
  })
})

describe('a chat compacted for a reply', () => {
  const question = (id: string, content: string): Message => ({
    id,
    role: 'user',
    createdAt: '2026-10-01T00:00:00Z',
    content,
  })
  const answer = (id: string, content: string): Message => ({
    id,
    role: 'assistant',
    createdAt: '2026-10-01T00:00:01Z',
    timeline: [{ id: `${id}-text`, type: 'content', content }],
  })
  const marker = (id: string, messages: number, content: string): Message => ({
    id,
    role: 'compaction',
    createdAt: '2026-10-01T00:00:02Z',
    content,
    compaction: {
      messages,
      startedAt: 1,
      endedAt: 2,
      model: 'long-summary',
      version: 1,
    },
  })
  // A chat compacted once already, whose next question compacts it again.
  const window = [
    question('u0', 'Where do we start?'),
    answer('a0', 'At the beginning.'),
    marker('c0', 2, 'An earlier summary.'),
    question('u1', 'And then?'),
    answer('a1', 'Then the middle.'),
    question('u2', 'Why?'),
  ]
  const summary =
    '## Goals and context\nThe user is walking through a story.\n\n## Open threads\nWhy it ends.'

  it('shows the summary that replaced the messages above, which the model no longer reads', async () => {
    let summarize!: () => void
    const summarized = new Promise<void>((resolve) => {
      summarize = resolve
    })
    client.events.mockImplementation(async function* (_path, input) {
      const threadId = input.threadId as string
      const frames: Frame['event'][] = [
        {
          type: 'RUN_STARTED',
          threadId,
          runId: 'run-1',
          instance: 'instance-1',
        },
        { type: 'MESSAGES_SNAPSHOT', messages: window, hasOlder: false },
        {
          type: 'COMPACTION_START',
          messageId: 'c1',
          beforeMessageId: 'u2',
          timestamp: at(0),
        },
      ]
      for (const [id, event] of frames.entries()) yield { id, event }
      await summarized
      yield {
        id: 3,
        event: {
          type: 'COMPACTION_END',
          messageId: 'c1',
          outcome: 'completed',
          marker: marker('c1', 4, summary),
        },
      }
      yield {
        id: 4,
        event: {
          type: 'TEXT_MESSAGE_CHUNK',
          messageId: 'm1',
          role: 'assistant',
          delta: 'Because.',
        },
      }
      yield {
        id: 5,
        event: { type: 'RUN_FINISHED', threadId, runId: 'run-1', metadata: {} },
      }
    })
    render(<Conversation />)
    let sending!: Promise<unknown>
    act(() => {
      sending = send!()
    })
    const outOfContext = (text: string) =>
      screen.getByText(text).closest('[role="article"]')

    const compacting = await screen.findByRole('note', {
      name: 'Earlier messages above are being summarized for the assistant',
    })
    expect(compacting).toHaveTextContent('Compacting conversation')
    expect(
      screen.getByRole('status', { name: 'Compacting conversation' }),
    ).toBeInTheDocument()
    // A summary still being written may fail, so only the messages the
    // earlier marker covers are out of context yet.
    expect(outOfContext('At the beginning.')).toHaveAttribute(
      'data-out-of-context',
    )
    expect(outOfContext('Then the middle.')).not.toHaveAttribute(
      'data-out-of-context',
    )
    expect(outOfContext('Why?')).not.toHaveAttribute('data-out-of-context')

    await act(async () => {
      summarize()
      await sending
    })

    const notes = screen.getAllByRole('note', {
      name: 'Earlier messages above were summarized and are no longer read by the assistant',
    })
    expect(notes).toHaveLength(2)
    // The earlier marker is above the latest one, so the model no longer
    // reads it either.
    expect(notes[0]).toHaveAttribute('data-out-of-context')
    expect(notes[1]).not.toHaveAttribute('data-out-of-context')
    const header = screen.getByRole('button', {
      name: 'Compacted 4 earlier messages',
    })
    expect(notes[1]).toContainElement(header)
    const details = document.getElementById(
      header.getAttribute('aria-controls')!,
    )
    expect(details).toHaveAttribute('inert')
    fireEvent.click(header)
    expect(header).toHaveAttribute('aria-expanded', 'true')
    expect(details).not.toHaveAttribute('inert')
    expect(details).toContainElement(
      screen.getByRole('heading', { name: 'Open threads' }),
    )

    for (const text of [
      'Where do we start?',
      'At the beginning.',
      'And then?',
      'Then the middle.',
    ])
      expect(outOfContext(text)).toHaveAttribute('data-out-of-context')
    for (const text of ['Why?', 'Because.'])
      expect(outOfContext(text)).not.toHaveAttribute('data-out-of-context')
    expect(
      screen.queryByRole('status', { name: 'Compacting conversation' }),
    ).not.toBeInTheDocument()
  })
})
