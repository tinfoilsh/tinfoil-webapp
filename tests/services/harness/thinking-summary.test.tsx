import { ChatMessages } from '@/components/chat/chat-messages'
import { initializeRenderers } from '@/components/chat/renderers/client'
import type { BaseModel } from '@/config/models'
import type { HarnessClient } from '@/services/harness/client'
import { activateAPI, HarnessAPI, publish } from '@/services/harness/runtime'
import type { Frame } from '@/services/harness/types'
import { useThread } from '@/services/harness/use-thread'
import { act, render, screen, waitFor } from '@testing-library/react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { testSession } from '../../harness-fixture'

const summarize = vi.hoisted(() => vi.fn())
vi.mock('@/services/inference/summary-client', () => ({ summarize }))
vi.mock('@/components/chat/genui/registry', () => ({ GENUI_WIDGETS: [] }))
vi.mock('@/hooks/use-chat-print', () => ({ useChatPrint: () => undefined }))
vi.mock('@/utils/error-handling', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarning: vi.fn(),
}))

const models: BaseModel[] = [
  {
    modelName: 'test-model',
    name: 'Test model',
    nameShort: 'Test',
    image: '',
    description: '',
    type: 'chat',
    chat: true,
  },
]
const THOUGHTS = Array.from({ length: 25 }, (_, i) => `step${i}`).join(' ')

let events: ReturnType<typeof vi.fn>
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

function gate() {
  let open!: () => void
  const opened = new Promise<void>((resolve) => {
    open = resolve
  })
  return { opened, open }
}

beforeAll(() => initializeRenderers())

beforeEach(() => {
  sessionStorage.clear()
  summarize.mockReset().mockResolvedValue('Weighing the options')
  events = vi.fn()
  activateAPI(
    new HarnessAPI(
      {
        events,
        post: vi.fn().mockResolvedValue({}),
      } as unknown as HarnessClient,
      null,
    ),
  )
  publish({ session: testSession, keyReady: true, profileReady: true })
})

describe('the live thinking summary', () => {
  it('summarizes reasoning while it streams and stops once the reply moves on', async () => {
    const thinking = gate()
    const answering = gate()
    events.mockImplementation(async function* (_path, input) {
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
        {
          type: 'REASONING_MESSAGE_CHUNK',
          messageId: 'm1-reasoning',
          delta: THOUGHTS,
        },
      ]
      for (const [id, event] of frames.entries()) yield { id, event }
      await thinking.opened
      yield {
        id: 3,
        event: {
          type: 'TEXT_MESSAGE_CHUNK',
          messageId: 'm1',
          delta: 'Because.',
        },
      }
      await answering.opened
      yield {
        id: 4,
        event: { type: 'RUN_FINISHED', threadId, runId: 'run-1' },
      }
    })
    render(<Conversation />)
    let sending!: Promise<unknown>
    act(() => {
      sending = send!()
    })

    expect(await screen.findByText('Weighing the options')).toBeInTheDocument()
    expect(summarize).toHaveBeenCalledExactlyOnceWith({
      content: THOUGHTS,
      style: 'thoughts_summary',
    })

    await act(async () => thinking.open())
    await screen.findByText('Because.')
    await waitFor(() =>
      expect(
        screen.queryByText('Weighing the options'),
      ).not.toBeInTheDocument(),
    )
    expect(summarize).toHaveBeenCalledOnce()

    await act(async () => {
      answering.open()
      await sending
    })
  })
})
