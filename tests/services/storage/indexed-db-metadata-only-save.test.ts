import {
  DB_NAME,
  DB_VERSION,
  IndexedDBStorage,
  type StoredChat,
} from '@/services/storage/indexed-db'
import { IDBKeyRange as FakeIDBKeyRange, IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it } from 'vitest'

function storedChat(
  id: string,
  overrides: Partial<StoredChat> = {},
): StoredChat {
  return {
    id,
    title: id,
    messages: [],
    createdAt: '2026-08-12T00:00:00.000Z',
    updatedAt: '2026-08-12T00:00:00.000Z',
    lastAccessedAt: Date.now(),
    ...overrides,
  }
}

function conversationMessages() {
  return [
    {
      role: 'user' as const,
      content: 'Original question',
      timestamp: new Date('2026-08-12T00:00:00.000Z'),
    },
    {
      role: 'assistant' as const,
      content: 'Original answer',
      timestamp: new Date('2026-08-12T00:00:01.000Z'),
    },
  ]
}

async function readRawChatRow(id: string): Promise<Record<string, unknown>> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve(request.result)
  })
  const row = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const request = db.transaction('chats').objectStore('chats').get(id)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve(request.result as Record<string, unknown>)
  })
  db.close()
  return row
}

describe('IndexedDB metadata-only chat saves', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'indexedDB', {
      configurable: true,
      value: new IDBFactory(),
    })
    Object.defineProperty(globalThis, 'IDBKeyRange', {
      configurable: true,
      value: FakeIDBKeyRange,
    })
  })

  it('preserves stored messages when saving a metadata-only chat', async () => {
    const storage = new IndexedDBStorage()
    await storage.saveChat(
      storedChat('chat-1', { messages: conversationMessages() }),
    )
    await storage.markAsSynced('chat-1', 1)

    const [summary] = await storage.getChatSummaries()
    expect(summary).toMatchObject({
      id: 'chat-1',
      isMetadataOnly: true,
      messageCount: 2,
      messages: [],
    })

    // A rename edits the summary copy the sidebar holds after startup.
    await storage.saveChat({ ...summary, title: 'Renamed' })

    const full = await storage.getChat('chat-1')
    expect(full?.title).toBe('Renamed')
    expect(full?.messages).toHaveLength(2)
    expect(full?.messages[0].content).toBe('Original question')
    expect(full?.messages[1].content).toBe('Original answer')
    // The title change is real content and must still be picked up for
    // sync — but with the full history, never the empty summary copy.
    expect(full?.locallyModified).toBe(true)
    expect(full?.syncPending).toBe(1)

    const [summaryAfter] = await storage.getChatSummaries()
    expect(summaryAfter).toMatchObject({
      title: 'Renamed',
      messageCount: 2,
    })
    const raw = await readRawChatRow('chat-1')
    expect('isMetadataOnly' in raw).toBe(false)
    expect('messageCount' in raw).toBe(false)
    expect((raw.messages as unknown[]).length).toBe(2)
  })

  it('recreates an evicted decryption placeholder without marking it dirty', async () => {
    const storage = new IndexedDBStorage()
    const placeholder = storedChat('locked-chat', {
      decryptionFailed: true,
      locallyModified: false,
      syncPending: 0,
      syncVersion: 7,
    })

    await storage.saveChat(placeholder)
    await storage.deleteChat(placeholder.id)
    expect(await storage.getChat(placeholder.id)).toBeNull()

    await storage.restoreDecryptionPlaceholder(placeholder)

    expect(await storage.getChat(placeholder.id)).toMatchObject({
      id: placeholder.id,
      decryptionFailed: true,
      locallyModified: false,
      syncPending: 0,
      syncVersion: 7,
    })
  })

  it('does not resurrect a deleted chat from a stale summary save', async () => {
    const storage = new IndexedDBStorage()
    await storage.saveChat(
      storedChat('chat-1', { messages: conversationMessages() }),
    )
    const [summary] = await storage.getChatSummaries()
    await storage.deleteChat('chat-1')

    await storage.saveChat({ ...summary, title: 'Renamed after delete' })

    expect(await storage.getChat('chat-1')).toBeNull()
  })

  it('does not recreate a deleted row from a hydrated existing-chat save', async () => {
    const storage = new IndexedDBStorage()
    const chat = storedChat('chat-1', { messages: conversationMessages() })
    await storage.saveChat(chat)
    await storage.deleteChat('chat-1')

    await storage.saveExistingChat({
      ...chat,
      messages: [
        ...chat.messages,
        {
          role: 'user',
          content: 'Late send',
          timestamp: new Date('2026-08-12T00:00:02.000Z'),
        },
      ],
    })

    expect(await storage.getChat('chat-1')).toBeNull()
  })
})
