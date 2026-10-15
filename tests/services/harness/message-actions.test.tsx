import { ChatMessages } from '@/components/chat/chat-messages'
import { initializeRenderers } from '@/components/chat/renderers/client'
import type { BaseModel } from '@/config/models'
import { AUTH_ACTIVE_USER_ID } from '@/constants/storage-keys'
import type { HarnessClient } from '@/services/harness/client'
import {
  localThreadStore,
  type LocalThread,
} from '@/services/harness/local-threads'
import { activateAPI, HarnessAPI, publish } from '@/services/harness/runtime'
import type { Frame, Message, Thread, Turn } from '@/services/harness/types'
import { useThread } from '@/services/harness/use-thread'
import { chatEvents } from '@/services/storage/chat-events'
import { deletedChatsTracker } from '@/services/storage/deleted-chats-tracker'
import { indexedDBStorage } from '@/services/storage/indexed-db'
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react'
import { IDBKeyRange as FakeIDBKeyRange, IDBFactory } from 'fake-indexeddb'
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { testSession } from '../../harness-fixture'

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
const KEY = 'Y29udGVudC1rZXk='
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

let client: {
  events: ReturnType<typeof vi.fn>
  post: ReturnType<typeof vi.fn>
  upload: ReturnType<typeof vi.fn>
  download: ReturnType<typeof vi.fn>
}

function signIn({ cloud }: { cloud: boolean }) {
  localStorage.setItem(AUTH_ACTIVE_USER_ID, 'alice')
  localStorage.setItem(
    'tinfoil-settings-cloud-sync-enabled',
    cloud ? 'true' : 'false',
  )
  client = {
    events: vi.fn(),
    post: vi.fn().mockResolvedValue({}),
    upload: vi.fn(),
    download: vi.fn(),
  }
  const api = new HarnessAPI(client as unknown as HarnessClient, 'alice')
  vi.spyOn(api, 'key').mockReturnValue(KEY)
  activateAPI(api)
  publish({
    session: { ...testSession, widgets: ['render_chart'] },
    profile: {},
    keyReady: true,
    profileReady: true,
  })
  return api
}

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

beforeAll(() => {
  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    value: new IDBFactory(),
  })
  Object.defineProperty(globalThis, 'IDBKeyRange', {
    configurable: true,
    value: FakeIDBKeyRange,
  })
  initializeRenderers()
})

beforeEach(async () => {
  sessionStorage.clear()
  deletedChatsTracker.clear()
  await indexedDBStorage.deleteAllChats()
  deletedChatsTracker.clear()
})

afterEach(() => {
  chatEvents.clear()
  deletedChatsTracker.clear()
  sessionStorage.clear()
  vi.restoreAllMocks()
})

describe('regenerating a reply', () => {
  it("names the reply when a stored chat's Regenerate buttons are used", async () => {
    signIn({ cloud: true })
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
    signIn({ cloud: false })
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
    signIn({ cloud: false })
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
    signIn({ cloud: true })
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
