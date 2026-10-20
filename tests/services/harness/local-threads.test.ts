import { localThreadStore } from '@/services/harness/local-threads'
import { HarnessError } from '@/services/harness/sse'
import type {
  AttachmentDescriptor,
  StoredThread,
} from '@/services/harness/types'
import { chatEvents } from '@/services/storage/chat-events'
import { indexedDBStorage } from '@/services/storage/indexed-db'
import { IDBFactory } from 'fake-indexeddb'
import { describe, expect, it, vi } from 'vitest'
import { client, signIn } from '../../harness-fixture'
import {
  rawRows,
  resetChatStoresAroundEachTest,
  storedThread,
} from './thread-fixture'

vi.mock('@/utils/error-handling', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarning: vi.fn(),
}))

const CHAT_ID = '8233746419999_8a3b4f1e-6f7d-4d52-9c3a-0e1f2a3b4c5d'
const OTHER_ID = '8233746418888_9b4c5f2e-7a8e-4e63-8d4b-1f2a3b4c5d6e'
const IMAGE: AttachmentDescriptor = {
  id: 'att_image',
  kind: 'image',
  fileName: 'photo.png',
  mimeType: 'image/png',
  size: 4,
  thumbnail: 'dGh1bWI=',
  base64: 'cGhvdG8=',
}

const thread = (fields: Partial<StoredThread> = {}) =>
  storedThread(CHAT_ID, fields)

resetChatStoresAroundEachTest()

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
          attachments: [IMAGE, { ...IMAGE, id: 'att_seen', base64: undefined }],
        },
      ],
    })

    await store.update(CHAT_ID, () => saved)

    const [row] = await rawRows('chats')
    expect(row).toMatchObject({ isLocalOnly: true, threadFormat: 1 })
    const [storedMessage] = row.messages as Record<string, unknown>[]
    expect(storedMessage.attachments).toEqual([
      {
        id: 'att_image',
        kind: 'image',
        fileName: 'photo.png',
        mimeType: 'image/png',
        size: 4,
        thumbnail: 'dGh1bWI=',
        storagePayloadId: `${CHAT_ID}:att_image`,
      },
      {
        id: 'att_seen',
        kind: 'image',
        fileName: 'photo.png',
        mimeType: 'image/png',
        size: 4,
        thumbnail: 'dGh1bWI=',
        storagePayloadId: `${CHAT_ID}:att_seen`,
      },
    ])
    expect(await rawRows('attachmentPayloads')).toEqual([
      { id: `${CHAT_ID}:att_image`, chatId: CHAT_ID, base64: 'cGhvdG8=' },
      { id: `${CHAT_ID}:att_seen`, chatId: CHAT_ID, textContent: '' },
    ])
    expect(await store.get(CHAT_ID)).toEqual({
      ...saved,
      messages: [
        {
          ...saved.messages[0],
          attachments: [IMAGE, { ...IMAGE, id: 'att_seen', base64: undefined }],
        },
      ],
    })
    expect(
      (await store.get(CHAT_ID))?.messages[0].attachments?.[1],
    ).not.toHaveProperty('textContent')
  })

  it('lists only local chats, newest first, without their messages', async () => {
    await store.update(CHAT_ID, () =>
      thread({ title: 'Older', updatedAt: '2026-05-01T10:00:00Z' }),
    )
    await store.update(OTHER_ID, () =>
      storedThread(OTHER_ID, {
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
      [OTHER_ID, 1],
      [CHAT_ID, 0],
    ])
    expect(await store.get('cloud-copy')).toBeNull()
  })

  describe('with chats the previous client stored', () => {
    const legacyRow = (id: string, title: string) => ({
      id,
      title,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      isLocalOnly: true,
      messages: [
        {
          role: 'user' as const,
          content: 'Look at this',
          timestamp: new Date('2026-01-01T00:00:01.000Z'),
          imageData: [{ base64: 'aW1n', mimeType: 'image/jpeg' }],
        },
      ],
    })
    const upgraded = (id: string, title: string) =>
      storedThread(id, {
        title,
        titleState: 'generated',
        messages: [
          {
            id: `${id}-message-0`,
            role: 'user',
            createdAt: '2026-01-01T00:00:01Z',
            content: 'Look at this',
            attachments: [
              {
                id: `${id}-message-0-attachment-0`,
                kind: 'image',
                fileName: 'image-0',
                mimeType: 'image/jpeg',
                size: 3,
                base64: 'aW1n',
              },
            ],
          },
        ],
      })
    const upgrades = () =>
      client.post.mock.calls.filter(([path]) => path === '/v1/threads/upgrade')

    it('rewrites each one in the thread format once, through the harness', async () => {
      signIn()
      await indexedDBStorage.saveChat(legacyRow(CHAT_ID, 'Cats'))
      client.post.mockImplementation(async (path: string) => {
        if (path === '/v1/threads/upgrade')
          return { threads: [upgraded(CHAT_ID, 'Cats')] }
        throw new Error(`Unexpected ${path}`)
      })

      expect((await store.list()).map((summary) => summary.id)).toEqual([
        CHAT_ID,
      ])

      expect(upgrades()).toHaveLength(1)
      expect(upgrades()[0][1]).toEqual({
        threads: [
          expect.objectContaining({
            id: CHAT_ID,
            title: 'Cats',
            messages: [
              expect.objectContaining({
                content: 'Look at this',
                imageData: [{ base64: 'aW1n', mimeType: 'image/jpeg' }],
              }),
            ],
          }),
        ],
      })
      expect(await store.get(CHAT_ID)).toEqual(upgraded(CHAT_ID, 'Cats'))
      const [row] = await rawRows('chats')
      expect(row).toMatchObject({ id: CHAT_ID, threadFormat: 1 })
      await store.list()
      await store.update(CHAT_ID, (current) => current)
      expect(upgrades()).toHaveLength(1)
    })

    it('sends each one alone, and upgrades the others when the harness refuses one', async () => {
      signIn()
      await indexedDBStorage.saveChat(legacyRow(CHAT_ID, 'Cats'))
      await indexedDBStorage.saveChat(legacyRow(OTHER_ID, 'Unreadable'))
      const refusal = new HarnessError(
        { code: 'BAD_REQUEST', message: 'The chat cannot be read' },
        400,
      )
      client.post.mockImplementation(
        async (path: string, input: { threads: { id: string }[] }) => {
          if (path !== '/v1/threads/upgrade')
            throw new Error(`Unexpected ${path}`)
          if (input.threads.some((row) => row.id === OTHER_ID)) throw refusal
          return { threads: [upgraded(CHAT_ID, 'Cats')] }
        },
      )

      expect(await store.get(CHAT_ID)).toEqual(upgraded(CHAT_ID, 'Cats'))

      const sent = upgrades().map(([, input]) =>
        input.threads.map((row: { id: string }) => row.id),
      )
      expect(sent.sort()).toEqual([[OTHER_ID], [CHAT_ID]])
      expect(await store.get(OTHER_ID)).toBeNull()
      const unreadable = (await rawRows('chats')).find(
        (row) => row.id === OTHER_ID,
      )
      expect(unreadable).toMatchObject({ title: 'Unreadable' })
      expect(unreadable).not.toHaveProperty('threadFormat')
    })
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
      const saved = thread({
        messages: [
          {
            id: 'm1',
            role: 'user',
            createdAt: '2026-05-01T10:00:01Z',
            content: 'Signed out question',
          },
        ],
      })
      await store.update(CHAT_ID, () => saved)

      const [row] = JSON.parse(
        sessionStorage.getItem('tinfoil-sync-session-chats')!,
      )
      expect(row).toMatchObject({
        id: CHAT_ID,
        isLocalOnly: true,
        threadFormat: 1,
        messages: [{ id: 'm1', content: 'Signed out question' }],
      })
      expect(await store.get(CHAT_ID)).toEqual(saved)
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

  it("keeps a signed-out chat's image bytes and page images in memory, not session storage", async () => {
    const store = localThreadStore('tab')
    const scan: AttachmentDescriptor = {
      id: 'att_scan',
      kind: 'document',
      fileName: 'scan.pdf',
      mimeType: 'application/pdf',
      size: 8,
      pages: [
        { page: 1, text: 'Typed text', image: '', is_scanned: false },
        { page: 2, text: 'Scanned text', image: 'cGFnZQ==', is_scanned: true },
      ],
    }
    const saved = thread({
      messages: [
        {
          id: 'm1',
          role: 'user',
          createdAt: '2026-05-01T10:00:01Z',
          content: 'What is this?',
          attachments: [IMAGE, scan],
        },
      ],
    })
    try {
      await store.update(CHAT_ID, () => saved)

      const [row] = JSON.parse(
        sessionStorage.getItem('tinfoil-sync-session-chats')!,
      )
      const { base64: _, ...thumbnailOnly } = IMAGE
      expect(row.messages).toEqual([
        {
          id: 'm1',
          role: 'user',
          createdAt: '2026-05-01T10:00:01Z',
          content: 'What is this?',
          attachments: [
            thumbnailOnly,
            {
              ...scan,
              pages: [
                { page: 1, text: 'Typed text', image: '', is_scanned: false },
                { page: 2, text: 'Scanned text', image: '', is_scanned: true },
              ],
            },
          ],
        },
      ])
      expect(await store.get(CHAT_ID)).toEqual(saved)
    } finally {
      await store.deleteAll()
    }
  })
})
