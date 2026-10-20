import { localThreadStore } from '@/services/harness/local-threads'
import { HarnessError } from '@/services/harness/sse'
import type {
  AttachmentDescriptor,
  Frame,
  Message,
  StoredThread,
  ThreadMessage,
  Turn,
} from '@/services/harness/types'
import { useThread } from '@/services/harness/use-thread'
import { indexedDBStorage } from '@/services/storage/indexed-db'
import { act, renderHook, waitFor } from '@testing-library/react'
import { IDBFactory } from 'fake-indexeddb'
import { describe, expect, it, vi } from 'vitest'
import {
  client,
  KEY,
  signIn as signInTo,
  testSession,
} from '../../harness-fixture'
import {
  rawRows,
  resetChatStoresAroundEachTest,
  storedThread,
} from './thread-fixture'

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

// Without cloud sync, the account's content key stays locked.
const signIn = (userId: string | null, cloud = false) =>
  signInTo({
    userId,
    cloud,
    locked: !cloud,
    session: { ...testSession, widgets: ['render_chart'] },
    profile: PROFILE,
  })

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

// A device run's final event, which returns the whole thread.
function finished(threadId: string, thread: StoredThread, runId = 'run-1') {
  return {
    type: 'RUN_FINISHED',
    threadId,
    runId,
    metadata: { thread },
  } satisfies Frame['event']
}

// A device run that shows its window and returns the thread.
function deviceRun(threadId: string, thread: StoredThread, runId = 'run-1') {
  return frames(
    { type: 'RUN_STARTED', threadId, runId },
    {
      type: 'MESSAGES_SNAPSHOT',
      messages: thread.messages as Message[],
      hasOlder: false,
    },
    finished(threadId, thread, runId),
  )
}

const turn = (call = 0) => client.events.mock.calls[call][1] as Turn
const stored = (id: string) => localThreadStore('device').get(id)

const SEEDED_ID = '8233746419000_1c4e7a52-9a2b-4f7e-8d1a-5b6c7d8e9f00'
const SEEDED_MESSAGES: ThreadMessage[] = [
  { id: 'u1', role: 'user', createdAt: 't1', content: 'first' },
  {
    id: 'a1',
    role: 'assistant',
    createdAt: 't2',
    model: 'test-model',
    timeline: [{ id: 'b1', type: 'content', content: 'first answer' }],
  },
  { id: 'u2', role: 'user', createdAt: 't3', content: 'second' },
  {
    id: 'a2',
    role: 'assistant',
    createdAt: 't4',
    model: 'test-model',
    timeline: [{ id: 'b2', type: 'content', content: 'second answer' }],
  },
]
const seeded = (fields: Partial<StoredThread> = {}) =>
  storedThread(SEEDED_ID, {
    title: 'Doors',
    titleState: 'generated',
    updatedAt: '2026-04-01T09:05:00Z',
    lastRequestId: 'request-0',
    messages: SEEDED_MESSAGES,
    ...fields,
  })

resetChatStoresAroundEachTest()

describe('local chats of a signed-in account without cloud sync', () => {
  it('sends a turn without a key and stores the thread its run returns', async () => {
    const api = signIn('alice')
    expect(() => api.key()).toThrow(HarnessError)
    let returned!: StoredThread
    client.events.mockImplementation((_path: string, input: Turn) => {
      const threadId = input.threadId!
      returned = storedThread(threadId, {
        title: 'Greeting',
        titleState: 'generated',
        createdAt: '2026-05-01T10:00:00Z',
        updatedAt: '2026-05-01T10:00:06Z',
        lastRequestId: input.clientRequestId,
        contextUsage: { usedTokens: 30, limitTokens: 1000, percentage: 3 },
        messages: [
          {
            id: input.clientRequestId,
            role: 'user',
            createdAt: '2026-05-01T10:00:01Z',
            content: 'Hi there',
          },
          {
            id: 'msg_reply',
            role: 'assistant',
            createdAt: '2026-05-01T10:00:03Z',
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
      return frames(
        { type: 'RUN_STARTED', threadId, runId: 'run-1' },
        {
          type: 'MESSAGES_SNAPSHOT',
          messages: [returned.messages[0] as Message],
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
        finished(threadId, returned),
      )()
    })
    const { result } = renderHook(() => useThread())
    await waitFor(() => expect(result.current.model).toBe('test-model'))

    await act(() => result.current.send({ content: 'Hi there' }))

    const input = turn()
    const threadId = input.threadId!
    expect(client.events.mock.calls[0][0]).toBe('/v1/threads/turn')
    expect(threadId).toMatch(REVERSE_ID)
    expect(input).toEqual({
      clientRequestId: expect.any(String),
      threadId,
      kind: 'send',
      local: true,
      content: 'Hi there',
      widgets: ['render_chart'],
      options: { model: 'test-model', timezone: expect.any(String) },
      profile: PROFILE,
    })
    expect(await stored(threadId)).toEqual(returned)
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

  it('lists a new chat with its message as soon as it is sent', async () => {
    signIn('alice')
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let returned!: StoredThread
    client.events.mockImplementation(async function* (
      _path: string,
      input: Turn,
    ) {
      const threadId = input.threadId!
      const question = {
        id: input.clientRequestId,
        role: 'user' as const,
        createdAt: 't1',
        content: 'Hi',
      }
      returned = storedThread(threadId, {
        title: 'Greeting',
        titleState: 'generated',
        lastRequestId: input.clientRequestId,
        messages: [question],
      })
      yield { id: 0, event: { type: 'RUN_STARTED', threadId, runId: 'run-1' } }
      await held
      yield { id: 1, event: finished(threadId, returned) }
    })
    const { result } = renderHook(() => useThread())
    await waitFor(() => expect(result.current.model).toBe('test-model'))
    let sending!: Promise<boolean | undefined> | undefined
    act(() => {
      sending = result.current.send({ content: 'Hi' })
    })

    await waitFor(() => expect(result.current.chats).toHaveLength(1))
    const threadId = turn().threadId!
    expect(result.current.chats[0]).toMatchObject({
      id: threadId,
      title: 'New Chat',
      isLocalOnly: true,
      messageCount: 1,
    })
    expect(result.current.chat.pendingSave).toBe(false)
    expect((await stored(threadId))?.messages).toEqual([
      {
        id: turn().clientRequestId,
        role: 'user',
        createdAt: expect.any(String),
        content: 'Hi',
      },
    ])
    // The harness makes the chat from its first turn.
    expect(turn()).not.toHaveProperty('thread')

    await act(async () => {
      release()
      await sending
    })

    expect(await stored(threadId)).toEqual(returned)
  })

  it("keeps a title set on this device while a reply streams over the run's", async () => {
    signIn('alice')
    await localThreadStore('device').update(SEEDED_ID, () => seeded())
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const returned = seeded({
      title: 'Generated',
      titleState: 'generated',
      messages: [
        ...SEEDED_MESSAGES,
        { id: 'u3', role: 'user', createdAt: 't5', content: 'third' },
      ],
    })
    client.events.mockImplementation(async function* () {
      yield {
        id: 0,
        event: { type: 'RUN_STARTED', threadId: SEEDED_ID, runId: 'run-1' },
      }
      await held
      yield {
        id: 1,
        event: {
          type: 'STATE_SNAPSHOT',
          snapshot: {
            thread: { ...summary(SEEDED_ID, 'Generated'), messageCount: 5 },
            queue: [],
          },
        },
      }
      yield { id: 2, event: finished(SEEDED_ID, returned) }
    })
    const { result } = renderHook(() =>
      useThread(SEEDED_ID, null, { local: true }),
    )
    await waitFor(() => expect(result.current.chat.messages).toHaveLength(4))
    let sending!: Promise<boolean | undefined> | undefined
    act(() => {
      sending = result.current.send({ content: 'third' })
    })
    await waitFor(() => expect(result.current.running).toBe(true))
    client.post.mockImplementationOnce(
      async (_path: string, input: { thread: StoredThread }) => ({
        thread: { ...input.thread, title: 'Mine', titleState: 'manual' },
      }),
    )

    await act(() => result.current.update(SEEDED_ID, { title: 'Mine' }))
    await act(async () => {
      release()
      await sending
    })

    expect(await stored(SEEDED_ID)).toEqual({
      ...returned,
      title: 'Mine',
      titleState: 'manual',
    })
    expect(result.current.chat.title).toBe('Mine')
  })

  const QUESTION = {
    id: 'msg_user',
    role: 'user' as const,
    createdAt: 't1',
    content: 'Q',
  }
  const answered = (threadId: string) =>
    storedThread(threadId, {
      title: 'Answers',
      titleState: 'generated',
      messages: [
        QUESTION,
        {
          id: 'msg_reply',
          role: 'assistant',
          createdAt: 't2',
          model: 'test-model',
          timeline: [
            {
              id: 'msg_reply_content_0',
              type: 'content',
              content: 'Long answer',
            },
          ],
        },
      ],
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
          messages: [QUESTION],
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
      yield { id: 3, event: finished(threadId, answered(threadId)) }
    })
    return release
  }
  async function sendHeld(initialId: string | null = null) {
    const release = heldRun()
    const hook = renderHook(() =>
      useThread(initialId, null, { local: !!initialId }),
    )
    await waitFor(() => expect(hook.result.current.model).toBe('test-model'))
    if (initialId)
      await waitFor(() => expect(hook.result.current.chat.id).toBe(initialId))
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
    expect(await stored(threadId)).toEqual(answered(threadId))
  })

  it('lists a chat whose run streams here as active until the run ends', async () => {
    signIn('alice')
    await localThreadStore('device').update(SEEDED_ID, () => seeded())
    const { result, release, sending } = await sendHeld(SEEDED_ID)
    const listed = () =>
      result.current.chats.find((chat) => chat.id === SEEDED_ID)
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
    await localThreadStore('device').update(SEEDED_ID, () => seeded())
    const { result, release, sending } = await sendHeld(SEEDED_ID)

    act(() => result.current.newChat())
    await act(() => result.current.open(SEEDED_ID, { local: true }))

    expect(client.events.mock.calls[1].slice(0, 2)).toEqual([
      '/v1/threads/follow',
      { threadId: SEEDED_ID, runId: 'run-1' },
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
    expect(await stored(SEEDED_ID)).toEqual(answered(SEEDED_ID))
  })

  function reloadDuringRun() {
    sessionStorage.setItem(
      'harness-run:alice',
      JSON.stringify({
        threadId: SEEDED_ID,
        runId: 'run-a3',
        temporary: false,
        local: true,
      }),
    )
    return localThreadStore('device').update(SEEDED_ID, () => seeded())
  }

  it('keeps a run it could not reach, so reopening the chat rejoins it', async () => {
    signIn('alice')
    await reloadDuringRun()
    const unreachable = async function* () {
      throw new TypeError('Failed to fetch')
    }
    const question = {
      id: 'u3',
      role: 'user' as const,
      createdAt: 't5',
      content: 'third',
    }
    const returned = seeded({
      messages: [
        ...SEEDED_MESSAGES,
        question,
        {
          id: 'a3',
          role: 'assistant',
          createdAt: 't6',
          timeline: [
            { id: 'a3_content_0', type: 'content', content: 'third answer' },
          ],
        },
      ],
    })
    client.events
      .mockImplementationOnce(unreachable)
      .mockImplementationOnce(unreachable)
      .mockImplementationOnce(
        frames(
          { type: 'RUN_STARTED', threadId: SEEDED_ID, runId: 'run-a3' },
          {
            type: 'MESSAGES_SNAPSHOT',
            messages: [...SEEDED_MESSAGES, question] as Message[],
            hasOlder: false,
          },
          {
            type: 'TEXT_MESSAGE_CHUNK',
            messageId: 'a3',
            delta: 'third answer',
            timestamp: 't6',
          },
          { ...finished(SEEDED_ID, returned), runId: 'run-a3' },
        ),
      )
    const { result } = renderHook(() =>
      useThread(SEEDED_ID, null, { local: true }),
    )
    await waitFor(() => expect(client.events).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(result.current.chat.messages).toHaveLength(4))
    expect(result.current.error).toBe('')
    expect(sessionStorage.getItem('harness-run:alice')).not.toBeNull()

    await act(() => result.current.open(SEEDED_ID, { local: true }))

    expect(client.events.mock.calls[2].slice(0, 2)).toEqual([
      '/v1/threads/follow',
      { threadId: SEEDED_ID, runId: 'run-a3' },
    ])
    await waitFor(async () => expect(await stored(SEEDED_ID)).toEqual(returned))
    expect(sessionStorage.getItem('harness-run:alice')).toBeNull()
  })

  it('forgets a run the harness no longer has', async () => {
    signIn('alice')
    await reloadDuringRun()
    client.events.mockImplementationOnce(async function* () {
      throw new HarnessError(
        { code: 'RUN_NOT_FOUND', message: 'The run is not running here' },
        404,
      )
    })
    const { result } = renderHook(() =>
      useThread(SEEDED_ID, null, { local: true }),
    )

    await waitFor(() =>
      expect(sessionStorage.getItem('harness-run:alice')).toBeNull(),
    )
    expect(client.events).toHaveBeenCalledOnce()
    expect(result.current.error).toBe('')
    expect(result.current.chat.messages).toHaveLength(4)
  })

  it('leaves the next chat its own prompt when a late first send is dropped', async () => {
    signIn('alice')
    const device = localThreadStore('device')
    const read = device.get.bind(device)
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    vi.spyOn(device, 'get').mockImplementationOnce(async (id) => {
      await held
      return read(id)
    })
    const { result } = renderHook(() => useThread())
    await waitFor(() => expect(result.current.model).toBe('test-model'))
    await act(() => result.current.selectPreset('builtin:tutor'))
    let sending: Promise<boolean | undefined> | undefined
    act(() => {
      sending = result.current.send({ content: 'Hi' })
    })

    act(() => result.current.newChat())
    expect(result.current.presetId).toBeNull()
    await act(async () => {
      release()
      await sending
    })

    expect(result.current.presetId).toBeNull()
    expect(client.events).not.toHaveBeenCalled()
  })

  it('sends the stored thread with an edit and stores the thread its run returns', async () => {
    signIn('alice')
    await localThreadStore('device').update(SEEDED_ID, () => seeded())
    const [u1, a1] = SEEDED_MESSAGES
    let returned!: StoredThread
    client.events.mockImplementation((_path: string, input: Turn) => {
      returned = seeded({
        lastRequestId: input.clientRequestId,
        messages: [
          u1,
          a1,
          {
            id: input.clientRequestId,
            role: 'user',
            createdAt: 't5',
            content: 'second, edited',
          },
          {
            id: 'msg_new',
            role: 'assistant',
            createdAt: 't6',
            timeline: [{ id: 'b3', type: 'content', content: 'edited answer' }],
          },
        ],
      })
      return deviceRun(SEEDED_ID, returned)()
    })
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
      thread: seeded(),
    })
    expect(turn()).not.toHaveProperty('key')
    expect(await stored(SEEDED_ID)).toEqual(returned)
  })

  it("sends an image's model copy, and keeps the picked file apart to show", async () => {
    signIn('alice')
    const bytes = new Uint8Array([137, 80, 78, 71])
    const original = btoa(String.fromCharCode(...bytes))
    const modelCopy = 'bW9kZWwtY29weQ=='
    const view: AttachmentDescriptor = {
      id: 'att_door',
      kind: 'image',
      fileName: 'door.png',
      mimeType: 'image/jpeg',
      size: 4,
      thumbnail: 'dGh1bWI=',
    }
    client.upload.mockResolvedValue({
      attachment: { ...view, base64: modelCopy },
    })
    client.events.mockImplementation((_path: string, input: Turn) =>
      deviceRun(
        input.threadId!,
        storedThread(input.threadId!, {
          messages: [
            {
              id: input.clientRequestId,
              role: 'user',
              createdAt: 't1',
              content: 'What door?',
              attachments: [{ ...view, description: 'A red door' }],
            },
            {
              id: 'msg_answer',
              role: 'assistant',
              createdAt: 't2',
              timeline: [{ id: 'b1', type: 'content', content: 'A red one' }],
            },
          ],
        }),
      )(),
    )
    const first = renderHook(() => useThread())
    await waitFor(() => expect(first.result.current.model).toBe('test-model'))

    let uploaded!: AttachmentDescriptor
    await act(async () => {
      uploaded = await first.result.current.upload(
        new File([bytes], 'door.png', { type: 'image/png' }),
      )
    })
    expect(uploaded).toEqual({ ...view, base64: modelCopy })
    expect(client.upload).toHaveBeenCalledExactlyOnceWith(
      '/v1/attachments/upload',
      expect.any(File),
      {},
      expect.any(AbortSignal),
    )
    await act(() =>
      first.result.current.send({
        content: 'What door?',
        attachments: [uploaded],
      }),
    )
    const threadId = turn().threadId!
    expect(turn().attachments).toEqual([{ ...view, base64: modelCopy }])
    const kept = { ...view, description: 'A red door', base64: modelCopy }
    expect((await stored(threadId))?.messages[0].attachments).toEqual([kept])
    expect(await rawRows('attachmentOriginals')).toEqual([
      {
        chatId: threadId,
        attachmentId: 'att_door',
        base64: original,
        mimeType: 'image/png',
      },
    ])
    first.unmount()

    client.events.mockImplementation(
      deviceRun(threadId, storedThread(threadId)),
    )
    const reloaded = renderHook(() =>
      useThread(threadId, null, { local: true }),
    )
    await waitFor(() =>
      expect(reloaded.result.current.chat.messages).toHaveLength(2),
    )
    const image = await reloaded.result.current.loadImage(
      reloaded.result.current.chat.messages[0].attachments![0],
    )
    expect(image.type).toBe('image/png')
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(bytes)

    await act(() => reloaded.result.current.send({ content: 'And now?' }))

    expect(turn(1).thread?.messages[0].attachments).toEqual([kept])
  })

  it('sends the stored chat with every image it holds', async () => {
    signIn('alice')
    const photos = ['p1', 'p2', 'p3', 'p4'].map((id): ThreadMessage => ({
      id,
      role: 'user',
      createdAt: 't1',
      content: 'Look',
      attachments: [
        {
          id: `att_${id}`,
          kind: 'image',
          fileName: `${id}.jpg`,
          mimeType: 'image/jpeg',
          size: 5,
          base64: btoa(id),
        },
      ],
    }))
    await localThreadStore('device').update(SEEDED_ID, () =>
      seeded({ messages: photos }),
    )
    client.events.mockImplementation(
      deviceRun(SEEDED_ID, seeded({ messages: photos })),
    )
    const { result } = renderHook(() =>
      useThread(SEEDED_ID, null, { local: true }),
    )
    await waitFor(() => expect(result.current.chat.messages).toHaveLength(4))

    await act(() => result.current.send({ content: 'Which is best?' }))

    expect(turn().thread).toEqual(seeded({ messages: photos }))
  })

  it("shows an image's model copy when this device has no original, and deletes an original with its message", async () => {
    signIn('alice')
    const photo: AttachmentDescriptor = {
      id: 'att_photo',
      kind: 'image',
      fileName: 'photo.png',
      mimeType: 'image/jpeg',
      size: 5,
      thumbnail: 'dGh1bWI=',
      base64: 'bW9kZWw=',
    }
    const messages = SEEDED_MESSAGES.map((message) =>
      message.id === 'u2' ? { ...message, attachments: [photo] } : message,
    )
    await localThreadStore('device').update(SEEDED_ID, () =>
      seeded({ messages }),
    )
    const { result } = renderHook(() =>
      useThread(SEEDED_ID, null, { local: true }),
    )
    await waitFor(() => expect(result.current.chat.messages).toHaveLength(4))

    const image = await result.current.loadImage(
      result.current.chat.messages[2].attachments![0],
    )
    expect(image.type).toBe('image/jpeg')
    expect(await image.text()).toBe('model')

    await localThreadStore('device').update(
      SEEDED_ID,
      (thread) => thread,
      new Map([
        ['att_photo', { base64: 'b3JpZ2luYWw=', mimeType: 'image/png' }],
      ]),
    )
    expect(await rawRows('attachmentOriginals')).toHaveLength(1)
    client.post.mockResolvedValueOnce({
      thread: seeded({ messages: messages.filter((m) => m.id !== 'u2') }),
    })
    await act(() => result.current.deleteMessage(2))

    expect(await rawRows('attachmentOriginals')).toEqual([])
  })

  it('upgrades a chat the previous client stored through the harness, and sends it upgraded', async () => {
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
        },
      ],
    })
    const upgraded = storedThread(SEEDED_ID, {
      title: 'Cats',
      titleState: 'generated',
      messages: [
        {
          id: `${SEEDED_ID}-message-0`,
          role: 'user',
          createdAt: '2026-01-01T00:00:01Z',
          content: 'Look at this',
          attachments: [
            {
              id: `${SEEDED_ID}-message-0-attachment-0`,
              kind: 'image',
              fileName: 'image-0',
              mimeType: 'image/jpeg',
              size: 3,
              base64: 'aW1n',
            },
          ],
        },
        {
          id: `${SEEDED_ID}-message-1`,
          role: 'assistant',
          createdAt: '2026-01-01T00:00:02Z',
          timeline: [
            {
              id: `${SEEDED_ID}-message-1-content`,
              type: 'content',
              content: 'A cat',
            },
          ],
        },
      ],
    })
    client.post.mockImplementation(async (path: string) => {
      if (path === '/v1/threads/upgrade') return { threads: [upgraded] }
      throw new Error(`Unexpected ${path}`)
    })
    client.events.mockImplementation(deviceRun(SEEDED_ID, upgraded))
    const { result } = renderHook(() =>
      useThread(SEEDED_ID, null, { local: true }),
    )

    await waitFor(() =>
      expect(result.current.chat.messages.map((m) => m.content)).toEqual([
        'Look at this',
        'A cat',
      ]),
    )
    expect(client.post).toHaveBeenCalledExactlyOnceWith(
      '/v1/threads/upgrade',
      {
        threads: [
          expect.objectContaining({
            id: SEEDED_ID,
            title: 'Cats',
            messages: [
              expect.objectContaining({
                content: 'Look at this',
                imageData: [{ base64: 'aW1n', mimeType: 'image/jpeg' }],
              }),
              expect.objectContaining({ content: 'A cat' }),
            ],
          }),
        ],
      },
      expect.any(AbortSignal),
    )

    await act(() => result.current.send({ content: 'Sure?' }))

    expect(turn().thread).toEqual(upgraded)
  })

  it("shows the messages before a run's window from the copy on this device", async () => {
    signIn('alice')
    await localThreadStore('device').update(SEEDED_ID, () => seeded())
    const [, , u2, a2] = SEEDED_MESSAGES
    const question = {
      id: 'u3',
      role: 'user' as const,
      createdAt: 't5',
      content: 'third',
    }
    client.events.mockImplementation(
      frames(
        { type: 'RUN_STARTED', threadId: SEEDED_ID, runId: 'run-1' },
        {
          type: 'MESSAGES_SNAPSHOT',
          messages: [u2, a2, question] as Message[],
          hasOlder: true,
        },
        finished(
          SEEDED_ID,
          seeded({ messages: [...SEEDED_MESSAGES, question] }),
        ),
      ),
    )
    const { result } = renderHook(() =>
      useThread(SEEDED_ID, null, { local: true }),
    )
    await waitFor(() => expect(result.current.chat.messages).toHaveLength(4))
    await act(() => result.current.send({ content: 'third' }))
    expect(result.current.hasOlder).toBe(true)

    await act(() => result.current.older())

    expect(result.current.chat.messages.map((m) => m.id)).toEqual([
      'u1',
      'a1',
      'u2',
      'a2',
      'u3',
    ])
    expect(result.current.hasOlder).toBe(false)
    expect(client.post).not.toHaveBeenCalled()
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
    client.post.mockImplementation(async (path: string) => {
      if (['/v1/threads/cancel', '/v1/threads/queue/remove'].includes(path))
        return {}
      throw new Error(`Unexpected ${path}`)
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
  const PHOTO: AttachmentDescriptor = {
    id: 'att_photo',
    kind: 'image',
    fileName: 'photo.png',
    mimeType: 'image/png',
    size: 5,
    thumbnail: 'dGh1bWI=',
    base64: 'cGhvdG8=',
  }
  const withPhoto = () =>
    seeded({
      messages: SEEDED_MESSAGES.map((message) =>
        message.id === 'u2' ? { ...message, attachments: [PHOTO] } : message,
      ),
    })
  async function openSeeded() {
    signIn('alice')
    await localThreadStore('device').update(SEEDED_ID, withPhoto)
    const hook = renderHook(() => useThread(SEEDED_ID, null, { local: true }))
    await waitFor(() =>
      expect(hook.result.current.chat.messages).toHaveLength(4),
    )
    return hook
  }

  // The harness's answer to a change of the chat this device sent, which
  // leaves image bytes out.
  const withoutBytes = (thread: StoredThread): StoredThread => ({
    ...thread,
    messages: thread.messages.map((message) =>
      message.attachments
        ? {
            ...message,
            attachments: message.attachments.map(
              ({ base64: _, ...attachment }) => attachment,
            ),
          }
        : message,
    ),
  })

  it('renames a chat through the harness and stores the chat it returns', async () => {
    const { result } = await openSeeded()
    const renamed = {
      ...withPhoto(),
      title: 'Front doors',
      titleState: 'manual' as const,
      updatedAt: '2026-04-01T09:06:00Z',
    }
    client.post.mockResolvedValueOnce({ thread: withoutBytes(renamed) })

    await act(() => result.current.update(SEEDED_ID, { title: 'Front doors' }))

    expect(client.post).toHaveBeenCalledExactlyOnceWith(
      '/v1/threads/update',
      {
        id: SEEDED_ID,
        title: 'Front doors',
        local: true,
        thread: withPhoto(),
      },
      expect.any(AbortSignal),
    )
    expect(await stored(SEEDED_ID)).toEqual(renamed)
    expect(result.current.chat.title).toBe('Front doors')
  })

  it('sends a change again when a reply finished while the harness made it', async () => {
    const { result } = await openSeeded()
    const replied = seeded({
      messages: [
        ...withPhoto().messages,
        { id: 'u3', role: 'user', createdAt: 't5', content: 'third' },
      ],
    })
    let answer!: (value: unknown) => void
    client.post
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            answer = resolve
          }),
      )
      .mockResolvedValueOnce({ thread: { ...replied, title: 'Front doors' } })

    let renaming!: Promise<unknown>
    act(() => {
      renaming = result.current.update(SEEDED_ID, { title: 'Front doors' })
    })
    await waitFor(() => expect(client.post).toHaveBeenCalledTimes(1))
    await localThreadStore('device').update(SEEDED_ID, () => replied)
    await act(async () => {
      answer({ thread: { ...withPhoto(), title: 'Front doors' } })
      await renaming
    })

    expect(client.post.mock.calls[1][1]).toEqual({
      id: SEEDED_ID,
      title: 'Front doors',
      local: true,
      thread: replied,
    })
    expect(await stored(SEEDED_ID)).toEqual({
      ...replied,
      title: 'Front doors',
    })
  })

  it('forks a chat through the harness, which names the fork', async () => {
    const { result } = await openSeeded()
    const FORK_ID = '8233746420000_2d5f8b63-0a3c-4f8e-9e2d-6c7d8e9f0a11'
    const [u1, a1, u2] = withPhoto().messages
    const fork = storedThread(FORK_ID, {
      title: 'Doors (fork)',
      titleState: 'manual',
      messages: [u1, a1, u2],
    })
    client.post.mockResolvedValueOnce({ thread: withoutBytes(fork) })

    let forkId: string | null = null
    await act(async () => {
      forkId = await result.current.fork(2)
    })

    expect(client.post).toHaveBeenCalledExactlyOnceWith(
      '/v1/threads/fork',
      {
        threadId: SEEDED_ID,
        messageId: 'u2',
        local: true,
        thread: withPhoto(),
      },
      expect.any(AbortSignal),
    )
    expect(forkId).toBe(FORK_ID)
    expect(await stored(FORK_ID)).toEqual(fork)
    expect(await stored(SEEDED_ID)).toEqual(withPhoto())
    expect(result.current.chat.id).toBe(FORK_ID)
    expect(result.current.chat.isLocalOnly).toBe(true)
  })

  it('deletes a chat from the device', async () => {
    const { result } = await openSeeded()

    await act(() => result.current.remove(SEEDED_ID))

    expect(await stored(SEEDED_ID)).toBeNull()
    expect(result.current.chat.id).toBe('')
    expect(client.post).not.toHaveBeenCalled()
  })

  it('asks about a local chat with its thread instead of a key', async () => {
    const { result } = await openSeeded()

    const context = await result.current.askContext()

    expect(context).toEqual({
      threadId: SEEDED_ID,
      local: true,
      thread: withPhoto(),
      profile: PROFILE,
    })
  })

  it('shares a local chat from its copy without image bytes or a key', async () => {
    const { result } = await openSeeded()
    client.post.mockResolvedValue({ url: 'https://chat.tinfoil.sh/share/x' })

    let url = ''
    await act(async () => {
      url = await result.current.share(SEEDED_ID)
    })

    expect(url).toBe('https://chat.tinfoil.sh/share/x')
    const { base64: _, ...thumbnailOnly } = PHOTO
    expect(client.post).toHaveBeenCalledExactlyOnceWith(
      '/v1/threads/share',
      {
        local: true,
        threadId: SEEDED_ID,
        thread: seeded({
          messages: SEEDED_MESSAGES.map((message) =>
            message.id === 'u2'
              ? { ...message, attachments: [thumbnailOnly] }
              : message,
          ),
        }),
      },
      expect.any(AbortSignal),
    )
    // The stored copy keeps its bytes.
    expect(await stored(SEEDED_ID)).toEqual(withPhoto())
  })

  it('shares the page text of a document stored without extracted text', async () => {
    signIn('alice')
    const page = (number: number, text: string) => ({
      page: number,
      text,
      image: 'cGFnZQ==',
      is_scanned: true,
    })
    await localThreadStore('device').update(SEEDED_ID, () =>
      seeded({
        messages: [
          {
            id: 'u1',
            role: 'user',
            createdAt: 't1',
            content: 'Read this',
            attachments: [
              {
                id: 'att_scan',
                kind: 'document',
                fileName: 'scan.pdf',
                mimeType: 'application/pdf',
                size: 9,
                pages: [page(1, 'First page'), page(2, 'Second page')],
              },
            ],
          },
        ],
      }),
    )
    const { result } = renderHook(() =>
      useThread(SEEDED_ID, null, { local: true }),
    )
    await waitFor(() => expect(result.current.chat.messages).toHaveLength(1))
    client.post.mockResolvedValueOnce({
      url: 'https://chat.tinfoil.sh/share/x',
    })

    await act(async () => {
      await result.current.share(SEEDED_ID)
    })

    const [path, input] = client.post.mock.calls[0]
    expect(path).toBe('/v1/threads/share')
    expect(input.thread.messages[0].attachments).toEqual([
      {
        id: 'att_scan',
        kind: 'document',
        fileName: 'scan.pdf',
        mimeType: 'application/pdf',
        size: 9,
        textContent: 'First page\n\nSecond page',
      },
    ])
  })

  it('refuses to send a local share larger than the harness reads', async () => {
    signIn('alice')
    await localThreadStore('device').update(SEEDED_ID, () =>
      seeded({
        messages: [
          ...SEEDED_MESSAGES,
          {
            id: 'u3',
            role: 'user',
            createdAt: 't5',
            content: 'x'.repeat(8 * 1024 * 1024),
          },
        ],
      }),
    )
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
      const messages: ThreadMessage[] = [
        { id: 'msg_q', role: 'user', createdAt: 't1', content: 'Hello?' },
        {
          id: 'msg_a',
          role: 'assistant',
          createdAt: 't2',
          timeline: [{ id: 'b1', type: 'content', content: 'Hi' }],
        },
      ]
      client.events.mockImplementation((_path: string, input: Turn) =>
        deviceRun(
          input.threadId!,
          storedThread(input.threadId!, { messages }),
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
        threadFormat: 1,
        messages,
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

describe('temporary chats', () => {
  it.each([
    ['with cloud sync', 'alice', true],
    ['without cloud sync', 'alice', false],
    ['signed out', null, false],
  ] as const)(
    'run as chats on this device held in page memory %s',
    async (_mode, userId, cloud) => {
      signIn(userId, cloud)
      client.post.mockImplementation(async (path: string) => {
        if (path === '/v1/threads/list')
          return { threads: [], nextCursor: null }
        throw new Error(`Unexpected ${path}`)
      })
      const returned: StoredThread[] = []
      client.events.mockImplementation((_path: string, input: Turn) => {
        const thread = storedThread(input.threadId!, {
          lastRequestId: input.clientRequestId,
          messages: [
            ...(input.thread?.messages ?? []),
            {
              id: input.clientRequestId,
              role: 'user',
              createdAt: 't1',
              content: input.content,
            },
            {
              id: `reply-${returned.length}`,
              role: 'assistant',
              createdAt: 't2',
              timeline: [{ id: 'b1', type: 'content', content: 'Noted' }],
            },
          ],
        })
        returned.push(thread)
        return deviceRun(input.threadId!, thread, `run-${returned.length}`)()
      })
      const { result } = renderHook(() => useThread())
      await waitFor(() => expect(result.current.model).toBe('test-model'))
      act(() => result.current.setTemporary(true))

      await act(() => result.current.send({ content: 'Off the record' }))
      await act(() => result.current.send({ content: 'Still off' }))

      expect(turn(1)).toEqual({
        clientRequestId: expect.any(String),
        threadId: turn().threadId,
        kind: 'send',
        widgets: ['render_chart'],
        options: { model: 'test-model', timezone: expect.any(String) },
        content: 'Still off',
        local: true,
        thread: returned[0],
        profile: PROFILE,
      })
      expect(result.current.chat).toMatchObject({
        id: turn().threadId,
        isTemporary: true,
        isLocalOnly: false,
      })
      expect(result.current.chat.messages.map((m) => m.id)).toEqual(
        returned[1].messages.map((m) => m.id),
      )
      expect(result.current.chats).toEqual([])
      expect(await rawRows('chats')).toEqual([])
      expect(sessionStorage.getItem('tinfoil-sync-session-chats')).toBeNull()
    },
  )
})

describe('cloud chats', () => {
  it('still send the content key and no transcript when cloud sync is on', async () => {
    signIn('alice', true)
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
      key: KEY,
      projectId: 'project-1',
      content: 'Stored question',
    })
    expect(turn()).not.toHaveProperty('local')
    expect(turn()).not.toHaveProperty('thread')
    expect(result.current.chat.isLocalOnly).toBe(false)
    expect(await localThreadStore('device').list()).toEqual([])
  })

  it('name a new chat and send again after its first message was refused', async () => {
    signIn('alice', true)
    client.post.mockImplementation(async (path: string) => {
      if (path === '/v1/threads/list') return { threads: [], nextCursor: null }
      throw new Error(`Unexpected ${path}`)
    })
    client.events
      .mockImplementationOnce(async function* () {
        throw new HarnessError(
          { code: 'RATE_LIMITED', message: 'Chat access is busy' },
          429,
        )
      })
      .mockImplementationOnce((_path: string, input: Turn) =>
        frames(
          { type: 'RUN_STARTED', threadId: input.threadId!, runId: 'run-1' },
          { type: 'RUN_FINISHED', threadId: input.threadId!, runId: 'run-1' },
        )(),
      )
    const { result } = renderHook(() => useThread(null, 'project-1'))
    await waitFor(() => expect(result.current.model).toBe('test-model'))

    await act(() => result.current.send({ content: 'First try' }))

    const threadId = turn().threadId
    expect(threadId).toMatch(REVERSE_ID)
    expect(result.current.chat).toMatchObject({
      id: threadId,
      pendingSave: true,
    })
    expect(result.current.chat.messages).toEqual([
      expect.objectContaining({
        id: turn().clientRequestId,
        role: 'user',
        content: 'First try',
      }),
    ])
    expect(result.current.error).toBe('Chat access is busy')

    await act(() => result.current.send({ content: 'Second try' }))

    expect(client.events).toHaveBeenCalledTimes(2)
    expect(turn(1)).toMatchObject({
      threadId,
      projectId: 'project-1',
      content: 'Second try',
    })
    expect(turn(1).clientRequestId).not.toBe(turn().clientRequestId)
    expect(result.current.chat).toMatchObject({
      id: threadId,
      pendingSave: false,
    })
  })

  describe('whose stream drops mid-reply', () => {
    const stored = summary('cloud-thread', 'Stored')
    const question = {
      id: 'u1',
      role: 'user' as const,
      createdAt: 't1',
      content: 'Question',
    }
    const started: Frame['event'][] = [
      { type: 'RUN_STARTED', threadId: stored.id, runId: 'run-1' },
      { type: 'MESSAGES_SNAPSHOT', messages: [question], hasOlder: false },
      { type: 'TEXT_MESSAGE_CHUNK', messageId: 'a1', delta: 'Hel' },
    ]
    function dropsAfter(events: Frame['event'][]) {
      return async function* () {
        for (const [id, event] of events.entries()) yield { id, event }
        throw new TypeError('network error')
      }
    }
    async function openStored(answer = 'Hello') {
      signIn('alice', true)
      client.post.mockImplementation(async (path: string) => {
        if (path === '/v1/threads/list')
          return { threads: [], nextCursor: null }
        if (path === '/v1/threads/get')
          return {
            ...stored,
            messages: [
              question,
              {
                id: 'a1',
                role: 'assistant',
                createdAt: 't2',
                timeline: [{ id: 'b1', type: 'content', content: answer }],
              },
            ],
            hasOlder: false,
          }
        throw new Error(`Unexpected ${path}`)
      })
      const hook = renderHook(() => useThread(stored.id))
      await waitFor(() => expect(hook.result.current.chat.id).toBe(stored.id))
      return hook
    }

    it('rejoin their run, which replays it', async () => {
      const { result } = await openStored()
      client.events
        .mockImplementationOnce(dropsAfter(started))
        .mockImplementationOnce(
          frames(
            ...started,
            { type: 'TEXT_MESSAGE_CHUNK', messageId: 'a1', delta: 'lo' },
            { type: 'RUN_FINISHED', threadId: stored.id, runId: 'run-1' },
          ),
        )

      await act(() => result.current.send({ content: 'Question' }))

      expect(client.events.mock.calls[1]).toEqual([
        '/v1/threads/follow',
        { key: KEY, threadId: stored.id, runId: 'run-1' },
        expect.any(AbortSignal),
      ])
      expect(result.current.chat.messages.map((m) => m.content)).toEqual([
        'Question',
        'Hello',
      ])
      expect(result.current.status).toBe('idle')
      expect(result.current.error).toBe('')
    })

    it('stop streaming when they cannot rejoin, and show the chat once the run is gone', async () => {
      const { result } = await openStored('Hello, from storage')
      client.events
        .mockImplementationOnce(dropsAfter(started))
        .mockImplementationOnce(dropsAfter([]))

      await act(() => result.current.send({ content: 'Question' }))

      expect(client.events).toHaveBeenCalledTimes(2)
      expect(result.current.running).toBe(false)
      expect(result.current.status).toBe('error')
      expect(result.current.errorDetail).toEqual({
        code: 'STREAM_INTERRUPTED',
        message: 'The connection closed. Reconnect to continue.',
      })
      client.events.mockImplementationOnce(async function* () {
        throw new HarnessError(
          { code: 'RUN_NOT_FOUND', message: 'The run is not running here' },
          404,
        )
      })

      await act(() => result.current.retry())

      expect(client.events.mock.calls[2].slice(0, 2)).toEqual([
        '/v1/threads/follow',
        { key: KEY, threadId: stored.id, runId: 'run-1' },
      ])
      expect(result.current.chat.messages.map((m) => m.content)).toEqual([
        'Question',
        'Hello, from storage',
      ])
      expect(result.current.status).toBe('idle')
      expect(result.current.error).toBe('')
    })
  })

  it('show as stored, without an error, once the harness no longer has their run', async () => {
    signIn('alice', true)
    const stored = summary('cloud-thread', 'Stored')
    const question = {
      id: 'u1',
      role: 'user',
      createdAt: 't1',
      content: 'Question',
    }
    const answer = {
      id: 'a1',
      role: 'assistant',
      createdAt: 't2',
      timeline: [{ id: 'b1', type: 'content', content: 'Committed answer' }],
    }
    const reads = [
      {
        ...stored,
        activeRun: { runId: 'run-1', expiresAt: '2026-05-01T10:10:00Z' },
        messages: [question],
        hasOlder: false,
      },
      { ...stored, messages: [question, answer], hasOlder: false },
    ]
    client.post.mockImplementation(async (path: string) => {
      if (path === '/v1/threads/list') return { threads: [], nextCursor: null }
      if (path === '/v1/threads/get') return reads.shift()
      throw new Error(`Unexpected ${path}`)
    })
    client.events.mockImplementationOnce(async function* () {
      throw new HarnessError(
        { code: 'RUN_NOT_FOUND', message: 'The run is not running here' },
        404,
      )
    })

    const { result } = renderHook(() => useThread(stored.id))

    await waitFor(() =>
      expect(result.current.chat.messages.map((m) => m.content)).toEqual([
        'Question',
        'Committed answer',
      ]),
    )
    expect(client.events.mock.calls[0].slice(0, 2)).toEqual([
      '/v1/threads/follow',
      { key: KEY, threadId: stored.id, runId: 'run-1' },
    ])
    expect(result.current.error).toBe('')
    expect(result.current.status).toBe('idle')
  })

  it('keep the chat list when a chat opens from its link', async () => {
    signIn('alice', true)
    const listed = [summary('cloud-a', 'First'), summary('cloud-b', 'Second')]
    let releaseList!: () => void
    const listing = new Promise<void>((resolve) => {
      releaseList = resolve
    })
    client.post.mockImplementation(async (path: string) => {
      if (path === '/v1/threads/list') {
        await listing
        return { threads: listed, nextCursor: null }
      }
      if (path === '/v1/threads/get')
        return { ...listed[0], messages: [], hasOlder: false }
      throw new Error(`Unexpected ${path}`)
    })
    const { result } = renderHook(() => useThread('cloud-a'))
    await waitFor(() => expect(result.current.chat.id).toBe('cloud-a'))

    await act(async () => {
      releaseList()
      await listing
    })

    await waitFor(() =>
      expect(result.current.chats.map((chat) => chat.id)).toEqual([
        'cloud-a',
        'cloud-b',
      ]),
    )
  })

  it('list the open chat as active while its run streams', async () => {
    signIn('alice', true)
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

  it('keep streaming a reply when another action fails', async () => {
    signIn('alice', true)
    const stored = summary('cloud-thread', 'Stored')
    const refusal = new HarnessError(
      { code: 'UPSTREAM_REFUSED', message: 'The chat could not be renamed' },
      502,
    )
    client.post.mockImplementation(async (path: string) => {
      if (path === '/v1/threads/list')
        return { threads: [stored], nextCursor: null }
      if (path === '/v1/threads/get')
        return { ...stored, messages: [], hasOlder: false }
      if (path === '/v1/threads/update') throw refusal
      throw new Error(`Unexpected ${path}`)
    })
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
    const { result } = renderHook(() => useThread(stored.id))
    await waitFor(() => expect(result.current.chat.id).toBe(stored.id))
    let sending: Promise<unknown> | undefined
    act(() => {
      sending = result.current.send({ content: 'More' })
    })
    await waitFor(() => expect(result.current.running).toBe(true))

    await act(() =>
      result.current
        .update(stored.id, { title: 'Renamed' })
        .catch(result.current.report),
    )

    expect(result.current.error).toBe('The chat could not be renamed')
    expect(result.current.errorDetail).toEqual(refusal.detail)
    expect(result.current.running).toBe(true)
    expect(result.current.status).toBe('streaming')
    await act(async () => {
      release()
      await sending
    })
    expect(result.current.status).toBe('idle')
  })

  it('are shared by id with the content key', async () => {
    signIn('alice', true)
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
      { key: KEY, threadId: 'cloud-thread' },
      expect.any(AbortSignal),
    )
  })
})
