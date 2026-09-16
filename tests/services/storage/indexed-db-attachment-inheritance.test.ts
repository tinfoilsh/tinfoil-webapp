import { AUTH_ACTIVE_USER_ID } from '@/constants/storage-keys'
import { IndexedDBStorage } from '@/services/storage/indexed-db'
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'

const DB_NAME = 'tinfoil-chat'
const CHAT_ID = 'chat-1'
const ATTACHMENT_ID = 'att-1'
const ENCRYPTION_KEY = 'a'.repeat(44)
const FULL_BASE64 = 'FULL'.repeat(64)
const THUMBNAIL_BASE64 = 'thumb'

function deleteDatabase(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
    request.onblocked = () =>
      reject(new Error('Test database deletion blocked'))
  })
}

function buildChat(attachment: Record<string, unknown>) {
  return {
    id: CHAT_ID,
    title: 'Image chat',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:01.000Z',
    isLocalOnly: false,
    messages: [
      {
        role: 'user' as const,
        content: 'what is in this image?',
        timestamp: '2026-01-01T00:00:00.000Z',
        turnId: 'turn-1',
        attachments: [
          {
            id: ATTACHMENT_ID,
            type: 'image' as const,
            fileName: 'photo.png',
            mimeType: 'image/png',
            fileSize: 1234,
            encryptionKey: ENCRYPTION_KEY,
            ...attachment,
          },
        ],
      },
    ],
  }
}

describe('attachment payload inheritance across remote applies', () => {
  let storage: IndexedDBStorage
  let localUpdatedAt: string

  beforeEach(async () => {
    Object.defineProperty(window, 'indexedDB', {
      configurable: true,
      value: indexedDB,
    })
    localStorage.setItem(AUTH_ACTIVE_USER_ID, 'user-1')
    await deleteDatabase()

    storage = new IndexedDBStorage()
    await storage.initialize()
    await storage.saveChat(
      buildChat({
        base64: FULL_BASE64,
        thumbnailBase64: THUMBNAIL_BASE64,
      }) as any,
    )
    const local = await storage.getChat(CHAT_ID)
    expect(local?.messages[0].attachments?.[0].base64).toBe(FULL_BASE64)
    localUpdatedAt = local!.updatedAt
  })

  async function applyRemote(attachment: Record<string, unknown>) {
    const remote = buildChat(attachment)
    const applied = await storage.applyRemoteChatIfFresh({
      chat: { ...remote, updatedAt: '2026-01-01T00:00:02.000Z' } as any,
      syncVersion: 2,
      expectedLocalUpdatedAt: localUpdatedAt,
      allowLocallyModified: true,
    })
    expect(applied.applied).toBe(true)
    const merged = await storage.getChat(CHAT_ID)
    return merged?.messages[0].attachments?.[0]
  }

  it('keeps the local full-resolution image when the wire-stripped remote copy is applied', async () => {
    // The cloud copy of a chat never carries image bytes or the local
    // payload reference, only the thumbnail and the per-attachment key.
    const attachment = await applyRemote({ thumbnailBase64: THUMBNAIL_BASE64 })

    expect(attachment?.thumbnailBase64).toBe(THUMBNAIL_BASE64)
    expect(attachment?.base64).toBe(FULL_BASE64)
  })

  it('does not lend local bytes to a different image', async () => {
    const attachment = await applyRemote({
      id: 'other-image',
      fileName: 'other.png',
      encryptionKey: 'b'.repeat(44),
      thumbnailBase64: 'other-thumb',
    })

    expect(attachment?.thumbnailBase64).toBe('other-thumb')
    expect(attachment?.base64).toBeUndefined()
  })
})
