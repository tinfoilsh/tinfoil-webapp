import { ChatMessages } from '@/components/chat/chat-messages'
import { initializeRenderers } from '@/components/chat/renderers/client'
import type { BaseModel } from '@/config/models'
import type { Frame } from '@/services/harness/types'
import { useThread } from '@/services/harness/use-thread'
import { act, render, screen } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { client } from '../../harness-fixture'

vi.mock('@/components/chat/genui/registry', () => ({ GENUI_WIDGETS: [] }))
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

// Sends a question whose reply streams these events, and waits for its run
// to finish.
async function streamReply(events: Frame['event'][]) {
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
      { type: 'RUN_FINISHED', threadId, runId: 'run-1' },
    ]
    for (const [id, event] of frames.entries()) yield { id, event }
  })
  render(<Conversation />)
  await act(async () => {
    await send!()
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
})
