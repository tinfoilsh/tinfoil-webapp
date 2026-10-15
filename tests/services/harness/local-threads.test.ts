import {
  localThreadStore,
  localThreadView,
  mergeLocalThread,
  newLocalThread,
  turnThread,
  type LocalAttachment,
  type LocalThread,
} from '@/services/harness/local-threads'
import type { Message as WireMessage } from '@/services/harness/types'
import { chatEvents } from '@/services/storage/chat-events'
import { deletedChatsTracker } from '@/services/storage/deleted-chats-tracker'
import {
  DB_NAME,
  DB_VERSION,
  indexedDBStorage,
} from '@/services/storage/indexed-db'
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

vi.mock('@/utils/error-handling', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarning: vi.fn(),
}))

const CHAT_ID = '8233746419999_8a3b4f1e-6f7d-4d52-9c3a-0e1f2a3b4c5d'
const IMAGE: LocalAttachment = {
  id: 'att_image',
  type: 'image',
  fileName: 'photo.png',
  mimeType: 'image/png',
  fileSize: 4,
  thumbnailBase64: 'dGh1bWI=',
  base64: 'cGhvdG8=',
}

function thread(overrides: Partial<LocalThread> = {}): LocalThread {
  return {
    ...newLocalThread(CHAT_ID, { model: 'test-model' }, '2026-05-01T10:00:00Z'),
    codeExecutionAccessToken: 'a'.repeat(64),
    ...overrides,
  }
}

async function rawRows(store: 'chats' | 'attachmentPayloads') {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve(request.result)
  })
  try {
    return await new Promise<Record<string, unknown>[]>((resolve, reject) => {
      const request = db.transaction(store).objectStore(store).getAll()
      request.onerror = () => reject(request.error)
      request.onsuccess = () => resolve(request.result)
    })
  } finally {
    db.close()
  }
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
  deletedChatsTracker.clear()
  sessionStorage.clear()
  await indexedDBStorage.deleteAllChats()
})

afterEach(() => {
  deletedChatsTracker.clear()
  sessionStorage.clear()
  chatEvents.clear()
})

describe('device store', () => {
  const store = localThreadStore('device')

  it('keeps image bytes in the payload store and restores them on read', async () => {
    const saved = thread({
      title: 'Photos',
      titleState: 'generated',
      messages: [
        {
          id: 'm1',
          role: 'user',
          createdAt: '2026-05-01T10:00:01Z',
          content: 'What is this?',
          attachments: [IMAGE],
        },
      ],
    })

    await store.update(CHAT_ID, () => saved)

    const [row] = await rawRows('chats')
    expect(row.isLocalOnly).toBe(true)
    const [storedMessage] = row.messages as Record<string, unknown>[]
    expect(storedMessage.attachments).toEqual([
      {
        id: 'att_image',
        type: 'image',
        fileName: 'photo.png',
        mimeType: 'image/png',
        fileSize: 4,
        storagePayloadId: `${CHAT_ID}:att_image`,
      },
    ])
    expect(await rawRows('attachmentPayloads')).toEqual([
      {
        id: `${CHAT_ID}:att_image`,
        chatId: CHAT_ID,
        base64: 'cGhvdG8=',
        thumbnailBase64: 'dGh1bWI=',
      },
    ])
    expect(await store.get(CHAT_ID)).toEqual(saved)
  })

  it('lists only local chats, newest first, without their messages', async () => {
    await store.update(CHAT_ID, () =>
      thread({ title: 'Older', updatedAt: '2026-05-01T10:00:00Z' }),
    )
    await store.update('newer', () =>
      thread({
        id: 'newer',
        title: 'Newer',
        updatedAt: '2026-05-02T10:00:00.5Z',
        messages: [
          {
            id: 'm1',
            role: 'user',
            createdAt: '2026-05-02T10:00:00Z',
            content: 'hi',
          },
        ],
      }),
    )
    await indexedDBStorage.saveChat({
      id: 'cloud-copy',
      title: 'Cloud copy from the previous client',
      messages: [],
      createdAt: '2026-05-03T00:00:00.000Z',
      updatedAt: '2026-05-03T00:00:00.000Z',
      isLocalOnly: false,
    })

    const summaries = await store.list()
    expect(
      summaries.map((summary) => [summary.id, summary.messageCount]),
    ).toEqual([
      ['newer', 1],
      [CHAT_ID, 0],
    ])
    expect(await store.get('cloud-copy')).toBeNull()
  })

  it('opens and upgrades a chat the previous client stored on the device', async () => {
    await indexedDBStorage.saveChat({
      id: CHAT_ID,
      title: 'Legacy chat',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      isLocalOnly: true,
      model: 'old-model',
      codeExecutionAccessToken: 'b'.repeat(64),
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
          thoughts: 'It has whiskers',
          webSearch: {
            query: 'cats',
            status: 'completed',
            sources: [{ title: 'Cats', url: 'https://cats.example' }],
          },
        },
      ],
    })

    const legacy = await store.get(CHAT_ID)

    expect(legacy).toEqual({
      id: CHAT_ID,
      title: 'Legacy chat',
      titleState: 'generated',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z',
      model: 'old-model',
      codeExecutionAccessToken: 'b'.repeat(64),
      messages: [
        {
          id: `${CHAT_ID}-message-0`,
          role: 'user',
          createdAt: '2026-01-01T00:00:01Z',
          content: 'Look at this',
          attachments: [
            {
              id: `${CHAT_ID}-message-0-attachment-0`,
              type: 'image',
              fileName: 'image-0',
              mimeType: 'image/jpeg',
              base64: 'aW1n',
            },
          ],
        },
        {
          id: `${CHAT_ID}-message-1`,
          role: 'assistant',
          createdAt: '2026-01-01T00:00:02Z',
          content: 'A cat',
          timeline: [
            {
              type: 'thinking',
              id: `${CHAT_ID}-message-1-thinking`,
              content: 'It has whiskers',
              duration: null,
            },
            {
              type: 'tool_call',
              id: `${CHAT_ID}-message-1-search`,
              toolCallId: `${CHAT_ID}-message-1-search`,
              name: 'web_search',
              arguments: '{"query":"cats"}',
              result: {
                query: 'cats',
                results: [
                  { url: 'https://cats.example', title: 'Cats', snippet: '' },
                ],
              },
              complete: true,
            },
            {
              type: 'content',
              id: `${CHAT_ID}-message-1-content`,
              content: 'A cat',
            },
          ],
        },
      ],
    })
    expect(localThreadView(legacy!).messages[0].attachments).toEqual([
      {
        id: `${CHAT_ID}-message-0-attachment-0`,
        kind: 'image',
        fileName: 'image-0',
        mimeType: 'image/jpeg',
        size: 0,
        thumbnail: null,
        pages: null,
        status: 'ready',
      },
    ])
  })

  it('does not write back a chat deleted while its run was finishing', async () => {
    await store.update(CHAT_ID, () => thread())
    const deleted = vi.fn()
    chatEvents.on(deleted)

    await store.delete(CHAT_ID)
    const late = await store.update(CHAT_ID, (current) =>
      thread({ ...current, title: 'Late write' }),
    )

    expect(late).toBeNull()
    expect(await rawRows('chats')).toEqual([])
    expect(deleted).toHaveBeenCalledExactlyOnceWith({
      reason: 'delete',
      ids: [CHAT_ID],
    })
  })

  it('serializes updates so concurrent runs keep each other’s changes', async () => {
    await store.update(CHAT_ID, () => thread())
    await Promise.all([
      store.update(CHAT_ID, (current) => ({ ...current!, title: 'Renamed' })),
      store.update(CHAT_ID, (current) => ({
        ...current!,
        model: 'other-model',
      })),
    ])
    expect(await store.get(CHAT_ID)).toMatchObject({
      title: 'Renamed',
      model: 'other-model',
    })
  })
})

describe('tab store', () => {
  it('keeps a signed-out chat in session storage without opening IndexedDB', async () => {
    const shared = globalThis.indexedDB
    const isolated = new IDBFactory()
    Object.defineProperty(globalThis, 'indexedDB', {
      configurable: true,
      value: isolated,
    })
    try {
      const store = localThreadStore('tab')
      await store.update(CHAT_ID, () =>
        thread({
          messages: [
            {
              id: 'm1',
              role: 'user',
              createdAt: '2026-05-01T10:00:01Z',
              content: 'Signed out question',
            },
          ],
        }),
      )

      const [row] = JSON.parse(
        sessionStorage.getItem('tinfoil-sync-session-chats')!,
      )
      expect(row).toMatchObject({
        id: CHAT_ID,
        isLocalOnly: true,
        messages: [{ id: 'm1', content: 'Signed out question' }],
      })
      expect((await store.get(CHAT_ID))?.messages[0].content).toBe(
        'Signed out question',
      )
      expect((await store.list()).map((summary) => summary.id)).toEqual([
        CHAT_ID,
      ])
      expect(await isolated.databases()).toEqual([])
    } finally {
      Object.defineProperty(globalThis, 'indexedDB', {
        configurable: true,
        value: shared,
      })
    }
  })
})

describe('mergeLocalThread', () => {
  const stored = thread({
    messages: [
      { id: 'u1', role: 'user', createdAt: 't1', content: 'first' },
      {
        id: 'a1',
        role: 'assistant',
        createdAt: 't2',
        content: 'answer',
        model: 'test-model',
        timeline: [{ id: 'b1', type: 'content', content: 'answer' }],
      },
      {
        id: 'u2',
        role: 'user',
        createdAt: 't3',
        content: 'second',
        attachments: [IMAGE],
      },
      {
        id: 'a2',
        role: 'assistant',
        createdAt: 't4',
        content: 'second answer',
        timeline: [{ id: 'b2', type: 'content', content: 'second answer' }],
      },
    ],
  })

  it('keeps messages before the window and maps attachments back to descriptors', () => {
    const window: WireMessage[] = [
      {
        id: 'u2',
        role: 'user',
        createdAt: 't3',
        content: 'second',
        attachments: [
          {
            id: 'att_image',
            kind: 'image',
            fileName: 'photo.png',
            mimeType: 'image/png',
            size: 4,
            thumbnail: 'dGh1bWI=',
            pages: null,
            status: 'ready',
            description: 'A photo of a door',
          },
        ],
      },
      {
        id: 'a2',
        role: 'assistant',
        createdAt: 't4',
        timeline: [{ id: 'b2', type: 'content', content: 'second answer' }],
      },
      {
        id: 'msg_u3',
        role: 'user',
        createdAt: 't5',
        content: 'third',
      },
      {
        id: 'msg_a3',
        role: 'assistant',
        createdAt: '',
        timeline: [
          { id: 'msg_a3_thinking_0', type: 'thinking', content: 'hmm' },
          { id: 'msg_a3_content_1', type: 'content', content: 'third ' },
          { id: 'msg_a3_content_2', type: 'content', content: 'answer' },
        ],
        isError: false,
      },
    ]

    const merged = mergeLocalThread(
      stored,
      { messages: window, hasOlder: true },
      {
        replies: [
          {
            id: 'msg_a3',
            model: 'test-model',
            modelDisplayName: 'Test model',
            usage: { promptTokens: 10, completionTokens: 3 },
            isError: false,
            isInterrupted: false,
          },
        ],
        summary: {
          ...localThreadView(stored),
          title: 'Doors',
          titleState: 'generated',
          contextUsage: { usedTokens: 10, limitTokens: 100, percentage: 10 },
        },
        updatedAt: '2026-05-01T11:00:00Z',
      },
    )

    expect(merged.messages).toEqual([
      stored.messages[0],
      stored.messages[1],
      {
        ...stored.messages[2],
        attachments: [{ ...IMAGE, description: 'A photo of a door' }],
      },
      stored.messages[3],
      { id: 'msg_u3', role: 'user', createdAt: 't5', content: 'third' },
      {
        id: 'msg_a3',
        role: 'assistant',
        createdAt: '2026-05-01T11:00:00Z',
        content: 'third answer',
        model: 'test-model',
        modelDisplayName: 'Test model',
        usage: { promptTokens: 10, completionTokens: 3 },
        timeline: window[3].timeline,
      },
    ])
    expect(merged).toMatchObject({
      title: 'Doors',
      titleState: 'generated',
      contextUsage: { usedTokens: 10, limitTokens: 100, percentage: 10 },
      updatedAt: '2026-05-01T11:00:00Z',
    })
  })

  it('drops stored messages after an edited message', () => {
    const merged = mergeLocalThread(stored, {
      messages: [
        { id: 'u1', role: 'user', createdAt: 't1', content: 'first' },
        {
          id: 'a1',
          role: 'assistant',
          createdAt: 't2',
          timeline: stored.messages[1].timeline,
        },
        { id: 'msg_edit', role: 'user', createdAt: 't6', content: 'edited' },
      ],
      hasOlder: false,
    })
    expect(merged.messages.map((message) => message.id)).toEqual([
      'u1',
      'a1',
      'msg_edit',
    ])
    expect(merged.messages[1]).toEqual(stored.messages[1])
  })

  it('keeps a title the user set while the run streamed', () => {
    const renamed = { ...stored, title: 'Mine', titleState: 'manual' as const }
    const merged = mergeLocalThread(
      renamed,
      { messages: [], hasOlder: false },
      {
        summary: {
          ...localThreadView(stored),
          title: 'Generated',
          titleState: 'generated',
        },
      },
    )
    expect(merged).toMatchObject({ title: 'Mine', titleState: 'manual' })
  })
})

describe('turnThread', () => {
  it('sends image bytes only with the most recent image messages', () => {
    const image = (id: string): LocalAttachment => ({
      ...IMAGE,
      id,
      base64: `bytes-${id}`,
    })
    const document: LocalAttachment = {
      id: 'doc',
      type: 'document',
      fileName: 'scan.pdf',
      textContent: 'scanned',
      pages: [
        { page: 1, text: 'scanned', image: 'page-bytes', is_scanned: true },
      ],
    }
    const messages = [
      ['m1', [image('a')]],
      ['m2', [document]],
      ['m3', [image('b')]],
      ['m4', []],
      ['m5', [image('c')]],
    ].map(([id, attachments]) => ({
      id: id as string,
      role: 'user' as const,
      createdAt: 't',
      content: 'look',
      ...((attachments as LocalAttachment[]).length
        ? { attachments: attachments as LocalAttachment[] }
        : {}),
    }))

    const sent = turnThread(thread({ messages }))

    const { base64: _, ...withoutBytes } = image('a')
    expect(sent.messages.map((message) => message.attachments)).toEqual([
      [withoutBytes],
      [document],
      [image('b')],
      undefined,
      [image('c')],
    ])
    expect(sent).toMatchObject({
      title: 'New Chat',
      titleState: 'placeholder',
      model: 'test-model',
      presetId: null,
      codeExecutionAccessToken: 'a'.repeat(64),
    })
    expect(sent).not.toHaveProperty('id')
  })

  it('blanks page images of older documents but keeps their text', () => {
    const scan = (id: string): LocalAttachment => ({
      id,
      type: 'document',
      fileName: `${id}.pdf`,
      pages: [
        { page: 1, text: `text ${id}`, image: `img-${id}`, is_scanned: false },
      ],
    })
    const sent = turnThread(
      thread({
        messages: ['d1', 'd2'].map((id) => ({
          id,
          role: 'user' as const,
          createdAt: 't',
          content: '',
          attachments: [scan(id)],
        })),
      }),
      1,
    )
    expect(sent.messages[0].attachments).toEqual([
      {
        ...scan('d1'),
        pages: [{ page: 1, text: 'text d1', image: '', is_scanned: false }],
      },
    ])
    expect(sent.messages[1].attachments).toEqual([scan('d2')])
  })
})
