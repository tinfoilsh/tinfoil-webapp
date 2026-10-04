import type { Attachment } from '@/components/chat/types'
import { CLOUD_SYNC } from '@/config'
import { AUTH_ACTIVE_USER_ID } from '@/constants/storage-keys'
import { cloudStorage } from '@/services/cloud/cloud-storage'
import { ChatStorageService } from '@/services/storage/chat-storage'
import { indexedDBStorage } from '@/services/storage/indexed-db'
import { setCloudSyncEnabled } from '@/utils/cloud-sync-settings'
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { attachmentGet, attachmentPut, push, deleteFromCloud } = vi.hoisted(
  () => ({
    attachmentGet: vi.fn(),
    attachmentPut: vi.fn(),
    push: vi.fn(),
    deleteFromCloud: vi.fn(),
  }),
)
vi.mock('@/services/sync-enclave/sync-api', async (original) => ({
  ...(await original<typeof import('@/services/sync-enclave/sync-api')>()),
  attachmentGet,
  attachmentPut,
  push,
}))
vi.mock('@/services/cloud/cek-encoding', () => ({
  requirePrimaryKeyB64: () => 'test-key',
}))
vi.mock('@/services/cloud/cloud-sync', async (original) => {
  const { cloudSync } =
    await original<typeof import('@/services/cloud/cloud-sync')>()
  return {
    cloudSync: {
      createAccountOperationGuard: () =>
        cloudSync.createAccountOperationGuard(),
      deleteFromCloud,
      backupChatNow: async (id: string) => {
        const chat = await indexedDBStorage.getChat(id)
        if (!chat) throw new Error('Chat missing')
        return cloudStorage.uploadChat(chat, { restoreDeleted: true })
      },
    },
  }
})

const CHAT_ID = 'document-roundtrip'
const pages = [{ page: 1, text: '', image: 'AQID', is_scanned: true }]
async function storeDocument(payload: Partial<Attachment>) {
  await indexedDBStorage.saveChat({
    id: CHAT_ID,
    title: 'Document',
    createdAt: new Date().toISOString(),
    isLocalOnly: false,
    messages: [
      {
        role: 'user',
        content: 'summarize',
        timestamp: new Date(),
        attachments: [
          {
            id: 'old-blob',
            type: 'document',
            fileName: 'scan.pdf',
            encryptionKey: 'old-key',
            ...payload,
          },
        ],
      },
    ],
  })
}

describe('document cloud/local round trips with real IndexedDB', () => {
  beforeEach(async () => {
    vi.resetAllMocks()
    Object.defineProperty(window, 'indexedDB', {
      configurable: true,
      value: indexedDB,
    })
    localStorage.setItem(AUTH_ACTIVE_USER_ID, 'user-1')
    setCloudSyncEnabled(true)
    await indexedDBStorage.initialize()
    await indexedDBStorage.deleteAllChats()
    attachmentPut.mockResolvedValue({ id: 'fresh-blob', att_key: 'fresh-key' })
    push.mockResolvedValue({ etag: '1' })
    attachmentGet.mockRejectedValue(new Error('deleted blob'))
  })
  afterEach(() => {
    Object.defineProperty(CLOUD_SYNC, 'DOCUMENT_ATTACHMENT_WRITES_ENABLED', {
      value: false,
      configurable: true,
    })
  })

  it.each([
    { textContent: 'retained prose' },
    { pages },
    { textContent: 'retained prose', pages },
  ])(
    'retains hydrated payload %j through deletion and a fresh blob upload',
    async (payload) => {
      await storeDocument(payload)
      deleteFromCloud.mockImplementationOnce(async () => {
        const local = await indexedDBStorage.getChat(CHAT_ID)
        expect(local?.messages[0].attachments?.[0]).toMatchObject(payload)
        expect(local?.messages[0].attachments?.[0]).not.toHaveProperty(
          'encryptionKey',
        )
      })
      const storage = new ChatStorageService()
      await storage.convertChatToLocal(CHAT_ID)
      expect(attachmentGet).not.toHaveBeenCalled()
      Object.defineProperty(CLOUD_SYNC, 'DOCUMENT_ATTACHMENT_WRITES_ENABLED', {
        value: true,
        configurable: true,
      })
      await storage.convertChatToCloud(CHAT_ID)
      expect(attachmentPut).toHaveBeenCalledTimes(1)
      expect(
        JSON.parse(
          new TextDecoder().decode(attachmentPut.mock.calls[0][0].plaintext),
        ),
      ).toEqual(payload)
      const wire = JSON.parse(
        new TextDecoder().decode(push.mock.calls[0][0].plaintext),
      )
      expect(wire.messages[0].attachments[0]).toMatchObject({
        id: 'fresh-blob',
        encryptionKey: 'fresh-key',
      })
      expect(wire.messages[0].attachments[0]).not.toHaveProperty('textContent')
      expect(wire.messages[0].attachments[0]).not.toHaveProperty('pages')
    },
  )

  it('writes retained content inline when converting back with the default gate', async () => {
    await storeDocument({ textContent: 'retained prose', pages })
    const storage = new ChatStorageService()
    await storage.convertChatToLocal(CHAT_ID)
    await storage.convertChatToCloud(CHAT_ID)
    const wire = JSON.parse(
      new TextDecoder().decode(push.mock.calls[0][0].plaintext),
    )
    expect(wire.messages[0].attachments[0]).toMatchObject({
      textContent: 'retained prose',
      pages,
    })
    expect(wire.messages[0].attachments[0]).not.toHaveProperty('encryptionKey')
    expect(attachmentGet).not.toHaveBeenCalled()
    expect(attachmentPut).not.toHaveBeenCalled()
  })

  it('does not delete cloud data or mark local-only when content is unavailable', async () => {
    await storeDocument({})
    await expect(
      new ChatStorageService().convertChatToLocal(CHAT_ID),
    ).rejects.toThrow()
    expect(deleteFromCloud).not.toHaveBeenCalled()
    expect((await indexedDBStorage.getChat(CHAT_ID))?.isLocalOnly).toBe(false)
  })

  it.each([false, true])(
    'aborts conversion on opt-out during hydration even if re-enabled=%s',
    async (reenable) => {
      await storeDocument({})
      attachmentGet.mockImplementationOnce(async () => {
        setCloudSyncEnabled(false)
        if (reenable) setCloudSyncEnabled(true)
        return new TextEncoder().encode(
          JSON.stringify({ textContent: 'fetched content' }),
        )
      })
      await expect(
        new ChatStorageService().convertChatToLocal(CHAT_ID),
      ).rejects.toThrow('Cloud account changed')
      const chat = await indexedDBStorage.getChat(CHAT_ID)
      expect(chat?.isLocalOnly).toBe(false)
      expect(chat?.messages[0].attachments![0].encryptionKey).toBe('old-key')
      expect(deleteFromCloud).not.toHaveBeenCalled()
    },
  )

  it('forks hydrated documents locally without fetching after opt-out', async () => {
    await storeDocument({ textContent: 'retained prose', pages })
    setCloudSyncEnabled(false)
    const fork = await new ChatStorageService().forkChat(
      CHAT_ID,
      1,
      'local-fork',
    )
    const attachment = fork.messages[0].attachments![0]
    expect(attachment).toMatchObject({ textContent: 'retained prose', pages })
    expect(attachment).not.toHaveProperty('encryptionKey')
    expect(attachment.id).not.toBe('old-blob')
    expect(attachmentGet).not.toHaveBeenCalled()
  })

  it('refuses missing document conversion after opt-out without fetching or deleting', async () => {
    await storeDocument({})
    setCloudSyncEnabled(false)
    await expect(
      new ChatStorageService().convertChatToLocal(CHAT_ID),
    ).rejects.toThrow(/enable cloud sync/i)
    expect(attachmentGet).not.toHaveBeenCalled()
    expect(deleteFromCloud).not.toHaveBeenCalled()
    expect((await indexedDBStorage.getChat(CHAT_ID))?.isLocalOnly).toBe(false)
  })
})
