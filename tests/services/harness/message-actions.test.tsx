import { ChatMessages } from '@/components/chat/chat-messages'
import { initializeRenderers } from '@/components/chat/renderers/client'
import type { BaseModel } from '@/config/models'
import { localThreadStore } from '@/services/harness/local-threads'
import { getView } from '@/services/harness/runtime'
import { HarnessError } from '@/services/harness/sse'
import type {
  Frame,
  Message,
  StoredThread,
  Thread,
  ThreadMessage,
  Turn,
} from '@/services/harness/types'
import { useThread } from '@/services/harness/use-thread'
import { speechPlayer } from '@/services/speech/player'
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  CACHE_SECRET,
  client,
  KEY,
  signIn,
  testSession,
} from '../../harness-fixture'
import { FakeAudioContext } from '../speech/fixtures'
import { resetChatStoresAroundEachTest, storedThread } from './thread-fixture'

vi.mock('@/components/chat/genui/registry', () => ({
  GENUI_WIDGETS: [{ name: 'render_chart' }],
}))
vi.mock('@/utils/error-handling', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarning: vi.fn(),
}))
vi.mock('@/hooks/use-chat-print', () => ({ useChatPrint: () => undefined }))
const audio = vi.hoisted(() => ({ context: vi.fn() }))
vi.mock('@/utils/audio-context', () => ({
  getAudioContextClass: () => audio.context,
}))

const THREAD_ID = '8233746419000_1c4e7a52-9a2b-4f7e-8d1a-5b6c7d8e9f00'
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

const session = { ...testSession, widgets: ['render_chart'] }

const transcript: ThreadMessage[] = [
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

const wire = (message: ThreadMessage): Message =>
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

const localThread = (messages = transcript) =>
  storedThread(THREAD_ID, {
    title: 'Numbers',
    titleState: 'generated',
    updatedAt: '2026-04-01T09:01:01Z',
    messages,
  })

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

// A run that writes a new reply. A device run's final event returns the
// whole thread.
function regenerated(window: Message[], thread?: StoredThread) {
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
      {
        type: 'RUN_FINISHED',
        threadId: THREAD_ID,
        runId: 'run-regen',
        ...(thread ? { metadata: { thread } } : {}),
      },
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
      speak={thread.speak}
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
        kind: 'regenerate',
        messageId: call === 0 ? 'a2' : 'msg_regen',
        content: '',
        widgets: ['render_chart'],
        options: {
          model: 'test-model',
          timezone: expect.any(String),
          cacheSecret: CACHE_SECRET,
        },
      })
    }
  })

  it("regenerates a local chat's reply and stores the thread its run returns", async () => {
    signIn({ cloud: false, session })
    await localThreadStore('device').update(THREAD_ID, () => localThread())
    const returned = localThread([
      ...transcript.slice(0, 3),
      {
        id: 'msg_regen',
        role: 'assistant',
        createdAt: '2026-04-01T09:02:00Z',
        timeline: [{ id: 'b3', type: 'content', content: 'new answer' }],
      },
    ])
    client.events.mockImplementation(
      regenerated(transcript.slice(0, 3).map(wire), returned),
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
    expect(turn().thread).toEqual(localThread())
    expect(await localThreadStore('device').get(THREAD_ID)).toEqual(returned)
  })

  it('sends a user message without a reply again as an edit of its text', async () => {
    signIn({ cloud: false, session })
    await localThreadStore('device').update(THREAD_ID, () =>
      localThread(transcript.slice(0, 3)),
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
        ? {
            ...cloudThread(),
            activeRun: { runId: 'run-1', expiresAt: '2026-04-01T10:00:00Z' },
          }
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

describe('the chat a regenerated or edited turn leaves', () => {
  function openCloud() {
    signIn({ cloud: true, session })
    client.post.mockImplementation(async (path: string) =>
      path === '/v1/threads/get'
        ? cloudThread()
        : path === '/v1/threads/list'
          ? { threads: [], nextCursor: null }
          : {},
    )
    return renderHook(() => useThread(THREAD_ID, null))
  }
  // A run whose frames wait until it is released.
  function heldRun(run: () => AsyncGenerator<Frame>) {
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    client.events.mockImplementationOnce(async function* () {
      await held
      yield* run()
    })
    return () => act(async () => release())
  }

  it('shows at once without the regenerated reply', async () => {
    const { result } = openCloud()
    await waitFor(() => expect(result.current.chat.messages).toHaveLength(4))
    const release = heldRun(regenerated(transcript.slice(0, 3).map(wire)))

    let regenerating!: Promise<boolean | undefined>
    act(() => {
      regenerating = result.current.regenerate(3)
    })

    await waitFor(() => expect(client.events).toHaveBeenCalledOnce())
    expect(result.current.running).toBe(true)
    expect(result.current.chat.messages.map((m) => m.id)).toEqual([
      'u1',
      'a1',
      'u2',
    ])
    await release()
    await act(() => regenerating)
    expect(result.current.chat.messages.map((m) => [m.id, m.content])).toEqual([
      ['u1', 'one'],
      ['a1', 'first answer'],
      ['u2', 'two'],
      ['msg_regen', 'new answer'],
    ])
  })

  it('shows the edited message at once in place of the one it replaces', async () => {
    const { result } = openCloud()
    await waitFor(() => expect(result.current.chat.messages).toHaveLength(4))
    const release = heldRun(regenerated(transcript.slice(0, 2).map(wire)))

    let editing!: Promise<boolean> | undefined
    act(() => {
      editing = result.current.send({
        kind: 'edit',
        messageId: 'u2',
        content: 'two, edited',
      })
    })

    await waitFor(() => expect(client.events).toHaveBeenCalledOnce())
    expect(turn()).toMatchObject({
      kind: 'edit',
      messageId: 'u2',
      content: 'two, edited',
    })
    expect(result.current.chat.messages.map((m) => [m.id, m.content])).toEqual([
      ['u1', 'one'],
      ['a1', 'first answer'],
      [turn().clientRequestId, 'two, edited'],
    ])
    expect(result.current.chat.messages[2].role).toBe('user')
    await release()
    await act(async () => {
      await editing
    })
  })

  it('shows the chat as it was when the harness refuses the turn', async () => {
    const { result } = openCloud()
    await waitFor(() => expect(result.current.chat.messages).toHaveLength(4))
    client.events.mockImplementationOnce(async function* () {
      throw new HarnessError(
        { code: 'RATE_LIMITED', message: 'Chat access is busy; retry shortly' },
        429,
      )
    })

    await act(() => result.current.regenerate(3))

    expect(result.current.errorDetail).toMatchObject({ code: 'RATE_LIMITED' })
    expect(result.current.chat.messages.map((m) => [m.id, m.content])).toEqual([
      ['u1', 'one'],
      ['a1', 'first answer'],
      ['u2', 'two'],
      ['a2', 'second answer'],
    ])
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

  it('asks the harness to retry a failed run instead of rejoining it', async () => {
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
    expect(result.current.errorDetail).toEqual({
      code: 'MODEL_UNAVAILABLE',
      message: 'The model is temporarily unavailable',
    })

    await act(() => result.current.retry())

    expect(client.events.mock.calls[1][0]).toBe('/v1/threads/turn')
    expect(turn(1)).toEqual({
      clientRequestId: expect.any(String),
      threadId: THREAD_ID,
      key: KEY,
      kind: 'retry',
      widgets: ['render_chart'],
      options: {
        model: 'test-model',
        timezone: expect.any(String),
        cacheSecret: CACHE_SECRET,
      },
    })
    expect(turn(1).clientRequestId).not.toBe(turn(0).clientRequestId)
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
    expect(result.current.errorDetail).toMatchObject({
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

  it('shows the stored chat when a turn sent again was already applied', async () => {
    const { result } = openCloud()
    await waitFor(() => expect(result.current.chat.messages).toHaveLength(2))
    client.events.mockImplementationOnce(async function* () {
      throw new TypeError('Failed to fetch')
    })
    await act(() => result.current.send({ content: 'two' }))
    expect(result.current.chat.messages.map((m) => m.content)).toEqual([
      'one',
      'first answer',
      'two',
    ])
    client.events.mockImplementationOnce(async function* () {
      throw new HarnessError(
        { code: 'ALREADY_APPLIED', message: 'The turn was already applied' },
        409,
      )
    })
    client.post.mockImplementation(async (path: string) =>
      path === '/v1/threads/get' ? cloudThread() : {},
    )

    await act(() => result.current.retry())

    expect(client.events.mock.calls[1][0]).toBe('/v1/threads/turn')
    expect(turn(1)).toEqual(turn(0))
    expect(result.current.chat.messages.map((m) => m.id)).toEqual([
      'u1',
      'a1',
      'u2',
      'a2',
    ])
    expect(result.current.error).toBe('')
    expect(result.current.status).toBe('idle')
  })

  it('shows the quota a refused turn reports', async () => {
    const { result } = openCloud()
    await waitFor(() => expect(result.current.chat.messages).toHaveLength(2))
    const rateLimit = {
      kind: 'free_daily' as const,
      maxRequests: 20,
      remaining: 0,
      resetsAt: '2026-07-25T00:00:00Z',
    }
    client.events.mockImplementationOnce(async function* () {
      throw new HarnessError(
        {
          code: 'QUOTA_EXHAUSTED',
          message: 'The daily limit is reached',
          kind: 'free_daily',
          resetsAt: '2026-07-25T00:00:00Z',
          rateLimit,
        },
        429,
      )
    })

    await act(() => result.current.send({ content: 'more' }))

    expect(getView().rateLimit).toEqual(rateLimit)
  })
})

describe('reading a reply aloud', () => {
  // The audio the harness answers with: two samples at half scale.
  function playsAudio() {
    const context = new FakeAudioContext()
    audio.context.mockImplementation(function () {
      return context
    })
    client.stream.mockImplementation(
      async () =>
        new Response(new Uint8Array([0, 64, 0, 192]), {
          headers: { 'Content-Type': 'audio/pcm' },
        }),
    )
    return context
  }
  afterEach(() => speechPlayer.stop())

  async function readLastReply(context: FakeAudioContext) {
    await screen.findByText('second answer')
    const buttons = screen.getAllByRole('button', { name: 'Read aloud' })
    expect(buttons).toHaveLength(2)
    fireEvent.click(buttons[1])
    await waitFor(() => expect(context.scheduled).toHaveLength(1))
    expect(Array.from(context.scheduled[0].buffer!.getChannelData())).toEqual([
      0.5, -0.5,
    ])
  }

  it("asks the harness to read a stored chat's reply by its id", async () => {
    signIn({ cloud: true, session })
    client.post.mockImplementation(async (path: string) =>
      path === '/v1/threads/get'
        ? cloudThread()
        : path === '/v1/threads/list'
          ? { threads: [], nextCursor: null }
          : {},
    )
    const context = playsAudio()
    render(<Conversation local={false} />)

    await readLastReply(context)

    expect(client.stream).toHaveBeenCalledExactlyOnceWith(
      '/v1/speech',
      { key: KEY, threadId: THREAD_ID, messageId: 'a2' },
      expect.any(AbortSignal),
    )
  })

  it('sends the chat a device keeps, without a key', async () => {
    signIn({ cloud: false, session })
    await localThreadStore('device').update(THREAD_ID, () => localThread())
    const context = playsAudio()
    render(<Conversation local />)

    await readLastReply(context)

    expect(client.stream).toHaveBeenCalledExactlyOnceWith(
      '/v1/speech',
      { local: true, thread: localThread(), messageId: 'a2' },
      expect.any(AbortSignal),
    )
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
      throw new Error(`Unexpected ${path}`)
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
    expect(
      result.current.chats
        .filter((chat) => !chat.isLocalOnly)
        .map((chat) => chat.id),
    ).toEqual(['fork-1'])
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
      localThread(messages),
    )
    const hook = renderHook(() => useThread(THREAD_ID, null, { local: true }))
    await waitFor(() =>
      expect(hook.result.current.chat.messages).toHaveLength(messages.length),
    )
    return hook
  }
  const saved = () => localThreadStore('device').get(THREAD_ID)

  it('deletes a message through the harness and stores the chat it returns', async () => {
    const { result } = await openLocal()
    const changed = localThread([transcript[0], transcript[1], transcript[3]])
    client.post.mockResolvedValueOnce({ thread: changed })

    await act(() => result.current.deleteMessage(2))

    expect(client.post).toHaveBeenCalledExactlyOnceWith(
      '/v1/threads/messages/delete',
      {
        threadId: THREAD_ID,
        messageId: 'u2',
        local: true,
        thread: localThread(),
      },
      expect.any(AbortSignal),
    )
    expect(await saved()).toEqual(changed)
    expect(result.current.chat.messages.map((m) => m.id)).toEqual([
      'u1',
      'a1',
      'a2',
    ])
  })

  it("rewrites a reply's text through the harness, and the next turn sends the chat it returns", async () => {
    const { result } = await openLocal()
    const edited = localThread([
      ...transcript.slice(0, 3),
      {
        ...transcript[3],
        content: 'Better',
        timeline: [{ id: 'b2', type: 'content', content: 'Better' }],
      },
    ])
    client.post.mockResolvedValueOnce({ thread: edited })

    await act(() => result.current.editReply(3, 'Better'))

    expect(client.post).toHaveBeenCalledExactlyOnceWith(
      '/v1/threads/messages/update',
      {
        threadId: THREAD_ID,
        messageId: 'a2',
        content: 'Better',
        local: true,
        thread: localThread(),
      },
      expect.any(AbortSignal),
    )
    expect(await saved()).toEqual(edited)
    expect(result.current.chat.messages[3].content).toBe('Better')

    client.events.mockImplementationOnce(regenerated([...transcript.map(wire)]))
    await act(() => result.current.send({ content: 'three' }))
    expect(turn().thread).toEqual(edited)
  })

  it('continues a reply with its thread and stores the thread its run returns', async () => {
    const { result } = await openLocal()
    const returned = localThread([
      transcript[0],
      {
        ...transcript[1],
        content: undefined,
        timeline: [
          { id: 'b1', type: 'content', content: 'first answer, continued' },
        ],
      },
    ])
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
          metadata: { thread: returned },
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
    expect(turn().thread).toEqual(localThread())
    expect(result.current.chat.messages.map((m) => m.content)).toEqual([
      'one',
      'first answer, continued',
    ])
    expect(await saved()).toEqual(returned)
  })

  it('retries a failed continuation as a retry of the chat it failed in', async () => {
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

    expect(turn(1)).toEqual({
      clientRequestId: expect.any(String),
      threadId: THREAD_ID,
      kind: 'retry',
      widgets: ['render_chart'],
      options: {
        model: 'test-model',
        timezone: expect.any(String),
        cacheSecret: CACHE_SECRET,
      },
      local: true,
      thread: localThread(),
      profile: {},
    })
  })
})

describe('keeping the earlier messages the user loaded', () => {
  const question: ThreadMessage = {
    id: 'u3',
    role: 'user',
    createdAt: '2026-04-01T09:02:00Z',
    content: 'three',
  }
  // Opens a stored chat whose window holds its last exchange, and loads the
  // messages before it. The harness answers a message change with `changed`.
  async function openWithEarlier(changed?: Thread) {
    signIn({ cloud: true, session })
    client.post.mockImplementation(async (path: string, input: unknown) => {
      if (path === '/v1/threads/get')
        return (input as { before?: string }).before === 'u2'
          ? { ...cloudThread(transcript.slice(0, 2)), hasOlder: false }
          : { ...cloudThread(transcript.slice(2)), hasOlder: true }
      if (path === '/v1/threads/list') return { threads: [], nextCursor: null }
      if (
        changed &&
        (path === '/v1/threads/messages/delete' ||
          path === '/v1/threads/messages/update')
      )
        return changed
      throw new Error(`Unexpected ${path}`)
    })
    const hook = renderHook(() => useThread(THREAD_ID, null))
    await waitFor(() =>
      expect(hook.result.current.chat.messages).toHaveLength(2),
    )
    await act(() => hook.result.current.older())
    expect(hook.result.current.chat.messages.map((m) => m.id)).toEqual([
      'u1',
      'a1',
      'u2',
      'a2',
    ])
    expect(hook.result.current.hasOlder).toBe(false)
    return hook
  }
  // The window the harness answers a change with: the chat's last two
  // messages, after which more are stored.
  const lastTwo = (messages: ThreadMessage[]): Thread => ({
    ...cloudThread(messages.slice(-2)),
    messageCount: messages.length,
    hasOlder: true,
  })

  it("keeps them when a run's window starts after them", async () => {
    const { result } = await openWithEarlier()
    client.events.mockImplementationOnce(async function* () {
      const events: Frame['event'][] = [
        { type: 'RUN_STARTED', threadId: THREAD_ID, runId: 'run-2' },
        {
          type: 'MESSAGES_SNAPSHOT',
          messages: [transcript[3], question].map(wire),
          hasOlder: true,
        },
        {
          type: 'TEXT_MESSAGE_CHUNK',
          messageId: 'a3',
          delta: 'third answer',
          timestamp: '2026-04-01T09:02:01Z',
        },
        { type: 'RUN_FINISHED', threadId: THREAD_ID, runId: 'run-2' },
      ]
      for (const [id, event] of events.entries()) yield { id, event }
    })

    await act(() => result.current.send({ content: 'three' }))

    expect(result.current.chat.messages.map((m) => [m.id, m.content])).toEqual([
      ['u1', 'one'],
      ['a1', 'first answer'],
      ['u2', 'two'],
      ['a2', 'second answer'],
      ['u3', 'three'],
      ['a3', 'third answer'],
    ])
    expect(result.current.hasOlder).toBe(false)
  })

  it('keeps them, less the one deleted, when a message is deleted', async () => {
    const { result } = await openWithEarlier(
      lastTwo([transcript[0], transcript[2], transcript[3]]),
    )

    await act(() => result.current.deleteMessage(1))

    expect(result.current.chat.messages.map((m) => m.id)).toEqual([
      'u1',
      'u2',
      'a2',
    ])
    expect(result.current.hasOlder).toBe(false)
  })

  it('keeps them, with the reply rewritten, when an earlier reply is edited', async () => {
    const { result } = await openWithEarlier(lastTwo(transcript))

    await act(() => result.current.editReply(1, 'Better first'))

    expect(result.current.chat.messages.map((m) => [m.id, m.content])).toEqual([
      ['u1', 'one'],
      ['a1', 'Better first'],
      ['u2', 'two'],
      ['a2', 'second answer'],
    ])
    expect(result.current.chat.messages[1].timeline).toEqual([
      { id: 'b1', type: 'content', content: 'Better first' },
    ])
    expect(result.current.hasOlder).toBe(false)
  })
})
