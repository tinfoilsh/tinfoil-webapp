import { ChatMessages } from '@/components/chat/chat-messages'
import { initializeRenderers } from '@/components/chat/renderers/client'
import type { BaseModel } from '@/config/models'
import {
  localThreadStore,
  type LocalThread,
} from '@/services/harness/local-threads'
import { getView } from '@/services/harness/runtime'
import { HarnessError } from '@/services/harness/sse'
import type { Frame, Message, Thread, Turn } from '@/services/harness/types'
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
import { testSession } from '../../harness-fixture'
import {
  client,
  KEY,
  resetChatStoresAroundEachTest,
  signIn,
} from './thread-fixture'

vi.mock('@/components/chat/genui/registry', () => ({
  GENUI_WIDGETS: [{ name: 'render_chart' }],
}))
vi.mock('@/utils/error-handling', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarning: vi.fn(),
}))
vi.mock('@/hooks/use-chat-print', () => ({ useChatPrint: () => undefined }))

const THREAD_ID = '8233746419000_1c4e7a52-9a2b-4f7e-8d1a-5b6c7d8e9f00'
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

const session = { ...testSession, widgets: ['render_chart'] }

const transcript: LocalThread['messages'] = [
  { id: 'u1', role: 'user', createdAt: '2026-04-01T09:00:00Z', content: 'one' },
  {
    id: 'a1',
    role: 'assistant',
    createdAt: '2026-04-01T09:00:01Z',
    content: 'first answer',
    timeline: [{ id: 'b1', type: 'content', content: 'first answer' }],
  },
  { id: 'u2', role: 'user', createdAt: '2026-04-01T09:01:00Z', content: 'two' },
  {
    id: 'a2',
    role: 'assistant',
    createdAt: '2026-04-01T09:01:01Z',
    content: 'second answer',
    timeline: [{ id: 'b2', type: 'content', content: 'second answer' }],
  },
]

const wire = (message: LocalThread['messages'][number]): Message =>
  message.role === 'assistant'
    ? {
        id: message.id,
        role: 'assistant',
        createdAt: message.createdAt,
        timeline: message.timeline,
      }
    : {
        id: message.id,
        role: 'user',
        createdAt: message.createdAt,
        content: message.content,
      }

function storedThread(messages = transcript): LocalThread {
  return {
    id: THREAD_ID,
    title: 'Numbers',
    titleState: 'generated',
    createdAt: '2026-04-01T09:00:00Z',
    updatedAt: '2026-04-01T09:01:01Z',
    model: 'test-model',
    codeExecutionAccessToken: 'c'.repeat(64),
    messages,
  }
}

function cloudThread(messages = transcript): Thread {
  return {
    id: THREAD_ID,
    title: 'Numbers',
    titleState: 'generated',
    createdAt: '2026-04-01T09:00:00Z',
    updatedAt: '2026-04-01T09:01:01Z',
    model: 'test-model',
    projectId: null,
    pinned: false,
    webSearchEnabled: true,
    messageCount: messages.length,
    activeRun: null,
    hasOlder: false,
    messages: messages.map(wire),
  }
}

function regenerated(window: Message[]) {
  return async function* (): AsyncGenerator<Frame> {
    const events: Frame['event'][] = [
      { type: 'RUN_STARTED', threadId: THREAD_ID, runId: 'run-regen' },
      { type: 'MESSAGES_SNAPSHOT', messages: window, hasOlder: false },
      {
        type: 'TEXT_MESSAGE_CHUNK',
        messageId: 'msg_regen',
        delta: 'new answer',
        timestamp: '2026-04-01T09:02:00Z',
      },
      { type: 'RUN_FINISHED', threadId: THREAD_ID, runId: 'run-regen' },
    ]
    for (const [id, event] of events.entries()) yield { id, event }
  }
}

const turn = (call = 0) => client.events.mock.calls[call][1] as Turn

function Conversation({ local }: { local: boolean }) {
  const thread = useThread(THREAD_ID, null, { local })
  // A blank chat shows the welcome screen, which needs a Clerk session.
  if (!thread.chat.messages.length) return null
  return (
    <ChatMessages
      chatId={thread.chat.id}
      messages={thread.chat.messages}
      isDarkMode={false}
      models={models}
      selectedModel="test-model"
      autoIntelligence="high"
      setAutoIntelligence={() => {}}
      onRegenerateMessage={(index) => void thread.regenerate(index)}
    />
  )
}

resetChatStoresAroundEachTest()
beforeAll(() => {
  initializeRenderers()
})

describe('regenerating a reply', () => {
  it("names the reply when a stored chat's Regenerate buttons are used", async () => {
    signIn({ cloud: true, session })
    client.post.mockImplementation(async (path: string) =>
      path === '/v1/threads/get'
        ? cloudThread()
        : path === '/v1/threads/list'
          ? { threads: [], nextCursor: null }
          : {},
    )
    client.events.mockImplementation(
      regenerated(transcript.slice(0, 3).map(wire)),
    )
    render(<Conversation local={false} />)
    await screen.findByText('second answer')

    const regenerateButtons = () =>
      screen.getAllByRole('button', { name: 'Regenerate response' })
    // One under each user message, and one under the last reply.
    expect(regenerateButtons()).toHaveLength(3)
    fireEvent.click(regenerateButtons()[2])
    await screen.findByText('new answer')
    fireEvent.click(regenerateButtons()[1])
    await waitFor(() => expect(client.events).toHaveBeenCalledTimes(2))

    for (const call of [0, 1]) {
      expect(client.events.mock.calls[call][0]).toBe('/v1/threads/turn')
      expect(turn(call)).toEqual({
        clientRequestId: expect.any(String),
        threadId: THREAD_ID,
        key: KEY,
        ephemeral: false,
        kind: 'regenerate',
        messageId: call === 0 ? 'a2' : 'msg_regen',
        content: '',
        widgets: ['render_chart'],
        options: { model: 'test-model', timezone: expect.any(String) },
      })
    }
  })

  it("regenerates a local chat's reply and stores the new one in its place", async () => {
    signIn({ cloud: false, session })
    await localThreadStore('device').update(THREAD_ID, () => storedThread())
    client.events.mockImplementation(
      regenerated(transcript.slice(0, 3).map(wire)),
    )
    const { result } = renderHook(() =>
      useThread(THREAD_ID, null, { local: true }),
    )
    await waitFor(() => expect(result.current.chat.messages).toHaveLength(4))

    // The user message's index, as its Regenerate button passes it.
    await act(() => result.current.regenerate(2))

    expect(turn()).toMatchObject({
      kind: 'regenerate',
      messageId: 'a2',
      local: true,
      threadId: THREAD_ID,
    })
    expect(turn()).not.toHaveProperty('key')
    expect(turn().thread?.messages.map((message) => message.id)).toEqual([
      'u1',
      'a1',
      'u2',
      'a2',
    ])
    const saved = await localThreadStore('device').get(THREAD_ID)
    expect(
      saved?.messages.map((message) => [message.id, message.content]),
    ).toEqual([
      ['u1', 'one'],
      ['a1', 'first answer'],
      ['u2', 'two'],
      ['msg_regen', 'new answer'],
    ])
  })

  it('sends a user message without a reply again as an edit of its text', async () => {
    signIn({ cloud: false, session })
    await localThreadStore('device').update(THREAD_ID, () =>
      storedThread(transcript.slice(0, 3)),
    )
    client.events.mockImplementation(
      regenerated(transcript.slice(0, 2).map(wire)),
    )
    const { result } = renderHook(() =>
      useThread(THREAD_ID, null, { local: true }),
    )
    await waitFor(() => expect(result.current.chat.messages).toHaveLength(3))

    await act(() => result.current.regenerate(2))

    expect(turn()).toMatchObject({
      kind: 'edit',
      messageId: 'u2',
      content: 'two',
    })
  })

  it('stops the run in progress before regenerating', async () => {
    signIn({ cloud: true, session })
    client.post.mockImplementation(async (path: string) =>
      path === '/v1/threads/get'
        ? { ...cloudThread(), activeRun: { runId: 'run-1', lastEventId: 0 } }
        : path === '/v1/threads/list'
          ? { threads: [], nextCursor: null }
          : {},
    )
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    client.events.mockImplementationOnce(async function* () {
      yield {
        id: 0,
        event: { type: 'RUN_STARTED', threadId: THREAD_ID, runId: 'run-1' },
      }
      await held
    })
    client.events.mockImplementationOnce(
      regenerated(transcript.slice(0, 3).map(wire)),
    )
    const { result } = renderHook(() => useThread(THREAD_ID, null))
    await waitFor(() => expect(result.current.running).toBe(true))

    await act(() => result.current.regenerate(3))

    const cancel = client.post.mock.calls.findIndex(
      ([path]) => path === '/v1/threads/cancel',
    )
    expect(cancel).toBeGreaterThanOrEqual(0)
    expect(client.post.mock.calls[cancel][1]).toEqual({
      key: KEY,
      threadId: THREAD_ID,
      runId: 'run-1',
    })
    expect(client.post.mock.invocationCallOrder[cancel]).toBeLessThan(
      client.events.mock.invocationCallOrder[1],
    )
    expect(turn(1)).toMatchObject({ kind: 'regenerate', messageId: 'a2' })
    release()
  })
})

describe('retrying after an error', () => {
  function openCloud() {
    signIn({ cloud: true, session })
    client.post.mockImplementation(async (path: string) =>
      path === '/v1/threads/get'
        ? cloudThread(transcript.slice(0, 2))
        : path === '/v1/threads/list'
          ? { threads: [], nextCursor: null }
          : {},
    )
    return renderHook(() => useThread(THREAD_ID, null))
  }

  it('runs a failed reply again instead of rejoining its finished run', async () => {
    const { result } = openCloud()
    await waitFor(() => expect(result.current.chat.messages).toHaveLength(2))
    client.events.mockImplementationOnce(async function* () {
      const events: Frame['event'][] = [
        { type: 'RUN_STARTED', threadId: THREAD_ID, runId: 'run-1' },
        {
          type: 'MESSAGES_SNAPSHOT',
          messages: transcript.slice(0, 3).map(wire),
          hasOlder: false,
        },
        { type: 'TEXT_MESSAGE_CHUNK', messageId: 'msg_err', delta: 'Half' },
        {
          type: 'RUN_ERROR',
          threadId: THREAD_ID,
          runId: 'run-1',
          code: 'MODEL_UNAVAILABLE',
          message: 'The model is temporarily unavailable',
        },
      ]
      for (const [id, event] of events.entries()) yield { id, event }
    })
    client.events.mockImplementationOnce(
      regenerated(transcript.slice(0, 3).map(wire)),
    )
    await act(() => result.current.send({ content: 'two' }))
    expect(result.current.state.error).toEqual({
      code: 'MODEL_UNAVAILABLE',
      message: 'The model is temporarily unavailable',
    })

    await act(() => result.current.retry())

    expect(client.events.mock.calls[1][0]).toBe('/v1/threads/turn')
    expect(turn(1)).toMatchObject({ kind: 'regenerate', messageId: 'msg_err' })
    expect(result.current.chat.messages.at(-1)?.content).toBe('new answer')
  })

  it('sends a refused turn again with its nonce rather than following the previous run', async () => {
    const { result } = openCloud()
    await waitFor(() => expect(result.current.chat.messages).toHaveLength(2))
    client.events.mockImplementationOnce(
      regenerated(transcript.slice(0, 2).map(wire)),
    )
    await act(() => result.current.send({ content: 'first' }))
    client.events.mockImplementationOnce(async function* () {
      throw new HarnessError(
        {
          code: 'RATE_LIMITED',
          message: 'Chat access is busy; retry shortly',
          retryAfter: 2,
        },
        429,
      )
    })
    await act(() => result.current.send({ content: 'second' }))
    expect(result.current.state.error).toMatchObject({
      code: 'RATE_LIMITED',
      retryAfter: 2,
    })
    expect(result.current.errorAt).toBeGreaterThan(0)
    client.events.mockImplementationOnce(
      regenerated(transcript.slice(0, 3).map(wire)),
    )

    await act(() => result.current.retry())

    expect(client.events.mock.calls[2][0]).toBe('/v1/threads/turn')
    expect(turn(2)).toEqual({ ...turn(1), key: KEY })
    expect(turn(2).content).toBe('second')
  })

  it('records the exhausted quota a refused turn names', async () => {
    const { result } = openCloud()
    await waitFor(() => expect(result.current.chat.messages).toHaveLength(2))
    client.events.mockImplementationOnce(async function* () {
      throw new HarnessError(
        {
          code: 'QUOTA_EXHAUSTED',
          message: 'The hourly usage limit is reached',
          kind: 'hourly',
          resetsAt: '2026-07-24T11:00:00Z',
          retryAfter: 900,
        },
        429,
      )
    })

    await act(() => result.current.send({ content: 'more' }))

    expect(getView().rateLimit).toEqual({
      kind: 'hourly',
      maxRequests: 0,
      remaining: 0,
      resetsAt: '2026-07-24T11:00:00Z',
    })
  })
})

describe('changing messages of a stored chat', () => {
  function openCloud() {
    signIn({ cloud: true, session })
    client.post.mockImplementation(async (path: string, input: unknown) => {
      if (path === '/v1/threads/get')
        return (input as { id: string }).id === THREAD_ID
          ? cloudThread()
          : { ...cloudThread(transcript.slice(0, 2)), id: 'fork-1' }
      if (path === '/v1/threads/list') return { threads: [], nextCursor: null }
      if (path === '/v1/threads/messages/delete')
        return cloudThread([transcript[0], transcript[2], transcript[3]])
      if (path === '/v1/threads/messages/update')
        return cloudThread([
          ...transcript.slice(0, 3),
          {
            ...transcript[3],
            timeline: [{ id: 'b2', type: 'content', content: 'Better' }],
          },
        ])
      if (path === '/v1/threads/fork')
        return {
          ...cloudThread(transcript.slice(0, 2)),
          id: 'fork-1',
          title: 'Numbers (fork)',
          messages: undefined,
        }
      return {}
    })
    return renderHook(() => useThread(THREAD_ID, null))
  }
  const posted = (path: string) =>
    client.post.mock.calls.filter(([called]) => called === path)

  it('deletes a message through the harness and shows its window', async () => {
    const { result } = openCloud()
    await waitFor(() => expect(result.current.chat.messages).toHaveLength(4))

    await act(() => result.current.deleteMessage(1))

    expect(posted('/v1/threads/messages/delete')).toEqual([
      [
        '/v1/threads/messages/delete',
        { key: KEY, threadId: THREAD_ID, messageId: 'a1' },
        expect.any(AbortSignal),
      ],
    ])
    expect(result.current.chat.messages.map((m) => m.id)).toEqual([
      'u1',
      'u2',
      'a2',
    ])
    expect(result.current.chat.messageCount).toBe(3)
  })

  it("rewrites a reply's text through the harness", async () => {
    const { result } = openCloud()
    await waitFor(() => expect(result.current.chat.messages).toHaveLength(4))

    await act(() => result.current.editReply(3, 'Better'))

    expect(posted('/v1/threads/messages/update')).toEqual([
      [
        '/v1/threads/messages/update',
        { key: KEY, threadId: THREAD_ID, messageId: 'a2', content: 'Better' },
        expect.any(AbortSignal),
      ],
    ])
    expect(result.current.chat.messages[3].content).toBe('Better')
  })

  it('does not edit a user message in place', async () => {
    const { result } = openCloud()
    await waitFor(() => expect(result.current.chat.messages).toHaveLength(4))

    await act(() => result.current.editReply(2, 'Changed question'))

    expect(posted('/v1/threads/messages/update')).toEqual([])
    expect(result.current.chat.messages[2].content).toBe('two')
  })

  it('forks through the harness and opens the fork', async () => {
    const { result } = openCloud()
    await waitFor(() => expect(result.current.chat.messages).toHaveLength(4))

    let forkId: string | null = null
    await act(async () => {
      forkId = await result.current.fork(1)
    })

    expect(forkId).toBe('fork-1')
    expect(posted('/v1/threads/fork')).toEqual([
      [
        '/v1/threads/fork',
        { key: KEY, threadId: THREAD_ID, messageId: 'a1' },
        expect.any(AbortSignal),
      ],
    ])
    expect(result.current.chat.id).toBe('fork-1')
    expect(result.current.chat.messages.map((m) => m.id)).toEqual(['u1', 'a1'])
    expect(result.current.threads.map((t) => t.id)).toEqual(['fork-1'])
  })

  it('continues a reply in place', async () => {
    const { result } = openCloud()
    await waitFor(() => expect(result.current.chat.messages).toHaveLength(4))
    client.events.mockImplementationOnce(async function* () {
      const events: Frame['event'][] = [
        {
          type: 'RUN_STARTED',
          threadId: THREAD_ID,
          runId: 'run-continue',
          messageId: 'a1',
        },
        {
          type: 'MESSAGES_SNAPSHOT',
          messages: transcript.slice(0, 2).map(wire),
          hasOlder: false,
        },
        { type: 'TEXT_MESSAGE_CHUNK', messageId: 'a1', delta: ', continued' },
        { type: 'RUN_FINISHED', threadId: THREAD_ID, runId: 'run-continue' },
      ]
      for (const [id, event] of events.entries()) yield { id, event }
    })

    await act(() => result.current.continueReply(1))

    expect(turn()).toMatchObject({
      kind: 'continue',
      messageId: 'a1',
      threadId: THREAD_ID,
      key: KEY,
    })
    expect(result.current.chat.messages.map((m) => [m.id, m.content])).toEqual([
      ['u1', 'one'],
      ['a1', 'first answer, continued'],
    ])
  })
})

describe('changing messages of a local chat', () => {
  async function openLocal(messages = transcript) {
    signIn({ cloud: false, session })
    await localThreadStore('device').update(THREAD_ID, () =>
      storedThread(messages),
    )
    const hook = renderHook(() => useThread(THREAD_ID, null, { local: true }))
    await waitFor(() =>
      expect(hook.result.current.chat.messages).toHaveLength(messages.length),
    )
    return hook
  }
  const saved = () => localThreadStore('device').get(THREAD_ID)

  it('deletes a message from the stored copy without the harness', async () => {
    const { result } = await openLocal()

    await act(() => result.current.deleteMessage(2))

    expect((await saved())?.messages.map((m) => m.id)).toEqual([
      'u1',
      'a1',
      'a2',
    ])
    expect(result.current.chat.messages.map((m) => m.id)).toEqual([
      'u1',
      'a1',
      'a2',
    ])
    expect(client.post).not.toHaveBeenCalled()
  })

  it('keeps the last message', async () => {
    const { result } = await openLocal(transcript.slice(0, 1))

    await act(() => result.current.deleteMessage(0))

    expect((await saved())?.messages.map((m) => m.id)).toEqual(['u1'])
  })

  it("rewrites a reply's text in its copy, which the next turn sends", async () => {
    const { result } = await openLocal([
      ...transcript.slice(0, 3),
      {
        ...transcript[3],
        timeline: [
          { id: 't2', type: 'thinking', content: 'hmm' },
          { id: 'b2', type: 'content', content: 'second ' },
          { id: 'b3', type: 'content', content: 'answer' },
        ],
      },
    ])

    await act(() => result.current.editReply(3, 'Better'))

    const edited = (await saved())?.messages[3]
    expect(edited).toMatchObject({
      id: 'a2',
      content: 'Better',
      timeline: [
        { id: 't2', type: 'thinking', content: 'hmm' },
        { id: 'b2', type: 'content', content: 'Better' },
      ],
    })
    expect(result.current.chat.messages[3].content).toBe('Better')
    expect(client.post).not.toHaveBeenCalled()

    client.events.mockImplementationOnce(regenerated([...transcript.map(wire)]))
    await act(() => result.current.send({ content: 'three' }))
    expect(turn().thread?.messages[3]).toMatchObject({
      id: 'a2',
      content: 'Better',
    })
  })

  it('continues a reply with its transcript and drops what followed it', async () => {
    const { result } = await openLocal()
    client.events.mockImplementationOnce(async function* () {
      const events: Frame['event'][] = [
        {
          type: 'RUN_STARTED',
          threadId: THREAD_ID,
          runId: 'run-continue',
          messageId: 'a1',
        },
        {
          type: 'MESSAGES_SNAPSHOT',
          messages: transcript.slice(0, 2).map(wire),
          hasOlder: false,
        },
        { type: 'TEXT_MESSAGE_CHUNK', messageId: 'a1', delta: ', continued' },
        {
          type: 'RUN_FINISHED',
          threadId: THREAD_ID,
          runId: 'run-continue',
          metadata: { messages: [{ id: 'a1', model: 'test-model' }] },
        },
      ]
      for (const [id, event] of events.entries()) yield { id, event }
    })

    await act(() => result.current.continueReply(1))

    expect(turn()).toMatchObject({
      kind: 'continue',
      messageId: 'a1',
      local: true,
    })
    expect(turn().thread?.messages.map((m) => m.id)).toEqual([
      'u1',
      'a1',
      'u2',
      'a2',
    ])
    expect((await saved())?.messages.map((m) => [m.id, m.content])).toEqual([
      ['u1', 'one'],
      ['a1', 'first answer, continued'],
    ])
  })

  it('continues a failed continuation again on retry', async () => {
    const { result } = await openLocal()
    client.events.mockImplementationOnce(async function* () {
      const events: Frame['event'][] = [
        {
          type: 'RUN_STARTED',
          threadId: THREAD_ID,
          runId: 'run-continue',
          messageId: 'a1',
        },
        {
          type: 'RUN_ERROR',
          threadId: THREAD_ID,
          runId: 'run-continue',
          code: 'MODEL_UNAVAILABLE',
          message: 'The model is temporarily unavailable',
        },
      ]
      for (const [id, event] of events.entries()) yield { id, event }
    })
    await act(() => result.current.continueReply(1))
    client.events.mockImplementationOnce(
      regenerated(transcript.slice(0, 2).map(wire)),
    )

    await act(() => result.current.retry())

    expect(turn(1)).toMatchObject({ kind: 'continue', messageId: 'a1' })
  })
})
