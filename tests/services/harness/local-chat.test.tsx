import { AUTH_ACTIVE_USER_ID } from '@/constants/storage-keys'
import type { HarnessClient } from '@/services/harness/client'
import {
  localThreadStore,
  type LocalThread,
} from '@/services/harness/local-threads'
import { activateAPI, HarnessAPI, publish } from '@/services/harness/runtime'
import { HarnessError } from '@/services/harness/sse'
import type { Frame, Message, Turn } from '@/services/harness/types'
import { useThread } from '@/services/harness/use-thread'
import { chatEvents } from '@/services/storage/chat-events'
import { deletedChatsTracker } from '@/services/storage/deleted-chats-tracker'
import {
  DB_NAME,
  DB_VERSION,
  indexedDBStorage,
} from '@/services/storage/indexed-db'
import { act, renderHook, waitFor } from '@testing-library/react'
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

const REVERSE_ID = /^\d{13}_[0-9a-f-]{36}$/
const PROFILE = {
  nickname: 'Sam',
  traits: ['direct'],
  reasoningEffort: 'sometimes',
  sandboxEnabled: true,
  themeMode: 'dark',
}
const USAGE = { promptTokens: 12, completionTokens: 4 }

let client: {
  events: ReturnType<typeof vi.fn>
  post: ReturnType<typeof vi.fn>
  upload: ReturnType<typeof vi.fn>
  download: ReturnType<typeof vi.fn>
}

function signIn(userId: string | null) {
  client = {
    events: vi.fn(),
    post: vi.fn().mockResolvedValue({}),
    upload: vi.fn(),
    download: vi.fn(),
  }
  const api = new HarnessAPI(client as unknown as HarnessClient, userId)
  activateAPI(api)
  publish({
    session: { ...testSession, widgets: ['render_chart'] },
    profile: PROFILE,
    keyReady: !userId,
    profileReady: true,
  })
  return api
}

function frames(...events: Frame['event'][]) {
  return async function* () {
    for (const [id, event] of events.entries()) yield { id, event }
  }
}

function summary(threadId: string, title = 'New Chat') {
  return {
    id: threadId,
    title,
    titleState: title === 'New Chat' ? 'placeholder' : 'generated',
    createdAt: '2026-05-01T10:00:00Z',
    updatedAt: '2026-05-01T10:00:00Z',
    model: 'test-model',
    projectId: null,
    pinned: false,
    webSearchEnabled: true,
    messageCount: 2,
    activeRun: null,
    contextUsage: { usedTokens: 30, limitTokens: 1000, percentage: 3 },
  } as const
}

function reply(
  threadId: string,
  window: Message[],
  replyId: string,
  text: string,
  title = 'New Chat',
) {
  return frames(
    { type: 'RUN_STARTED', threadId, runId: `run-${replyId}` },
    { type: 'MESSAGES_SNAPSHOT', messages: window, hasOlder: false },
    {
      type: 'STATE_SNAPSHOT',
      snapshot: { thread: summary(threadId, title), queue: [] },
    },
    {
      type: 'TEXT_MESSAGE_CHUNK',
      messageId: replyId,
      delta: text,
      timestamp: '2026-05-01T10:00:05Z',
    },
    {
      type: 'RUN_FINISHED',
      threadId,
      runId: `run-${replyId}`,
      metadata: {
        messages: [
          {
            id: replyId,
            model: 'test-model',
            modelDisplayName: 'Test model',
            usage: USAGE,
            isError: false,
            isInterrupted: false,
          },
        ],
      },
    },
  )
}

const turn = (call = 0) => client.events.mock.calls[call][1] as Turn
const stored = (id: string) => localThreadStore('device').get(id)

async function rawPayloads() {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve(request.result)
  })
  try {
    return await new Promise<Record<string, unknown>[]>((resolve, reject) => {
      const request = db
        .transaction('attachmentPayloads')
        .objectStore('attachmentPayloads')
        .getAll()
      request.onerror = () => reject(request.error)
      request.onsuccess = () => resolve(request.result)
    })
  } finally {
    db.close()
  }
}

const SEEDED_ID = '8233746419000_1c4e7a52-9a2b-4f7e-8d1a-5b6c7d8e9f00'
function seededThread(): LocalThread {
  return {
    id: SEEDED_ID,
    title: 'Doors',
    titleState: 'generated',
    createdAt: '2026-04-01T09:00:00Z',
    updatedAt: '2026-04-01T09:05:00Z',
    model: 'test-model',
    codeExecutionAccessToken: 'c'.repeat(64),
    messages: [
      { id: 'u1', role: 'user', createdAt: 't1', content: 'first' },
      {
        id: 'a1',
        role: 'assistant',
        createdAt: 't2',
        content: 'first answer',
        model: 'test-model',
        timeline: [{ id: 'b1', type: 'content', content: 'first answer' }],
      },
      { id: 'u2', role: 'user', createdAt: 't3', content: 'second' },
      {
        id: 'a2',
        role: 'assistant',
        createdAt: 't4',
        content: 'second answer',
        model: 'test-model',
        timeline: [{ id: 'b2', type: 'content', content: 'second answer' }],
      },
    ],
  }
}
const wire = (message: LocalThread['messages'][number]): Message =>
  message.role === 'assistant'
    ? {
        id: message.id,
        role: 'assistant',
        createdAt: message.createdAt,
        model: message.model,
        timeline: message.timeline,
      }
    : {
        id: message.id,
        role: 'user',
        createdAt: message.createdAt,
        content: message.content,
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

describe('local chats of a signed-in account without cloud sync', () => {
  it('sends a turn without a key and stores the merged transcript', async () => {
    const api = signIn('alice')
    expect(() => api.key()).toThrow(HarnessError)
    client.events.mockImplementation((_path: string, input: Turn) => {
      const threadId = input.threadId!
      return frames(
        { type: 'RUN_STARTED', threadId, runId: 'run-1' },
        {
          type: 'MESSAGES_SNAPSHOT',
          messages: [
            {
              id: 'msg_user',
              role: 'user',
              createdAt: '2026-05-01T10:00:01Z',
              content: 'Hi there',
              quote: undefined,
            },
          ],
          hasOlder: false,
        },
        {
          type: 'STATE_SNAPSHOT',
          snapshot: { thread: summary(threadId), queue: [] },
        },
        {
          type: 'TEXT_MESSAGE_CHUNK',
          messageId: 'msg_reply',
          delta: 'Hello ',
          timestamp: '2026-05-01T10:00:03Z',
        },
        { type: 'TEXT_MESSAGE_CHUNK', messageId: 'msg_reply', delta: 'Sam' },
        {
          type: 'STATE_DELTA',
          delta: [
            { op: 'replace', path: '/thread/title', value: 'Greeting' },
            { op: 'replace', path: '/thread/titleState', value: 'generated' },
          ],
        },
        {
          type: 'RUN_FINISHED',
          threadId,
          runId: 'run-1',
          metadata: {
            messages: [
              {
                id: 'msg_reply',
                model: 'test-model',
                modelDisplayName: 'Test model',
                usage: USAGE,
                isError: false,
                isInterrupted: false,
              },
            ],
          },
        },
      )()
    })
    const { result } = renderHook(() => useThread())
    await waitFor(() => expect(result.current.model).toBe('test-model'))

    await act(() => result.current.send({ content: 'Hi there' }))

    const input = turn()
    expect(client.events.mock.calls[0][0]).toBe('/v1/threads/turn')
    expect(input).not.toHaveProperty('key')
    expect(input).not.toHaveProperty('ephemeral')
    expect(input).toEqual({
      clientRequestId: expect.any(String),
      threadId: expect.stringMatching(REVERSE_ID),
      kind: 'send',
      local: true,
      content: 'Hi there',
      widgets: ['render_chart'],
      options: { model: 'test-model', timezone: expect.any(String) },
      profile: { nickname: 'Sam', traits: ['direct'] },
      thread: {
        title: 'New Chat',
        titleState: 'placeholder',
        createdAt: expect.any(String),
        model: 'test-model',
        presetId: null,
        codeExecutionAccessToken: expect.stringMatching(/^[0-9a-f]{64}$/),
        messages: [],
      },
    })
    const threadId = input.threadId!
    expect(await stored(threadId)).toEqual({
      id: threadId,
      title: 'Greeting',
      titleState: 'generated',
      createdAt: input.thread!.createdAt,
      updatedAt: expect.any(String),
      model: 'test-model',
      webSearchEnabled: true,
      codeExecutionAccessToken: input.thread!.codeExecutionAccessToken,
      contextUsage: { usedTokens: 30, limitTokens: 1000, percentage: 3 },
      messages: [
        {
          id: 'msg_user',
          role: 'user',
          createdAt: '2026-05-01T10:00:01Z',
          content: 'Hi there',
        },
        {
          id: 'msg_reply',
          role: 'assistant',
          createdAt: '2026-05-01T10:00:03Z',
          content: 'Hello Sam',
          model: 'test-model',
          modelDisplayName: 'Test model',
          usage: USAGE,
          timeline: [
            {
              id: 'msg_reply_content_0',
              type: 'content',
              content: 'Hello Sam',
            },
          ],
        },
      ],
    })
    expect(result.current.chat).toMatchObject({
      id: threadId,
      title: 'Greeting',
      isLocalOnly: true,
    })
    await waitFor(() =>
      expect(result.current.chats).toEqual([
        expect.objectContaining({
          id: threadId,
          title: 'Greeting',
          isLocalOnly: true,
          messageCount: 2,
        }),
      ]),
    )
  })

  it('keeps a new local chat pending until its first save lands', async () => {
    signIn('alice')
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    client.events.mockImplementation(async function* (
      _path: string,
      input: Turn,
    ) {
      const threadId = input.threadId!
      yield { id: 0, event: { type: 'RUN_STARTED', threadId, runId: 'run-1' } }
      await held
      yield {
        id: 1,
        event: {
          type: 'MESSAGES_SNAPSHOT',
          messages: [
            { id: 'msg_user', role: 'user', createdAt: 't1', content: 'Hi' },
          ],
          hasOlder: false,
        },
      }
      yield {
        id: 2,
        event: { type: 'RUN_FINISHED', threadId, runId: 'run-1' },
      }
    })
    const { result } = renderHook(() => useThread())
    await waitFor(() => expect(result.current.model).toBe('test-model'))
    let sending!: Promise<boolean | undefined> | undefined
    act(() => {
      sending = result.current.send({ content: 'Hi' })
    })

    await waitFor(() => expect(result.current.chat.id).toMatch(REVERSE_ID))
    const threadId = result.current.chat.id
    expect(result.current.chat.pendingSave).toBe(true)
    expect(await stored(threadId)).toBeNull()

    await act(async () => {
      release()
      await sending
    })

    expect(result.current.chat.pendingSave).toBe(false)
    expect((await stored(threadId))?.messages.map((m) => m.id)).toEqual([
      'msg_user',
    ])
  })

  function heldRun() {
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    client.events.mockImplementation(async function* (
      path: string,
      input: Turn,
    ) {
      const threadId = input.threadId!
      yield { id: 0, event: { type: 'RUN_STARTED', threadId, runId: 'run-1' } }
      yield {
        id: 1,
        event: {
          type: 'MESSAGES_SNAPSHOT',
          messages: [
            { id: 'msg_user', role: 'user', createdAt: 't1', content: 'Q' },
          ],
          hasOlder: false,
        },
      }
      yield {
        id: 2,
        event: {
          type: 'TEXT_MESSAGE_CHUNK',
          messageId: 'msg_reply',
          delta: 'Long answer',
          timestamp: 't2',
        },
      }
      if (path === '/v1/threads/turn') await held
      yield {
        id: 3,
        event: {
          type: 'RUN_FINISHED',
          threadId,
          runId: 'run-1',
          metadata: {
            messages: [
              {
                id: 'msg_reply',
                model: 'test-model',
                modelDisplayName: 'Test model',
                usage: USAGE,
                isError: false,
                isInterrupted: false,
              },
            ],
          },
        },
      }
    })
    return release
  }
  const savedReply = [
    { id: 'msg_user', role: 'user', createdAt: 't1', content: 'Q' },
    {
      id: 'msg_reply',
      role: 'assistant',
      createdAt: 't2',
      content: 'Long answer',
      model: 'test-model',
      modelDisplayName: 'Test model',
      usage: USAGE,
      timeline: [
        { id: 'msg_reply_content_0', type: 'content', content: 'Long answer' },
      ],
    },
  ]
  async function sendHeld() {
    const release = heldRun()
    const hook = renderHook(() => useThread())
    await waitFor(() => expect(hook.result.current.model).toBe('test-model'))
    let sending!: Promise<boolean | undefined> | undefined
    act(() => {
      sending = hook.result.current.send({ content: 'Q' })
    })
    await waitFor(() =>
      expect(hook.result.current.chat.messages.map((m) => m.content)).toEqual([
        'Q',
        'Long answer',
      ]),
    )
    return { ...hook, release, sending: () => sending }
  }

  it('saves a reply that finishes after the view moved to another chat', async () => {
    signIn('alice')
    const { result, release, sending } = await sendHeld()
    const threadId = result.current.chat.id

    act(() => result.current.newChat())
    await act(async () => {
      release()
      await sending()
    })

    expect(result.current.chat.messages).toEqual([])
    expect(client.events).toHaveBeenCalledOnce()
    expect((await stored(threadId))?.messages).toEqual(savedReply)
  })

  it('lists a chat whose run streams here as active until the run ends', async () => {
    signIn('alice')
    const { result, release, sending } = await sendHeld()
    const threadId = result.current.chat.id
    const listed = () =>
      result.current.chats.find((chat) => chat.id === threadId)
    await waitFor(() =>
      expect(listed()?.activeRun).toMatchObject({ runId: 'run-1' }),
    )

    act(() => result.current.newChat())
    expect(listed()?.activeRun).toMatchObject({ runId: 'run-1' })

    await act(async () => {
      release()
      await sending()
    })
    await waitFor(() => expect(listed()?.activeRun).toBeNull())
  })

  it('rejoins a run when its chat is reopened', async () => {
    signIn('alice')
    const { result, release, sending } = await sendHeld()
    const threadId = result.current.chat.id

    act(() => result.current.newChat())
    await act(() => result.current.open(threadId, { local: true }))

    expect(client.events.mock.calls[1].slice(0, 2)).toEqual([
      '/v1/threads/follow',
      { threadId, runId: 'run-1' },
    ])
    await waitFor(() =>
      expect(result.current.chat.messages.map((m) => m.content)).toEqual([
        'Q',
        'Long answer',
      ]),
    )
    await act(async () => {
      release()
      await sending()
    })
    expect((await stored(threadId))?.messages).toEqual(savedReply)
  })

  it('sends the stored transcript with an edit and keeps the truncation', async () => {
    signIn('alice')
    await localThreadStore('device').update(SEEDED_ID, () => seededThread())
    const [u1, a1] = seededThread().messages
    client.events.mockImplementation(
      reply(
        SEEDED_ID,
        [
          wire(u1),
          wire(a1),
          {
            id: 'msg_edit',
            role: 'user',
            createdAt: 't5',
            content: 'second, edited',
          },
        ],
        'msg_new',
        'edited answer',
        'Doors',
      ),
    )
    const { result } = renderHook(() =>
      useThread(SEEDED_ID, null, { local: true }),
    )
    await waitFor(() => expect(result.current.chat.messages).toHaveLength(4))

    await act(() =>
      result.current.send({
        kind: 'edit',
        messageId: 'u2',
        content: 'second, edited',
      }),
    )

    expect(turn()).toMatchObject({
      threadId: SEEDED_ID,
      kind: 'edit',
      messageId: 'u2',
      local: true,
      thread: { title: 'Doors', messages: seededThread().messages },
    })
    expect(turn()).not.toHaveProperty('key')
    const saved = await stored(SEEDED_ID)
    expect(saved?.messages).toEqual([
      u1,
      a1,
      {
        id: 'msg_edit',
        role: 'user',
        createdAt: 't5',
        content: 'second, edited',
      },
      {
        id: 'msg_new',
        role: 'assistant',
        createdAt: '2026-05-01T10:00:05Z',
        content: 'edited answer',
        model: 'test-model',
        modelDisplayName: 'Test model',
        usage: USAGE,
        timeline: [
          {
            id: 'msg_new_content_0',
            type: 'content',
            content: 'edited answer',
          },
        ],
      },
    ])
    expect(saved?.title).toBe('Doors')
  })

  it('replaces the regenerated reply', async () => {
    signIn('alice')
    await localThreadStore('device').update(SEEDED_ID, () => seededThread())
    const [u1, a1, u2] = seededThread().messages
    client.events.mockImplementation(
      reply(
        SEEDED_ID,
        [wire(u1), wire(a1), wire(u2)],
        'msg_regen',
        'again',
        'Doors',
      ),
    )
    const { result } = renderHook(() =>
      useThread(SEEDED_ID, null, { local: true }),
    )
    await waitFor(() => expect(result.current.chat.messages).toHaveLength(4))

    await act(() =>
      result.current.send({ kind: 'regenerate', messageId: 'a2', content: '' }),
    )

    expect(turn()).toMatchObject({ kind: 'regenerate', messageId: 'a2' })
    expect((await stored(SEEDED_ID))?.messages.map((m) => m.id)).toEqual([
      'u1',
      'a1',
      'u2',
      'msg_regen',
    ])
  })

  it('keeps image bytes across a reload and sends them with the next turn', async () => {
    signIn('alice')
    const bytes = new Uint8Array([137, 80, 78, 71])
    const base64 = btoa(String.fromCharCode(...bytes))
    const view = {
      id: 'att_door',
      kind: 'image',
      fileName: 'door.png',
      mimeType: 'image/png',
      size: 4,
      thumbnail: 'dGh1bWI=',
      pages: null,
      status: 'ready',
    }
    client.upload.mockResolvedValue({
      ...view,
      descriptor: {
        id: 'att_door',
        type: 'image',
        fileName: 'door.png',
        mimeType: 'image/png',
        fileSize: 4,
        thumbnailBase64: 'dGh1bWI=',
      },
    })
    client.events.mockImplementation((_path: string, input: Turn) =>
      reply(
        input.threadId!,
        [
          {
            id: 'msg_photo',
            role: 'user',
            createdAt: 't1',
            content: 'What door?',
            attachments: [{ ...view, description: 'A red door' }],
          },
        ],
        'msg_answer',
        'A red one',
      )(),
    )
    const first = renderHook(() => useThread())
    await waitFor(() => expect(first.result.current.model).toBe('test-model'))

    let uploaded: unknown
    await act(async () => {
      uploaded = await first.result.current.upload(
        new File([bytes], 'door.png', { type: 'image/png' }),
      )
    })
    expect(uploaded).toEqual(view)
    expect(client.upload).toHaveBeenCalledExactlyOnceWith(
      '/v1/attachments/upload',
      expect.any(File),
      { local: 'true' },
      expect.any(AbortSignal),
    )
    await act(() =>
      first.result.current.send({
        content: 'What door?',
        attachments: ['att_door'],
      }),
    )
    const threadId = turn().threadId!
    expect(turn().attachments).toEqual(['att_door'])
    const descriptor = {
      id: 'att_door',
      type: 'image',
      fileName: 'door.png',
      mimeType: 'image/png',
      fileSize: 4,
      thumbnailBase64: 'dGh1bWI=',
      description: 'A red door',
      base64,
    }
    expect((await stored(threadId))?.messages[0].attachments).toEqual([
      descriptor,
    ])
    expect(await rawPayloads()).toEqual([
      {
        id: `${threadId}:att_door`,
        chatId: threadId,
        base64,
        thumbnailBase64: 'dGh1bWI=',
      },
    ])
    first.unmount()

    client.events.mockImplementation(reply(threadId, [], 'msg_more', 'More'))
    const reloaded = renderHook(() =>
      useThread(threadId, null, { local: true }),
    )
    await waitFor(() =>
      expect(reloaded.result.current.chat.messages).toHaveLength(2),
    )
    const image = await reloaded.result.current.loadImage(
      reloaded.result.current.chat.messages[0].attachments![0],
    )
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(bytes)

    await act(() => reloaded.result.current.send({ content: 'And now?' }))

    expect(turn(1).thread?.messages[0].attachments).toEqual([descriptor])
  })

  it('opens a chat the previous client stored and sends it upgraded', async () => {
    signIn('alice')
    await indexedDBStorage.saveChat({
      id: SEEDED_ID,
      title: 'Cats',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      isLocalOnly: true,
      messages: [
        {
          role: 'user',
          content: 'Look at this',
          timestamp: new Date('2026-01-01T00:00:01.000Z'),
          imageData: [{ base64: 'aW1n', mimeType: 'image/jpeg' }],
        },
        {
          role: 'assistant',
          content: 'A cat',
          timestamp: new Date('2026-01-01T00:00:02.000Z'),
          timeline: [
            {
              type: 'web_search',
              id: 'search',
              state: { query: 'cats', status: 'completed', sources: [] },
            },
            { type: 'content', id: 'text', content: 'A cat' },
          ],
        },
      ],
    })
    client.events.mockImplementation(reply(SEEDED_ID, [], 'msg_next', 'Yes'))
    const { result } = renderHook(() =>
      useThread(SEEDED_ID, null, { local: true }),
    )

    await waitFor(() => expect(result.current.chat.messages).toHaveLength(2))
    const [question, answer] = result.current.chat.messages
    expect(question.content).toBe('Look at this')
    expect(question.attachments).toEqual([
      expect.objectContaining({
        id: `${SEEDED_ID}-message-0-attachment-0`,
        type: 'image',
        base64: 'aW1n',
      }),
    ])
    expect(answer.content).toBe('A cat')
    expect(answer.timeline).toEqual([
      expect.objectContaining({
        type: 'tool_call',
        name: 'web_search',
        arguments: '{"query":"cats"}',
      }),
      expect.objectContaining({ type: 'content', content: 'A cat' }),
    ])

    await act(() => result.current.send({ content: 'Sure?' }))

    expect(turn().thread?.messages.map((message) => message.id)).toEqual([
      `${SEEDED_ID}-message-0`,
      `${SEEDED_ID}-message-1`,
    ])
    expect(turn().thread?.messages[0].attachments).toEqual([
      {
        id: `${SEEDED_ID}-message-0-attachment-0`,
        type: 'image',
        fileName: 'image-0',
        mimeType: 'image/jpeg',
        base64: 'aW1n',
      },
    ])
  })

  it('cancels and removes queued turns without sending a key', async () => {
    signIn('alice')
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    client.events.mockImplementation(async function* (
      _path: string,
      input: Turn,
    ) {
      yield {
        id: 0,
        event: {
          type: 'RUN_STARTED',
          threadId: input.threadId!,
          runId: 'run-1',
        },
      }
      await held
      yield {
        id: 1,
        event: {
          type: 'RUN_FINISHED',
          threadId: input.threadId!,
          runId: 'run-1',
          metadata: { cancelled: true },
        },
      }
    })
    const { result } = renderHook(() => useThread())
    let sending!: Promise<boolean | undefined> | undefined
    act(() => {
      sending = result.current.send({ content: 'Long task' })
    })
    await waitFor(() => expect(result.current.running).toBe(true))
    const threadId = turn().threadId!

    await act(() => result.current.cancel())
    await act(() => result.current.removeQueued('queued-1'))

    expect(client.post.mock.calls).toEqual([
      [
        '/v1/threads/cancel',
        { threadId, runId: 'run-1' },
        expect.any(AbortSignal),
      ],
      [
        '/v1/threads/queue/remove',
        { threadId, queueId: 'queued-1' },
        expect.any(AbortSignal),
      ],
    ])
    await act(async () => {
      release()
      await sending
    })
  })
})

describe('stored local chat changes', () => {
  async function openSeeded() {
    signIn('alice')
    await localThreadStore('device').update(SEEDED_ID, () => ({
      ...seededThread(),
      messages: seededThread().messages.map((message) =>
        message.id === 'u2'
          ? {
              ...message,
              attachments: [
                {
                  id: 'att_photo',
                  type: 'image' as const,
                  fileName: 'photo.png',
                  mimeType: 'image/png',
                  thumbnailBase64: 'dGh1bWI=',
                  base64: 'cGhvdG8=',
                },
              ],
            }
          : message,
      ),
    }))
    const hook = renderHook(() => useThread(SEEDED_ID, null, { local: true }))
    await waitFor(() =>
      expect(hook.result.current.chat.messages).toHaveLength(4),
    )
    return hook
  }

  it('renames a chat on the device as a manual title', async () => {
    const { result } = await openSeeded()

    await act(() => result.current.update(SEEDED_ID, { title: 'Front doors' }))

    expect(await stored(SEEDED_ID)).toMatchObject({
      title: 'Front doors',
      titleState: 'manual',
      messages: seededThread().messages.map((message) =>
        expect.objectContaining({ id: message.id }),
      ),
    })
    expect(result.current.chat.title).toBe('Front doors')
    expect(client.post).not.toHaveBeenCalled()
  })

  it('forks a chat on the device up to the chosen message', async () => {
    const { result } = await openSeeded()

    let forkId: string | null = null
    await act(async () => {
      forkId = await result.current.fork(2)
    })

    expect(forkId).toMatch(REVERSE_ID)
    const fork = await stored(forkId!)
    expect(fork).toMatchObject({
      id: forkId,
      title: 'Doors (fork)',
      titleState: 'manual',
      model: 'test-model',
    })
    expect(fork?.codeExecutionAccessToken).toMatch(/^[0-9a-f]{64}$/)
    expect(fork?.codeExecutionAccessToken).not.toBe('c'.repeat(64))
    expect(fork?.messages.map((message) => message.id)).toEqual([
      'u1',
      'a1',
      'u2',
    ])
    const [copy] = fork!.messages[2].attachments!
    expect(copy).toEqual({
      id: expect.not.stringMatching(/^att_photo$/),
      type: 'image',
      fileName: 'photo.png',
      mimeType: 'image/png',
      thumbnailBase64: 'dGh1bWI=',
      base64: 'cGhvdG8=',
    })
    expect((await stored(SEEDED_ID))?.messages).toHaveLength(4)
    expect(result.current.chat.id).toBe(forkId)
    expect(result.current.chat.isLocalOnly).toBe(true)
  })

  it('deletes a chat from the device', async () => {
    const { result } = await openSeeded()

    await act(() => result.current.remove(SEEDED_ID))

    expect(await stored(SEEDED_ID)).toBeNull()
    expect(result.current.chat.id).toBe('')
    expect(client.post).not.toHaveBeenCalled()
  })

  it('asks about a local chat with its transcript instead of a key', async () => {
    const { result } = await openSeeded()

    const context = await result.current.askContext()

    expect(context).toEqual({
      threadId: SEEDED_ID,
      local: true,
      thread: expect.objectContaining({ title: 'Doors' }),
      profile: { nickname: 'Sam', traits: ['direct'] },
    })
    expect(context.thread?.messages.map((message) => message.id)).toEqual([
      'u1',
      'a1',
      'u2',
      'a2',
    ])
    expect(context.thread?.messages[2].attachments?.[0].base64).toBe('cGhvdG8=')
  })

  it('shares a local chat from its copy without image bytes or a key', async () => {
    const { result } = await openSeeded()
    client.post.mockResolvedValue({ url: 'https://chat.tinfoil.sh/share/x' })

    let url = ''
    await act(async () => {
      url = await result.current.share(SEEDED_ID)
    })

    expect(url).toBe('https://chat.tinfoil.sh/share/x')
    expect(client.post).toHaveBeenCalledOnce()
    const [path, input] = client.post.mock.calls[0]
    expect(path).toBe('/v1/threads/share')
    expect(input).not.toHaveProperty('key')
    expect(input).toMatchObject({
      local: true,
      threadId: SEEDED_ID,
      thread: { title: 'Doors', presetId: null },
    })
    expect(input.thread.messages.map((m: { id: string }) => m.id)).toEqual([
      'u1',
      'a1',
      'u2',
      'a2',
    ])
    expect(input.thread.messages[2].attachments).toEqual([
      {
        id: 'att_photo',
        type: 'image',
        fileName: 'photo.png',
        mimeType: 'image/png',
        thumbnailBase64: 'dGh1bWI=',
      },
    ])
    // The stored copy keeps its bytes.
    expect((await stored(SEEDED_ID))?.messages[2].attachments?.[0].base64).toBe(
      'cGhvdG8=',
    )
  })

  it('shares the page text of a document stored without extracted text', async () => {
    signIn('alice')
    const page = (number: number, text: string) => ({
      page: number,
      text,
      image: 'cGFnZQ==',
      is_scanned: true,
    })
    await localThreadStore('device').update(SEEDED_ID, () => ({
      ...seededThread(),
      messages: [
        {
          id: 'u1',
          role: 'user' as const,
          createdAt: 't1',
          content: 'Read this',
          attachments: [
            {
              id: 'att_scan',
              type: 'document' as const,
              fileName: 'scan.pdf',
              pages: [page(1, 'First page'), page(2, 'Second page')],
            },
          ],
        },
      ],
    }))
    const { result } = renderHook(() =>
      useThread(SEEDED_ID, null, { local: true }),
    )
    await waitFor(() => expect(result.current.chat.messages).toHaveLength(1))
    client.post.mockResolvedValue({ url: 'https://chat.tinfoil.sh/share/x' })

    await act(async () => {
      await result.current.share(SEEDED_ID)
    })

    const [path, input] = client.post.mock.calls[0]
    expect(path).toBe('/v1/threads/share')
    expect(input.thread.messages[0].attachments).toEqual([
      {
        id: 'att_scan',
        type: 'document',
        fileName: 'scan.pdf',
        textContent: 'First page\n\nSecond page',
      },
    ])
  })

  it('refuses to send a local share larger than the harness reads', async () => {
    signIn('alice')
    await localThreadStore('device').update(SEEDED_ID, () => ({
      ...seededThread(),
      messages: [
        ...seededThread().messages,
        {
          id: 'u3',
          role: 'user' as const,
          createdAt: 't5',
          content: 'x'.repeat(8 * 1024 * 1024),
        },
      ],
    }))
    const { result } = renderHook(() =>
      useThread(SEEDED_ID, null, { local: true }),
    )
    await waitFor(() => expect(result.current.chat.messages).toHaveLength(5))

    const refusal = await result.current.share(SEEDED_ID).catch((e) => e)

    expect(refusal).toBeInstanceOf(HarnessError)
    expect(refusal).toMatchObject({ code: 'THREAD_TOO_LARGE', status: 413 })
    expect(client.post).not.toHaveBeenCalled()
  })
})

describe('signed-out chats', () => {
  it('stay in session storage and never open IndexedDB', async () => {
    const shared = globalThis.indexedDB
    const isolated = new IDBFactory()
    Object.defineProperty(globalThis, 'indexedDB', {
      configurable: true,
      value: isolated,
    })
    try {
      signIn(null)
      client.events.mockImplementation((_path: string, input: Turn) =>
        reply(
          input.threadId!,
          [{ id: 'msg_q', role: 'user', createdAt: 't1', content: 'Hello?' }],
          'msg_a',
          'Hi',
        )(),
      )
      const { result } = renderHook(() => useThread())
      await waitFor(() => expect(result.current.model).toBe('test-model'))

      await act(() => result.current.send({ content: 'Hello?' }))

      expect(turn()).toMatchObject({ local: true, content: 'Hello?' })
      expect(turn()).not.toHaveProperty('key')
      const [row] = JSON.parse(
        sessionStorage.getItem('tinfoil-sync-session-chats')!,
      )
      expect(row).toMatchObject({
        id: turn().threadId,
        isLocalOnly: true,
        messages: [
          { id: 'msg_q', role: 'user', content: 'Hello?' },
          { id: 'msg_a', role: 'assistant', content: 'Hi' },
        ],
      })
      expect(await isolated.databases()).toEqual([])
    } finally {
      Object.defineProperty(globalThis, 'indexedDB', {
        configurable: true,
        value: shared,
      })
    }
  })
})

describe('cloud chats', () => {
  it('still send the content key and no transcript when cloud sync is on', async () => {
    localStorage.setItem('tinfoil-settings-cloud-sync-enabled', 'true')
    localStorage.setItem(AUTH_ACTIVE_USER_ID, 'alice')
    const api = signIn('alice')
    publish({ keyReady: true })
    vi.spyOn(api, 'key').mockReturnValue('Y29udGVudC1rZXk=')
    client.post.mockImplementation(async (path: string) =>
      path === '/v1/threads/list' ? { threads: [], nextCursor: null } : {},
    )
    client.events.mockImplementation(
      frames(
        { type: 'RUN_STARTED', threadId: 'cloud-thread', runId: 'run-1' },
        { type: 'RUN_FINISHED', threadId: 'cloud-thread', runId: 'run-1' },
      ),
    )
    const { result } = renderHook(() => useThread(null, 'project-1'))
    await waitFor(() => expect(result.current.model).toBe('test-model'))

    await act(() => result.current.send({ content: 'Stored question' }))

    expect(turn()).toMatchObject({
      key: 'Y29udGVudC1rZXk=',
      projectId: 'project-1',
      ephemeral: false,
      content: 'Stored question',
    })
    expect(turn()).not.toHaveProperty('local')
    expect(turn()).not.toHaveProperty('thread')
    expect(result.current.chat.isLocalOnly).toBe(false)
    expect(await localThreadStore('device').list()).toEqual([])
  })

  it('list the open chat as active while its run streams', async () => {
    localStorage.setItem('tinfoil-settings-cloud-sync-enabled', 'true')
    localStorage.setItem(AUTH_ACTIVE_USER_ID, 'alice')
    const api = signIn('alice')
    publish({ keyReady: true })
    vi.spyOn(api, 'key').mockReturnValue('Y29udGVudC1rZXk=')
    const stored = summary('cloud-thread', 'Stored')
    client.post.mockImplementation(async (path: string) =>
      path === '/v1/threads/list'
        ? { threads: [stored], nextCursor: null }
        : path === '/v1/threads/get'
          ? { ...stored, messages: [], hasOlder: false }
          : {},
    )
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    client.events.mockImplementation(async function* () {
      yield {
        id: 0,
        event: { type: 'RUN_STARTED', threadId: stored.id, runId: 'run-1' },
      }
      await held
      yield {
        id: 1,
        event: { type: 'RUN_FINISHED', threadId: stored.id, runId: 'run-1' },
      }
    })
    const { result } = renderHook(() => useThread())
    const listed = () =>
      result.current.chats.find((chat) => chat.id === stored.id)
    await waitFor(() => expect(listed()).toMatchObject({ activeRun: null }))
    await act(() => result.current.open(stored.id))
    expect(result.current.chat.id).toBe(stored.id)

    let sending: Promise<unknown> | undefined
    act(() => {
      sending = result.current.send({ content: 'More' })
    })
    await waitFor(() =>
      expect(listed()?.activeRun).toMatchObject({ runId: 'run-1' }),
    )
    await act(async () => {
      release()
      await sending
    })
    expect(listed()?.activeRun).toBeNull()
  })

  it('are shared by id with the content key', async () => {
    localStorage.setItem('tinfoil-settings-cloud-sync-enabled', 'true')
    localStorage.setItem(AUTH_ACTIVE_USER_ID, 'alice')
    const api = signIn('alice')
    publish({ keyReady: true })
    vi.spyOn(api, 'key').mockReturnValue('Y29udGVudC1rZXk=')
    client.post.mockImplementation(async (path: string) =>
      path === '/v1/threads/list'
        ? { threads: [], nextCursor: null }
        : { url: 'https://chat.tinfoil.sh/share/cloud-thread#v2:k' },
    )
    const { result } = renderHook(() => useThread())
    await waitFor(() => expect(client.post).toHaveBeenCalled())

    const url = await result.current.share('cloud-thread')

    expect(url).toBe('https://chat.tinfoil.sh/share/cloud-thread#v2:k')
    expect(client.post).toHaveBeenLastCalledWith(
      '/v1/threads/share',
      { key: 'Y29udGVudC1rZXk=', threadId: 'cloud-thread' },
      expect.any(AbortSignal),
    )
  })
})
