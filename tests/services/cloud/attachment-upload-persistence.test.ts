import {
  AUTH_ACTIVE_USER_ID,
  SETTINGS_CLOUD_SYNC_ENABLED,
} from '@/constants/storage-keys'
import { cloudStorage } from '@/services/cloud/cloud-storage'
import { CloudSyncService } from '@/services/cloud/cloud-sync'
import {
  DB_NAME,
  indexedDBStorage,
  type StoredChat,
} from '@/services/storage/indexed-db'
import { realScheduler } from '@/services/sync-enclave/retry-policy'
import { attachmentPut, push } from '@/services/sync-enclave/sync-api'
import {
  SyncEnclaveError,
  SyncNetworkError,
} from '@/services/sync-enclave/sync-enclave-client'
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/services/cloud/cloud-key-authorization', () => ({
  canWriteToCloud: vi.fn(async () => true),
}))
vi.mock('@/services/cloud/cek-encoding', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/cloud/cek-encoding')>()),
  requirePrimaryKeyB64: () => 'test-key',
}))
vi.mock('@/services/sync-enclave/sync-api', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@/services/sync-enclave/sync-api')
  >()),
  attachmentPut: vi.fn(),
  push: vi.fn(),
}))
vi.mock('@/utils/error-handling', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarning: vi.fn(),
}))

const CHAT_ID = 'attachment-chat'
const CREATED_AT = '2026-01-01T00:00:00.000Z'
const IMAGE_A = new Uint8Array([1, 2, 3])
const IMAGE_B = new Uint8Array([4, 5, 6])
const uploadedA = { ok: true as const, id: 'server-a', att_key: 'key-a' }
const uploadedB = { ok: true as const, id: 'server-b', att_key: 'key-b' }

async function readChat(): Promise<StoredChat> {
  const chat = await indexedDBStorage.getChat(CHAT_ID)
  expect(chat).not.toBeNull()
  return chat!
}

function sentAttachments(): number[][] {
  return vi
    .mocked(attachmentPut)
    .mock.calls.map(([request]) => [...request.plaintext])
}

describe('attachment upload persistence', () => {
  beforeEach(async () => {
    vi.resetAllMocks()
    Object.defineProperty(window, 'indexedDB', {
      configurable: true,
      value: indexedDB,
    })
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(DB_NAME)
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
      request.onblocked = () =>
        reject(new Error('Test database deletion blocked'))
    })
    localStorage.setItem(AUTH_ACTIVE_USER_ID, 'user-1')
    localStorage.setItem(SETTINGS_CLOUD_SYNC_ENABLED, 'true')
    vi.spyOn(cloudStorage, 'isAuthenticated').mockResolvedValue(true)
    vi.spyOn(realScheduler, 'sleep').mockResolvedValue(undefined)
    vi.mocked(attachmentPut).mockImplementation(async ({ plaintext }) =>
      plaintext[0] === IMAGE_A[0] ? uploadedA : uploadedB,
    )
    vi.mocked(push).mockResolvedValue({ ok: true, etag: '1', key_id: 'kid' })
    await indexedDBStorage.saveChat({
      id: CHAT_ID,
      title: 'Attachments',
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      messages: [
        {
          role: 'user',
          content: 'Images',
          timestamp: new Date(CREATED_AT),
          attachments: [
            { id: 'local-a', type: 'image', fileName: 'a.png', base64: 'AQID' },
            { id: 'local-b', type: 'image', fileName: 'b.png', base64: 'BAUG' },
          ],
        },
      ],
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('persists A when B fails and sends only B on the next logical upload', async () => {
    const before = await readChat()
    const failure = new SyncNetworkError()
    vi.mocked(attachmentPut)
      .mockResolvedValueOnce(uploadedA)
      .mockRejectedValueOnce(failure)
    const service = new CloudSyncService()

    await expect(service.backupChatNow(CHAT_ID)).rejects.toBe(failure)

    const partial = await readChat()
    expect(partial.messages[0].attachments).toMatchObject([
      { id: 'server-a', encryptionKey: 'key-a', base64: 'AQID' },
      { id: 'local-b', base64: 'BAUG' },
    ])
    expect(partial.messages[0].attachments?.[1].encryptionKey).toBeUndefined()
    expect(partial).toMatchObject({
      locallyModified: true,
      pendingUpload: 1,
      updatedAt: before.updatedAt,
      clock: before.clock,
    })
    expect(partial.syncVersion).toBe(before.syncVersion)
    expect(push).not.toHaveBeenCalled()

    await service.backupChatNow(CHAT_ID)

    expect(sentAttachments()).toEqual([
      [...IMAGE_A],
      [...IMAGE_B],
      [...IMAGE_B],
    ])
    expect(await readChat()).toMatchObject({
      locallyModified: false,
      pendingUpload: 0,
      syncVersion: 1,
    })
  })

  it('reuses persisted attachments on a frozen coalescer retry and finalizes', async () => {
    vi.mocked(attachmentPut)
      .mockResolvedValueOnce(uploadedA)
      .mockRejectedValueOnce(new SyncNetworkError())
    const service = new CloudSyncService()

    await service.backupChatAndWait(CHAT_ID)

    expect(sentAttachments()).toEqual([
      [...IMAGE_A],
      [...IMAGE_B],
      [...IMAGE_B],
    ])
    expect(realScheduler.sleep).toHaveBeenCalledOnce()
    expect(push).toHaveBeenCalledOnce()
    expect(await readChat()).toMatchObject({
      locallyModified: false,
      pendingUpload: 0,
      syncVersion: 1,
      messages: [
        {
          attachments: [
            { id: 'server-a', encryptionKey: 'key-a' },
            { id: 'server-b', encryptionKey: 'key-b' },
          ],
        },
      ],
    })
  })

  it('stops before B and the chat push when rewrite persistence rejects', async () => {
    const failure = new Error('Persistence failed')
    const persist = vi
      .spyOn(indexedDBStorage, 'recordAttachmentRewrites')
      .mockRejectedValueOnce(failure)

    await expect(new CloudSyncService().backupChatNow(CHAT_ID)).rejects.toBe(
      failure,
    )

    expect(sentAttachments()).toEqual([[...IMAGE_A]])
    expect(push).not.toHaveBeenCalled()
    expect(persist).toHaveBeenCalledExactlyOnceWith(CHAT_ID, [
      expect.objectContaining({
        clientId: 'local-a',
        serverId: 'server-a',
        encryptionKey: 'key-a',
      }),
    ])
    expect((await readChat()).messages[0].attachments).toMatchObject([
      { id: 'local-a' },
      { id: 'local-b' },
    ])
  })

  it('never adopts unpersisted references or advances to B across coalescer retries', async () => {
    const failure = new Error('Persistence failed')
    const persist = vi
      .spyOn(indexedDBStorage, 'recordAttachmentRewrites')
      .mockRejectedValue(failure)

    await expect(
      new CloudSyncService().backupChatAndWait(CHAT_ID),
    ).rejects.toBe(failure)

    expect(persist.mock.calls.length).toBeGreaterThan(1)
    expect(sentAttachments()).toEqual(
      persist.mock.calls.map(() => [...IMAGE_A]),
    )
    expect(push).not.toHaveBeenCalled()
    const chat = await readChat()
    expect(chat).toMatchObject({ locallyModified: true, pendingUpload: 1 })
    expect(
      chat.messages[0].attachments?.map(
        (attachment) => attachment.encryptionKey,
      ),
    ).toEqual([undefined, undefined])
  })

  it('keeps push retries byte-identical without re-uploading attachments or adopting concurrent edits', async () => {
    vi.mocked(push).mockImplementationOnce(async () => {
      const latest = await readChat()
      await indexedDBStorage.saveChat({ ...latest, title: 'Concurrent edit' })
      throw new SyncNetworkError()
    })
    const service = new CloudSyncService()

    await service.backupChat(CHAT_ID)
    await expect(service.waitForAllUploads()).rejects.toThrow(
      'Chat upload did not finalize',
    )

    const pushes = vi.mocked(push).mock.calls.map(([request]) => request)
    expect(pushes.length).toBeGreaterThan(1)
    for (const request of pushes) {
      expect(request.idempotencyKey).toBe(pushes[0].idempotencyKey)
      expect(request.plaintext).toEqual(pushes[0].plaintext)
      expect(
        JSON.parse(new TextDecoder().decode(request.plaintext)).title,
      ).toBe('Attachments')
    }
    expect(sentAttachments()).toEqual([[...IMAGE_A], [...IMAGE_B]])
    expect(await readChat()).toMatchObject({
      title: 'Concurrent edit',
      pendingUpload: 1,
    })
  })

  it('stops before B when the account changes while persisting A', async () => {
    const persist =
      indexedDBStorage.recordAttachmentRewrites.bind(indexedDBStorage)
    vi.spyOn(
      indexedDBStorage,
      'recordAttachmentRewrites',
    ).mockImplementationOnce(async (...args) => {
      await persist(...args)
      localStorage.setItem(AUTH_ACTIVE_USER_ID, 'user-2')
    })

    await expect(new CloudSyncService().backupChatNow(CHAT_ID)).rejects.toThrow(
      'Cloud account changed',
    )

    expect(sentAttachments()).toEqual([[...IMAGE_A]])
    expect(push).not.toHaveBeenCalled()
  })

  it('persists minted references when the chat push fails terminally', async () => {
    const failure = new SyncEnclaveError(
      'Push rejected',
      409,
      'IDEMPOTENCY_CONFLICT',
    )
    vi.mocked(push).mockRejectedValueOnce(failure)
    const service = new CloudSyncService()
    await service.backupChat(CHAT_ID)
    await expect(service.waitForAllUploads()).rejects.toBe(failure)
    expect((await readChat()).messages[0].attachments).toMatchObject([
      { id: 'server-a', encryptionKey: 'key-a' },
      { id: 'server-b', encryptionKey: 'key-b' },
    ])
    expect(await readChat()).toMatchObject({
      locallyModified: true,
      pendingUpload: 1,
    })
    await service.backupChatAndWait(CHAT_ID)
    expect(sentAttachments()).toEqual([[...IMAGE_A], [...IMAGE_B]])
    expect(await readChat()).toMatchObject({
      locallyModified: false,
      pendingUpload: 0,
    })
  })

  it('re-uploads attachments the server purged and pushes again', async () => {
    await indexedDBStorage.recordAttachmentRewrites(CHAT_ID, [
      { clientId: 'local-a', serverId: 'server-a', encryptionKey: 'key-a' },
      { clientId: 'local-b', serverId: 'server-b', encryptionKey: 'key-b' },
    ])
    vi.mocked(push).mockRejectedValueOnce(
      new SyncEnclaveError('Missing blob', 409, 'MISSING_ATTACHMENT', {
        missing_attachments: ['server-a'],
      }),
    )
    vi.mocked(attachmentPut).mockResolvedValueOnce({
      ok: true,
      id: 'healed-a',
      att_key: 'healed-key-a',
    })
    const service = new CloudSyncService()
    await service.backupChat(CHAT_ID)
    await service.waitForAllUploads()
    expect(sentAttachments()).toEqual([[...IMAGE_A]])
    expect(push).toHaveBeenCalledTimes(2)
    const [first, second] = vi
      .mocked(push)
      .mock.calls.map(([request]) => request)
    expect(second.idempotencyKey).not.toBe(first.idempotencyKey)
    expect(
      JSON.parse(new TextDecoder().decode(second.plaintext)).messages[0]
        .attachments,
    ).toMatchObject([
      { id: 'healed-a', encryptionKey: 'healed-key-a' },
      { id: 'server-b', encryptionKey: 'key-b' },
    ])
    expect(await readChat()).toMatchObject({
      locallyModified: false,
      pendingUpload: 0,
      syncVersion: 1,
    })
  })
})
