import { ChatMessages } from '@/components/chat/chat-messages'
import { initializeRenderers } from '@/components/chat/renderers/client'
import type { BaseModel } from '@/config/models'
import type { Frame } from '@/services/harness/types'
import { useThread } from '@/services/harness/use-thread'
import { act, render, screen } from '@testing-library/react'
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
      isStreamingResponse={thread.running}
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
      { type: 'RUN_STARTED', threadId, runId: 'run-1' },
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
      event: { type: 'RUN_FINISHED', threadId, runId: 'run-1' },
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
        delta: 'Because.',
        timestamp: at(3),
      },
    ])

    expect(screen.getByText('Because.')).toBeInTheDocument()
    expect(screen.getByText('Thought').closest('button')).toHaveTextContent(
      'Thought for 2.5 seconds',
    )
  })

  it('says how long its steps took together', async () => {
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
        toolCallId: 'search-1',
        content: { query: 'why', results: [] },
        display: { query: 'why', status: 'completed', sources: [] },
        timestamp: at(9),
      },
      {
        type: 'TEXT_MESSAGE_CHUNK',
        messageId: 'm1',
        delta: 'Because.',
        timestamp: at(10),
      },
    ])

    expect(screen.getByText('Worked').closest('button')).toHaveTextContent(
      'Worked for 9.0 seconds',
    )
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
          toolCallId: 'draft-1',
          content: { status: 'error', error: 'The arguments did not match.' },
        },
        { type: 'TEXT_MESSAGE_CHUNK', messageId: 'm1', delta: 'Sorry.' },
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
          toolCallId: 'search-1',
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
          toolCallId: 'read-1',
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
