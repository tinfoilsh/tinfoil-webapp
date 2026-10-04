import { CLOUD_SYNC } from '@/config'
import { AUTH_ACTIVE_USER_ID } from '@/constants/storage-keys'
import { unwrapBackupPullResult } from '@/services/cloud/backup-read-error'
import {
  CloudBackupReadError,
  CloudStorageService,
} from '@/services/cloud/cloud-storage'
import { SyncEnclaveError, SyncNetworkError } from '@/services/sync-enclave'
import { MAX_PULL_IDS } from '@/services/sync-enclave/sync-api'
import { EncryptedAttachmentValidationError } from '@/utils/binary-codec'
import { setCloudSyncEnabled } from '@/utils/cloud-sync-settings'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockGetAuthHeaders = vi.fn()
const mockIsAuthenticated = vi.fn()
const mockIsInitialized = vi.fn()
const mockWaitForInit = vi.fn()
const mockGetKey = vi.fn()
const mockGetAllKeys = vi.fn()
const mockGetKeyBytesOrThrow = vi.fn()
const mockGetAlternativeKeyBytes = vi.fn()
const mockEnclavePush = vi.fn()
const mockEnclavePull = vi.fn()
const mockEnclaveDeleteRow = vi.fn()
const mockRevisionSnapshot = vi.fn()
const mockListStatus = vi.fn()
const mockAttachmentPut = vi.fn()
const mockAttachmentGet = vi.fn()

vi.mock('@/services/auth', () => ({
  authTokenManager: {
    getAuthHeaders: (...args: any[]) => mockGetAuthHeaders(...args),
    isAuthenticated: (...args: any[]) => mockIsAuthenticated(...args),
    isInitialized: (...args: any[]) => mockIsInitialized(...args),
    waitForInit: (...args: any[]) => mockWaitForInit(...args),
  },
}))

vi.mock('@/services/encryption/encryption-service', () => ({
  encryptionService: {
    getKey: (...args: any[]) => mockGetKey(...args),
    getAllKeys: (...args: any[]) => mockGetAllKeys(...args),
    getKeyBytesOrThrow: (...args: any[]) => mockGetKeyBytesOrThrow(...args),
    getAlternativeKeyBytes: (...args: any[]) =>
      mockGetAlternativeKeyBytes(...args),
  },
}))

vi.mock('@/services/sync-enclave/sync-api', async () => {
  const actual: any = await vi.importActual('@/services/sync-enclave/sync-api')
  return {
    ...actual,
    push: (...args: any[]) => mockEnclavePush(...args),
    pull: (...args: any[]) => mockEnclavePull(...args),
    deleteRow: (...args: any[]) => mockEnclaveDeleteRow(...args),
    revisionSnapshot: (...args: any[]) => mockRevisionSnapshot(...args),
    listStatus: (...args: any[]) => mockListStatus(...args),
    attachmentPut: (...args: any[]) => mockAttachmentPut(...args),
    attachmentGet: (...args: any[]) => mockAttachmentGet(...args),
  }
})

async function downloadChatForBackup(
  storage: CloudStorageService,
  id: string,
  expectedEtag: string,
) {
  return unwrapBackupPullResult(
    (await storage.downloadChatsForBackup([{ id, expectedEtag }]))[0],
  )
}

describe('CloudStorageService auth readiness', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockAttachmentGet.mockReset()
    localStorage.clear()
    mockGetAuthHeaders.mockResolvedValue({ Authorization: 'Bearer token' })
    mockIsAuthenticated.mockResolvedValue(true)
    mockIsInitialized.mockReturnValue(true)
    mockWaitForInit.mockResolvedValue(true)
    // Real keys are `key_<base36-encoded 32-byte CEK>` per
    // encryption-service. Mock the shape end-to-end so the helpers
    // in `cek-encoding.ts` resolve to predictable bytes without
    // re-implementing the base36 decoder in the test.
    const TEST_KEY = `key_${'a'.repeat(64)}`
    const TEST_BYTES = new Uint8Array(32)
    mockGetKey.mockReturnValue(TEST_KEY)
    mockGetAllKeys.mockReturnValue({
      primary: TEST_KEY,
      alternatives: [TEST_KEY],
    })
    mockGetKeyBytesOrThrow.mockReturnValue(TEST_BYTES)
    mockGetAlternativeKeyBytes.mockReturnValue(TEST_BYTES)
    mockEnclavePush.mockResolvedValue({ ok: true, etag: '1', keyId: 'kid' })
    mockEnclavePull.mockResolvedValue({ items: [] })
    mockEnclaveDeleteRow.mockResolvedValue(undefined)
    mockRevisionSnapshot.mockResolvedValue({
      items: [],
      snapshot_revision: '0',
    })
    mockListStatus.mockResolvedValue({ updates: [], deletes: [] })
    mockAttachmentPut.mockResolvedValue({
      ok: true,
      id: 'att-v2',
      att_key: 'k',
    })
    mockAttachmentGet.mockResolvedValue(new Uint8Array([1, 2, 3]))
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          conversations: [],
          hasMore: false,
        }),
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    Object.defineProperty(CLOUD_SYNC, 'DOCUMENT_ATTACHMENT_WRITES_ENABLED', {
      value: false,
      configurable: true,
    })
  })

  function documentChat(payload: Record<string, unknown>) {
    return {
      id: 'chat-doc',
      title: 'Document',
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
      lastAccessedAt: 0,
      messages: [
        {
          role: 'user',
          content: 'summarize',
          timestamp: new Date(),
          attachments: [
            { id: 'doc', type: 'document', fileName: 'scan.pdf', ...payload },
          ],
        },
      ],
    } as any
  }

  it('keeps document text and pages inline by default without uploading blobs', async () => {
    expect(CLOUD_SYNC.DOCUMENT_ATTACHMENT_WRITES_ENABLED).toBe(false)
    const payload = {
      textContent: 'hello',
      pages: [{ page: 1, text: 'hello', image: 'AQID', is_scanned: true }],
    }
    await new CloudStorageService().uploadChat(documentChat(payload))
    expect(mockAttachmentPut).not.toHaveBeenCalled()
    expect(
      JSON.parse(
        new TextDecoder().decode(mockEnclavePush.mock.calls[0][0].plaintext),
      ).messages[0].attachments[0],
    ).toMatchObject(payload)
  })

  it('hydrates existing key-only documents before writing inline with the gate disabled', async () => {
    setCloudSyncEnabled(true)
    const payload = { textContent: 'recovered document' }
    mockAttachmentGet.mockResolvedValueOnce(
      new TextEncoder().encode(JSON.stringify(payload)),
    )
    await new CloudStorageService().uploadChat(
      documentChat({ encryptionKey: 'key' }),
    )
    expect(mockAttachmentGet).toHaveBeenCalledTimes(1)
    expect(mockAttachmentPut).not.toHaveBeenCalled()
    expect(
      JSON.parse(
        new TextDecoder().decode(mockEnclavePush.mock.calls[0][0].plaintext),
      ).messages[0].attachments[0],
    ).toMatchObject(payload)
  })

  it('never publishes a key-only document if hydration fails', async () => {
    setCloudSyncEnabled(true)
    mockAttachmentGet.mockRejectedValueOnce(new Error('unavailable'))
    await expect(
      new CloudStorageService().uploadChat(
        documentChat({ encryptionKey: 'key' }),
      ),
    ).rejects.toThrow()
    expect(mockEnclavePush).not.toHaveBeenCalled()
    expect(mockAttachmentPut).not.toHaveBeenCalled()
  })

  it('counts inline documents toward the unchanged size cap before any upload', async () => {
    const chat = documentChat({
      textContent: 'x'.repeat(CLOUD_SYNC.MAX_CHAT_PLAINTEXT_BYTES),
    })
    await expect(
      new CloudStorageService().uploadChat(chat),
    ).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' })
    expect(mockAttachmentPut).not.toHaveBeenCalled()
    expect(mockEnclavePush).not.toHaveBeenCalled()
  })

  it.each(['inline pages', 'hydrated pages'])(
    'applies the size cap to %s before uploading an image',
    async (source) => {
      setCloudSyncEnabled(true)
      const payload = {
        pages: [
          {
            page: 1,
            text: '',
            image: 'A'.repeat(CLOUD_SYNC.MAX_CHAT_PLAINTEXT_BYTES),
            is_scanned: true,
          },
        ],
      }
      const chat = documentChat(
        source === 'inline pages' ? payload : { encryptionKey: 'key' },
      )
      chat.messages[0].attachments.push({
        id: 'image',
        type: 'image',
        fileName: 'a.png',
        base64: 'AQID',
      })
      mockAttachmentGet.mockResolvedValue(
        new TextEncoder().encode(JSON.stringify(payload)),
      )
      await expect(
        new CloudStorageService().uploadChat(chat),
      ).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE', status: 413 })
      expect(mockAttachmentPut).not.toHaveBeenCalled()
      expect(mockEnclavePush).not.toHaveBeenCalled()
    },
  )

  it('settles each pulled chat in request order without hiding batch peers', async () => {
    mockEnclavePull.mockResolvedValue({
      items: [
        {
          id: 'present',
          ok: true,
          etag: '2',
          plaintext: btoa('{"title":"Present"}'),
        },
        { id: 'gone', ok: false, code: 'NOT_FOUND' },
        { id: 'locked', ok: false, code: 'UNKNOWN_KEY' },
      ],
    })

    await expect(
      new CloudStorageService().downloadChats(['gone', 'present', 'locked']),
    ).resolves.toEqual([
      { status: 'unavailable', id: 'gone', code: 'NOT_FOUND' },
      {
        status: 'ok',
        id: 'present',
        syncVersion: 2,
        content: '{"title":"Present"}',
      },
      { status: 'unavailable', id: 'locked', code: 'UNKNOWN_KEY' },
    ])
  })

  it('rejects incomplete, unexpected, and empty chat batches', async () => {
    const storage = new CloudStorageService()
    mockEnclavePull.mockResolvedValueOnce({ items: [] })
    await expect(storage.downloadChats(['chat-1'])).rejects.toThrow(
      'incomplete chat batch',
    )

    mockEnclavePull.mockResolvedValueOnce({
      items: [
        { id: 'chat-1', ok: true, etag: '1', plaintext: btoa('{}') },
        { id: 'chat-1', ok: true, etag: '1', plaintext: btoa('{}') },
      ],
    })
    await expect(storage.downloadChats(['chat-1'])).rejects.toThrow(
      'unexpected chat batch item',
    )

    mockEnclavePull.mockResolvedValueOnce({
      items: [
        { id: 'chat-1', ok: true, etag: '1', plaintext: btoa('{}') },
        { id: 'chat-2', ok: true, etag: '1', plaintext: btoa('{}') },
      ],
    })
    await expect(storage.downloadChats(['chat-1'])).rejects.toThrow(
      'unexpected chat batch item',
    )

    mockEnclavePull.mockResolvedValueOnce({
      items: [{ id: 'chat-1', ok: true, etag: '1' }],
    })
    await expect(storage.downloadChats(['chat-1'])).rejects.toThrow(
      'empty chat content',
    )
  })

  it('splits large downloads into enclave-sized pull requests', async () => {
    const ids = Array.from({ length: MAX_PULL_IDS + 1 }, (_, i) => `chat-${i}`)
    mockEnclavePull.mockImplementation(async ({ ids: batch }) => ({
      items: batch.map((id: string) => ({
        id,
        ok: true,
        etag: '1',
        plaintext: btoa('{}'),
      })),
    }))

    const results = await new CloudStorageService().downloadChats(ids)

    expect(results.map((result) => result.id)).toEqual(ids)
    expect(mockEnclavePull).toHaveBeenCalledTimes(2)
    expect(mockEnclavePull.mock.calls[0][0].ids).toHaveLength(MAX_PULL_IDS)
    expect(mockEnclavePull.mock.calls[1][0].ids).toEqual([ids[MAX_PULL_IDS]])
  })

  it('preserves structured backup attachment failures instead of swallowing them', async () => {
    const storage = new CloudStorageService()
    const attachment = {
      id: 'attachment',
      type: 'image' as const,
      fileName: 'image.png',
      encryptionKey: 'key',
    }
    const network = new SyncNetworkError()
    mockAttachmentGet.mockRejectedValueOnce(network)
    await expect(storage.loadChatImageForBackup(attachment)).rejects.toBe(
      network,
    )

    mockAttachmentGet.mockResolvedValueOnce(null)
    const missing = await storage
      .loadChatImageForBackup(attachment)
      .catch((error: unknown) => error)
    expect(missing).toBeInstanceOf(CloudBackupReadError)
    expect(missing).toMatchObject({
      category: 'item_unavailable',
      reason: 'attachment_not_found',
      omittable: true,
    })

    const locked = await storage
      .loadChatImageForBackup({
        id: 'missing-key',
        type: 'image',
        fileName: 'image.png',
      })
      .catch((error: unknown) => error)
    expect(locked).toBeInstanceOf(CloudBackupReadError)
    expect(locked).toMatchObject({
      category: 'item_invalid',
      reason: 'attachment_key_unavailable',
      omittable: true,
    })
  })

  it('translates only structured modern attachment not-found errors', async () => {
    const storage = new CloudStorageService()
    const attachment = {
      id: 'attachment',
      type: 'image' as const,
      fileName: 'image.png',
      encryptionKey: 'key',
    }
    const missingByStatus = new SyncEnclaveError(
      'Attachment missing',
      404,
      'ATTACHMENT_MISSING',
    )
    mockAttachmentGet.mockRejectedValueOnce(missingByStatus)
    await expect(
      storage.loadChatImageForBackup(attachment),
    ).rejects.toMatchObject({
      category: 'item_unavailable',
      reason: 'attachment_not_found',
      cause: missingByStatus,
    })

    const missingByCode = new SyncEnclaveError(
      'Attachment missing',
      undefined,
      'NOT_FOUND',
    )
    mockAttachmentGet.mockRejectedValueOnce(missingByCode)
    await expect(
      storage.loadChatImageForBackup(attachment),
    ).rejects.toMatchObject({
      category: 'item_unavailable',
      reason: 'attachment_not_found',
      cause: missingByCode,
    })

    for (const fatal of [
      new SyncEnclaveError('Server failed', 500, 'INTERNAL'),
      new SyncEnclaveError('Unauthorized', 401, 'UNAUTHORIZED'),
      new Error('Unexpected attachment failure'),
    ]) {
      mockAttachmentGet.mockRejectedValueOnce(fatal)
      await expect(storage.loadChatImageForBackup(attachment)).rejects.toBe(
        fatal,
      )
    }
  })

  it('omits only structured chat decode failures in the strict backup adapter', async () => {
    const storage = new CloudStorageService()
    mockEnclavePull.mockResolvedValue({
      items: [
        {
          id: 'chat',
          ok: true,
          etag: '1',
          plaintext: btoa('{'),
        },
      ],
    })
    const malformed = await downloadChatForBackup(storage, 'chat', '1').catch(
      (error: unknown) => error,
    )
    expect(malformed).toBeInstanceOf(CloudBackupReadError)
    expect(malformed).toMatchObject({
      category: 'item_invalid',
      reason: 'chat_payload_invalid',
      omittable: true,
    })

    const runtimeFailure = new Error('unexpected JSON runtime failure')
    const parse = vi.spyOn(JSON, 'parse').mockImplementationOnce(() => {
      throw runtimeFailure
    })
    mockEnclavePull.mockResolvedValue({
      items: [
        {
          id: 'chat',
          ok: true,
          etag: '1',
          plaintext: btoa('{}'),
        },
      ],
    })
    try {
      await expect(downloadChatForBackup(storage, 'chat', '1')).rejects.toBe(
        runtimeFailure,
      )
    } finally {
      parse.mockRestore()
    }
  })

  it('requires the captured opaque ETag and exact item identity for backup reads', async () => {
    const storage = new CloudStorageService()
    mockEnclavePull.mockResolvedValueOnce({
      items: [
        { id: 'chat', ok: true, etag: 'new-etag', plaintext: btoa('{}') },
      ],
    })
    await expect(
      downloadChatForBackup(storage, 'chat', 'captured-etag'),
    ).rejects.toMatchObject({
      category: 'snapshot_changed',
      reason: 'record_changed_after_snapshot',
      omittable: true,
    })

    mockEnclavePull.mockResolvedValueOnce({
      items: [{ id: 'other-chat', ok: true, etag: 'captured-etag' }],
    })
    await expect(
      downloadChatForBackup(storage, 'chat', 'captured-etag'),
    ).rejects.toMatchObject({ code: 'unexpected_item' })

    mockEnclavePull.mockResolvedValueOnce({ items: [] })
    await expect(
      downloadChatForBackup(storage, 'chat', 'captured-etag'),
    ).rejects.toMatchObject({ code: 'missing_item' })

    mockEnclavePull.mockResolvedValueOnce({
      items: [{ id: 'chat', ok: true, plaintext: btoa('{}') }],
    })
    await expect(
      downloadChatForBackup(storage, 'chat', 'captured-etag'),
    ).rejects.toMatchObject({ code: 'missing_etag' })

    mockEnclavePull.mockResolvedValueOnce({
      items: [
        {
          id: 'chat',
          ok: false,
          code: 'UNKNOWN_KEY',
          etag: 'captured-etag',
          previous_etag: 7,
        },
      ],
    })
    await expect(
      downloadChatForBackup(storage, 'chat', 'captured-etag'),
    ).rejects.toMatchObject({ code: 'invalid_previous_etag' })

    mockEnclavePull.mockResolvedValueOnce({
      items: [{ id: 'chat', ok: false, code: 'NOT_FOUND' }],
    })
    await expect(
      downloadChatForBackup(storage, 'chat', 'captured-etag'),
    ).rejects.toMatchObject({
      category: 'snapshot_deleted',
      reason: 'record_deleted_after_snapshot',
    })
  })

  it('accepts a successful lazy rewrap only through a valid previous ETag', async () => {
    const storage = new CloudStorageService()
    mockEnclavePull.mockResolvedValueOnce({
      items: [
        {
          id: 'chat',
          ok: true,
          etag: 'rewrapped-etag',
          previous_etag: 'captured-etag',
          plaintext: btoa('{"title":"Rewrapped","messages":[]}'),
        },
      ],
    })

    await expect(
      downloadChatForBackup(storage, 'chat', 'captured-etag'),
    ).resolves.toMatchObject({ id: 'chat', title: 'Rewrapped' })

    mockEnclavePull.mockResolvedValueOnce({
      items: [
        {
          id: 'chat',
          ok: true,
          etag: 'captured-etag',
          previous_etag: '',
          plaintext: btoa('{}'),
        },
      ],
    })
    await expect(
      downloadChatForBackup(storage, 'chat', 'captured-etag'),
    ).rejects.toMatchObject({ code: 'invalid_previous_etag' })
  })

  it('checks failed pull versions before preserving key failures', async () => {
    const storage = new CloudStorageService()
    mockEnclavePull.mockResolvedValueOnce({
      items: [{ id: 'chat', ok: false, code: 'UNKNOWN_KEY', etag: 'new-etag' }],
    })
    await expect(
      downloadChatForBackup(storage, 'chat', 'captured-etag'),
    ).rejects.toMatchObject({
      category: 'snapshot_changed',
      reason: 'record_changed_after_snapshot',
    })

    mockEnclavePull.mockResolvedValueOnce({
      items: [
        {
          id: 'chat',
          ok: false,
          code: 'UNKNOWN_KEY',
          etag: 'rewrapped-etag',
          previous_etag: 'captured-etag',
        },
      ],
    })
    const matchingKeyFailure = await downloadChatForBackup(
      storage,
      'chat',
      'captured-etag',
    ).catch((error: unknown) => error)
    expect(matchingKeyFailure).toBeInstanceOf(SyncEnclaveError)
    expect(matchingKeyFailure).toMatchObject({ code: 'UNKNOWN_KEY' })

    mockEnclavePull.mockResolvedValueOnce({
      items: [{ id: 'chat', ok: false, code: 'UNKNOWN_KEY' }],
    })
    await expect(
      downloadChatForBackup(storage, 'chat', 'captured-etag'),
    ).rejects.toMatchObject({ code: 'missing_etag' })

    mockEnclavePull.mockResolvedValueOnce({
      items: [{ id: 'chat', ok: false, code: 'NOT_FOUND', etag: 'new-etag' }],
    })
    await expect(
      downloadChatForBackup(storage, 'chat', 'captured-etag'),
    ).rejects.toMatchObject({ category: 'snapshot_changed' })
  })

  it('keeps unknown legacy attachment runtime failures fatal', async () => {
    const runtimeFailure = new Error('unexpected response failure')
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        arrayBuffer: async () => {
          throw runtimeFailure
        },
      }),
    )

    await expect(
      new CloudStorageService().loadChatImageForBackup({
        id: 'legacy',
        type: 'image',
        fileName: 'legacy.png',
        key: 'AA==',
      } as unknown as Parameters<
        CloudStorageService['loadChatImageForBackup']
      >[0]),
    ).rejects.toBe(runtimeFailure)
  })

  it('omits only structured legacy attachment decode and decrypt failures', async () => {
    const storage = new CloudStorageService()
    const encrypted = new Uint8Array(32).buffer
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        arrayBuffer: async () => encrypted,
      }),
    )

    await expect(
      storage.loadChatImageForBackup({
        id: 'malformed-key',
        type: 'image',
        fileName: 'legacy.png',
        key: 'not base64!',
      } as unknown as Parameters<
        CloudStorageService['loadChatImageForBackup']
      >[0]),
    ).rejects.toMatchObject({
      category: 'item_invalid',
      reason: 'attachment_key_invalid',
      omittable: true,
      cause: expect.objectContaining({ name: 'InvalidCharacterError' }),
    })

    const key = btoa(String.fromCharCode(...new Uint8Array(32)))
    const invalidLength = await storage
      .loadChatImageForBackup({
        id: 'invalid-key-length',
        type: 'image',
        fileName: 'legacy.png',
        key: 'AA==',
      } as unknown as Parameters<
        CloudStorageService['loadChatImageForBackup']
      >[0])
      .catch((error: unknown) => error)
    expect(invalidLength).toMatchObject({
      category: 'item_invalid',
      reason: 'attachment_key_invalid',
      omittable: true,
    })
    expect(invalidLength.cause).toBeInstanceOf(
      EncryptedAttachmentValidationError,
    )

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        arrayBuffer: async () => new Uint8Array(20).buffer,
      }),
    )
    const truncated = await storage
      .loadChatImageForBackup({
        id: 'truncated-ciphertext',
        type: 'image',
        fileName: 'legacy.png',
        key,
      } as unknown as Parameters<
        CloudStorageService['loadChatImageForBackup']
      >[0])
      .catch((error: unknown) => error)
    expect(truncated).toMatchObject({
      category: 'item_invalid',
      reason: 'attachment_payload_invalid',
      omittable: true,
    })
    expect(truncated.cause).toBeInstanceOf(EncryptedAttachmentValidationError)

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        arrayBuffer: async () => encrypted,
      }),
    )
    await expect(
      storage.loadChatImageForBackup({
        id: 'corrupt-ciphertext',
        type: 'image',
        fileName: 'legacy.png',
        key,
      } as unknown as Parameters<
        CloudStorageService['loadChatImageForBackup']
      >[0]),
    ).rejects.toMatchObject({
      category: 'item_invalid',
      reason: 'attachment_payload_invalid',
      omittable: true,
      cause: expect.objectContaining({ name: 'OperationError' }),
    })
  })

  it('keeps legacy attachment transport, HTTP, and runtime failures fatal', async () => {
    const storage = new CloudStorageService()
    const attachment = {
      id: 'legacy',
      type: 'image',
      fileName: 'legacy.png',
      key: btoa(String.fromCharCode(...new Uint8Array(32))),
    } as unknown as Parameters<CloudStorageService['loadChatImageForBackup']>[0]
    const networkCause = new TypeError('Network unavailable')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(networkCause))
    await expect(
      storage.loadChatImageForBackup(attachment),
    ).rejects.toMatchObject({ code: 'NETWORK', cause: networkCause })

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce({ ok: false, status: 503 }),
    )
    await expect(
      storage.loadChatImageForBackup(attachment),
    ).rejects.toMatchObject({ status: 503 })

    const runtimeFailure = new Error('Unexpected crypto runtime failure')
    const decrypt = vi
      .spyOn(crypto.subtle, 'decrypt')
      .mockRejectedValueOnce(runtimeFailure)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        arrayBuffer: async () => new Uint8Array(32).buffer,
      }),
    )
    try {
      await expect(storage.loadChatImageForBackup(attachment)).rejects.toBe(
        runtimeFailure,
      )
    } finally {
      decrypt.mockRestore()
    }
  })

  it('preserves an explicit project delete on a single conflict pull', async () => {
    mockEnclavePull.mockResolvedValue({
      items: [
        {
          id: 'chat-1',
          ok: true,
          etag: '2',
          project_id_set: true,
          project_id: null,
          plaintext: btoa(
            JSON.stringify({
              id: 'chat-1',
              title: 'Remote',
              messages: [],
              projectId: 'stale-project',
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-02T00:00:00.000Z',
            }),
          ),
        },
      ],
    })

    const chat = await new CloudStorageService().downloadChat('chat-1')

    expect(chat?.projectId).toBeUndefined()
  })

  it('waits for auth token manager initialization before listing chats', async () => {
    mockIsInitialized.mockReturnValue(false)
    localStorage.setItem(AUTH_ACTIVE_USER_ID, 'user_123')

    const service = new CloudStorageService()
    await service.listChats()

    expect(mockWaitForInit).toHaveBeenCalledWith(3000)
    expect(mockListStatus).toHaveBeenCalledWith({
      scope: 'chat',
      cursor: undefined,
      limit: 100,
      direction: 'desc',
    })
  })

  it('enumerates every remote chat ID for a project', async () => {
    mockListStatus
      .mockResolvedValueOnce({
        updates: [
          { id: 'chat-1', project_id: 'project-1' },
          { id: 'other-chat', project_id: 'project-2' },
        ],
        next_cursor: 'page-2',
      })
      .mockResolvedValueOnce({
        updates: [{ id: 'chat-2', project_id: 'project-1' }],
      })

    await expect(
      new CloudStorageService().listChatIdsByProject('project-1'),
    ).resolves.toEqual(['chat-1', 'chat-2'])
    expect(mockListStatus).toHaveBeenNthCalledWith(2, {
      scope: 'chat',
      projectId: 'project-1',
      cursor: 'page-2',
      limit: 500,
    })
  })

  it('stops project pagination when its account operation expires', async () => {
    let current = true
    mockListStatus.mockImplementationOnce(async () => {
      current = false
      return {
        updates: [{ id: 'chat-1', project_id: 'project-1' }],
        next_cursor: 'page-2',
      }
    })
    const guard = {
      userId: 'user-1',
      isCurrent: () => current,
      assertCurrent: () => {
        if (!current) throw new Error('Cloud account changed')
      },
    }

    await expect(
      new CloudStorageService().listChatIdsByProject('project-1', guard),
    ).rejects.toThrow('Cloud account changed')
    expect(mockListStatus).toHaveBeenCalledTimes(1)
  })

  it('waits for auth token manager initialization before checking auth state', async () => {
    mockIsInitialized.mockReturnValue(false)
    localStorage.setItem(AUTH_ACTIVE_USER_ID, 'user_123')

    const service = new CloudStorageService()
    const isAuthenticated = await service.isAuthenticated()

    expect(isAuthenticated).toBe(true)
    expect(mockWaitForInit).toHaveBeenCalledWith(3000)
    expect(mockIsAuthenticated).toHaveBeenCalledTimes(1)
  })

  it('returns only the number of chats deleted from cloud storage', async () => {
    mockRevisionSnapshot.mockResolvedValueOnce({
      items: [{ id: 'chat-1' }, { id: 'chat-2' }],
      snapshot_revision: '2',
    })

    const result = await new CloudStorageService().deleteAllChats()

    expect(result).toEqual({ deleted: 2 })
    expect(mockEnclaveDeleteRow).toHaveBeenCalledTimes(2)
  })

  it('returns only the deleted count for project chat deletion', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ deleted: 2, ignored: true }),
    } as Response)

    const result = await new CloudStorageService().deleteChatsByProject(
      'project-1',
    )

    expect(result).toEqual({ deleted: 2 })
  })

  it('marks restore uploads so the enclave can clear stale tombstones', async () => {
    const service = new CloudStorageService()
    await service.uploadChat(
      {
        id: 'chat-1',
        title: 'Local chat',
        messages: [{ role: 'user', content: 'hi' }],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        lastAccessedAt: 0,
      } as any,
      { restoreDeleted: true },
    )

    expect(mockEnclavePush).toHaveBeenCalledTimes(1)
    const pushArg = mockEnclavePush.mock.calls[0][0]
    expect(pushArg.scope).toBe('chat')
    expect(pushArg.id).toBe('chat-1')
    expect(pushArg.metadata).toMatchObject({ restoreDeleted: true })
  })

  it('omits stale project metadata from dirty content-only uploads', async () => {
    const service = new CloudStorageService()
    await service.uploadChat({
      id: 'chat-1',
      title: 'Dirty content',
      messages: [{ role: 'user', content: 'edited' }],
      projectId: 'stale-project',
      projectLocallyModified: false,
      syncVersion: 2,
      locallyModified: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      lastAccessedAt: 0,
    } as any)

    expect(mockEnclavePush.mock.calls[0][0].metadata).not.toHaveProperty(
      'projectId',
    )
  })

  it('includes project metadata for an intentional local move', async () => {
    const service = new CloudStorageService()
    await service.uploadChat({
      id: 'chat-1',
      title: 'Moved chat',
      messages: [{ role: 'user', content: 'edited' }],
      projectId: 'local-project',
      projectLocallyModified: true,
      syncVersion: 2,
      locallyModified: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      lastAccessedAt: 0,
    } as any)

    expect(mockEnclavePush.mock.calls[0][0].metadata).toMatchObject({
      projectId: 'local-project',
    })
  })

  it('never uploads device-local recovery tokens', async () => {
    const service = new CloudStorageService()
    await service.uploadChat({
      id: 'chat-1',
      title: 'Local chat',
      messages: [{ role: 'user', content: 'hi' }],
      pendingRecoveries: [
        {
          v: 1,
          storage: 'local',
          turnId: 'turn-1',
          createdAt: '2026-01-01T00:00:00.000Z',
          expiresAt: '2026-01-02T00:00:00.000Z',
          sessionId: '0123456789abcdef0123456789abcdef',
          recoveryToken: 'sensitive-local-token',
        },
      ],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      lastAccessedAt: 0,
    } as any)

    const plaintext = JSON.parse(
      new TextDecoder().decode(mockEnclavePush.mock.calls[0][0].plaintext),
    )
    expect(plaintext.pendingRecoveries).toBeUndefined()
    expect(JSON.stringify(plaintext)).not.toContain('sensitive-local-token')
  })

  it('reuses stable attachment idempotency keys across upload retries', async () => {
    const service = new CloudStorageService()
    const chat = {
      id: 'chat-1',
      title: 'Local chat',
      messages: [
        {
          role: 'user',
          content: 'hi',
          attachments: [
            {
              id: 'local-att',
              type: 'image',
              fileName: 'image.png',
              base64: 'AQID',
            },
          ],
        },
      ],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      lastAccessedAt: 0,
    } as any

    await service.uploadChat(chat, { idempotencyKey: 'upload-idem-1' })
    const firstKey = mockAttachmentPut.mock.calls[0][0].idempotencyKey

    chat.messages[0].attachments[0].id = 'local-att'
    chat.messages[0].attachments[0].base64 = 'AQID'
    chat.messages[0].attachments[0].encryptionKey = undefined
    await service.uploadChat(chat, { idempotencyKey: 'upload-idem-1' })

    expect(mockAttachmentPut).toHaveBeenCalledTimes(2)
    expect(mockAttachmentPut.mock.calls[1][0].idempotencyKey).toBe(firstKey)
  })

  it('keeps the attachment idempotency key stable across separate logical uploads', async () => {
    // A failed chat push leaves the local attachment without an
    // encryptionKey, so the next sync cycle re-uploads it under a fresh
    // upload idempotency key. The attachment key must not depend on
    // that per-upload key or every cycle mints a new server-side blob.
    const service = new CloudStorageService()
    const makeChat = () =>
      ({
        id: 'chat-1',
        title: 'Local chat',
        messages: [
          {
            role: 'user',
            content: 'hi',
            attachments: [
              {
                id: 'local-att',
                type: 'image',
                fileName: 'image.png',
                base64: 'AQID',
              },
            ],
          },
        ],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        lastAccessedAt: 0,
      }) as any

    await service.uploadChat(makeChat(), { idempotencyKey: 'upload-idem-1' })
    await service.uploadChat(makeChat(), { idempotencyKey: 'upload-idem-2' })

    expect(mockAttachmentPut).toHaveBeenCalledTimes(2)
    expect(mockAttachmentPut.mock.calls[1][0].idempotencyKey).toBe(
      mockAttachmentPut.mock.calls[0][0].idempotencyKey,
    )
  })

  it('derives distinct attachment idempotency keys for different bytes, chats, or attachment ids', async () => {
    const service = new CloudStorageService()
    const makeChat = (chatId: string, attachmentId: string, base64: string) =>
      ({
        id: chatId,
        title: 'Local chat',
        messages: [
          {
            role: 'user',
            content: 'hi',
            attachments: [
              {
                id: attachmentId,
                type: 'image',
                fileName: 'image.png',
                base64,
              },
            ],
          },
        ],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        lastAccessedAt: 0,
      }) as any

    await service.uploadChat(makeChat('chat-1', 'local-att', 'AQID'), {
      idempotencyKey: 'upload-idem-1',
    })
    await service.uploadChat(makeChat('chat-1', 'local-att', 'BAUG'), {
      idempotencyKey: 'upload-idem-1',
    })
    await service.uploadChat(makeChat('chat-2', 'local-att', 'AQID'), {
      idempotencyKey: 'upload-idem-1',
    })
    // Same chat and bytes under a different client id: two identical
    // images in one chat must land on distinct slots.
    await service.uploadChat(makeChat('chat-1', 'local-att-2', 'AQID'), {
      idempotencyKey: 'upload-idem-1',
    })

    const keys = mockAttachmentPut.mock.calls.map(
      (call) => call[0].idempotencyKey,
    )
    expect(new Set(keys).size).toBe(4)
  })

  it('returns local payload identity without including it in cloud plaintext', async () => {
    const service = new CloudStorageService()
    const result = await service.uploadChat(
      {
        id: 'chat-1',
        title: 'Local chat',
        messages: [
          {
            role: 'user',
            content: 'hi',
            attachments: [
              {
                id: 'local-att',
                type: 'image',
                fileName: 'image.png',
                base64: 'AQID',
                storagePayloadId: 'local-payload-reference',
              },
            ],
          },
        ],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        lastAccessedAt: 0,
      } as any,
      { idempotencyKey: 'upload-idem-1' },
    )

    expect(result.rewrites).toEqual([
      expect.objectContaining({
        clientId: 'local-att',
        storagePayloadId: 'local-payload-reference',
      }),
    ])
    const plaintext = new TextDecoder().decode(
      mockEnclavePush.mock.calls[0][0].plaintext,
    )
    expect(plaintext).not.toContain('storagePayloadId')
    expect(plaintext).not.toContain('local-payload-reference')
  })

  it('reports uploaded attachments before pushing the chat', async () => {
    const service = new CloudStorageService()
    const order: string[] = []
    mockAttachmentPut.mockImplementationOnce(async () => {
      order.push('attachment-put')
      return { id: 'srv-att', att_key: 'k' }
    })
    mockEnclavePush.mockImplementationOnce(async () => {
      order.push('push')
      return { etag: '1' }
    })
    const onAttachmentsUploaded = vi.fn(async () => {
      order.push('persist')
    })

    await service.uploadChat(
      {
        id: 'chat-1',
        title: 'Local chat',
        messages: [
          {
            role: 'user',
            content: 'hi',
            attachments: [
              {
                id: 'local-att',
                type: 'image',
                fileName: 'image.png',
                base64: 'AQID',
              },
            ],
          },
        ],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        lastAccessedAt: 0,
      } as any,
      { idempotencyKey: 'upload-idem-1', onAttachmentsUploaded },
    )

    expect(order).toEqual(['attachment-put', 'persist', 'push'])
    expect(onAttachmentsUploaded).toHaveBeenCalledWith([
      expect.objectContaining({
        clientId: 'local-att',
        serverId: 'srv-att',
        encryptionKey: 'k',
      }),
    ])
  })

  it('uploads document content as a blob and strips it from the chat envelope', async () => {
    Object.defineProperty(CLOUD_SYNC, 'DOCUMENT_ATTACHMENT_WRITES_ENABLED', {
      value: true,
      configurable: true,
    })
    mockAttachmentPut.mockResolvedValueOnce({ id: 'srv-doc', att_key: 'dk' })
    const service = new CloudStorageService()
    const pages = [{ page: 1, text: 'hello', image: 'AQID', is_scanned: true }]
    const result = await service.uploadChat(
      {
        id: 'chat-1',
        title: 'Doc chat',
        messages: [
          {
            role: 'user',
            content: 'summarize',
            attachments: [
              {
                id: 'local-doc',
                type: 'document',
                fileName: 'scan.pdf',
                mimeType: 'application/pdf',
                textContent: 'hello',
                pages,
              },
            ],
          },
        ],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        lastAccessedAt: 0,
      } as any,
      { idempotencyKey: 'upload-idem-1' },
    )

    expect(mockAttachmentPut).toHaveBeenCalledTimes(1)
    const put = mockAttachmentPut.mock.calls[0][0]
    expect(put.chatId).toBe('chat-1')
    expect(JSON.parse(new TextDecoder().decode(put.plaintext))).toEqual({
      textContent: 'hello',
      pages,
    })

    const plaintext = JSON.parse(
      new TextDecoder().decode(mockEnclavePush.mock.calls[0][0].plaintext),
    )
    expect(plaintext.messages[0].attachments[0]).toEqual({
      id: 'srv-doc',
      type: 'document',
      fileName: 'scan.pdf',
      mimeType: 'application/pdf',
      encryptionKey: 'dk',
    })
    expect(JSON.stringify(plaintext)).not.toContain('AQID')
    expect(result.rewrites).toEqual([
      expect.objectContaining({
        clientId: 'local-doc',
        serverId: 'srv-doc',
        encryptionKey: 'dk',
      }),
    ])
  })

  it('does not re-upload a document that already has an enclave key', async () => {
    Object.defineProperty(CLOUD_SYNC, 'DOCUMENT_ATTACHMENT_WRITES_ENABLED', {
      value: true,
      configurable: true,
    })
    const service = new CloudStorageService()
    await service.uploadChat(
      {
        id: 'chat-1',
        title: 'Doc chat',
        messages: [
          {
            role: 'user',
            content: 'summarize',
            attachments: [
              {
                id: 'srv-doc',
                type: 'document',
                fileName: 'scan.pdf',
                textContent: 'hello',
                encryptionKey: 'dk',
              },
            ],
          },
        ],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        lastAccessedAt: 0,
      } as any,
      { idempotencyKey: 'upload-idem-1' },
    )
    expect(mockAttachmentPut).not.toHaveBeenCalled()
    const plaintext = new TextDecoder().decode(
      mockEnclavePush.mock.calls[0][0].plaintext,
    )
    expect(plaintext).not.toContain('"textContent"')
  })

  it('loads offloaded document content alongside images', async () => {
    const encoder = new TextEncoder()
    mockAttachmentGet.mockImplementation(async ({ id }: { id: string }) =>
      id === 'srv-doc'
        ? encoder.encode(JSON.stringify({ textContent: 'from blob' }))
        : new Uint8Array([1, 2, 3]),
    )
    const service = new CloudStorageService()
    const loaded = await service.loadChatAttachments('chat-1', [
      {
        role: 'user',
        content: 'hi',
        attachments: [
          {
            id: 'srv-doc',
            type: 'document',
            fileName: 'a.pdf',
            encryptionKey: 'dk',
          },
          {
            id: 'srv-img',
            type: 'image',
            fileName: 'a.png',
            encryptionKey: 'ik',
          },
          {
            id: 'inline-doc',
            type: 'document',
            fileName: 'b.txt',
            textContent: 'x',
          },
        ],
      } as any,
    ])
    expect(loaded.documents).toEqual({
      'srv-doc': { textContent: 'from blob' },
    })
    expect(Object.keys(loaded.images)).toEqual(['srv-img'])
    expect(mockAttachmentGet).toHaveBeenCalledTimes(2)
  })

  it('rejects an oversized chat before uploading any attachment', async () => {
    const service = new CloudStorageService()
    const chat = {
      id: 'chat-1',
      title: 'Huge chat',
      messages: [
        {
          role: 'user',
          content: 'x'.repeat(CLOUD_SYNC.MAX_CHAT_PLAINTEXT_BYTES + 1),
          attachments: [
            {
              id: 'local-att',
              type: 'image',
              fileName: 'image.png',
              base64: 'AQID',
            },
          ],
        },
      ],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      lastAccessedAt: 0,
    } as any

    const failure = await service
      .uploadChat(chat, { idempotencyKey: 'upload-idem-1' })
      .catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(SyncEnclaveError)
    expect((failure as SyncEnclaveError).code).toBe('PAYLOAD_TOO_LARGE')
    expect((failure as SyncEnclaveError).status).toBe(413)
    expect(mockAttachmentPut).not.toHaveBeenCalled()
    expect(mockEnclavePush).not.toHaveBeenCalled()
  })

  it('does not re-upload attachments that already have enclave keys', async () => {
    const service = new CloudStorageService()
    const chat = {
      id: 'chat-1',
      title: 'Local chat',
      messages: [
        {
          role: 'user',
          content: 'hi',
          attachments: [
            {
              id: 'att-v2',
              type: 'image',
              fileName: 'image.png',
              base64: 'AQID',
              encryptionKey: 'existing-key',
            },
          ],
        },
      ],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      lastAccessedAt: 0,
    } as any

    await service.uploadChat(chat, { idempotencyKey: 'upload-idem-1' })

    expect(mockAttachmentPut).not.toHaveBeenCalled()
  })

  it('uploads attachments before chat push so retries reuse enclave-minted ids', async () => {
    mockEnclavePush.mockRejectedValueOnce(new Error('push failed'))
    const service = new CloudStorageService()
    const chat = {
      id: 'chat-1',
      title: 'Local chat',
      messages: [
        {
          role: 'user',
          content: 'hi',
          attachments: [
            {
              id: 'local-att',
              type: 'image',
              fileName: 'image.png',
              base64: 'AQID',
            },
          ],
        },
      ],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      lastAccessedAt: 0,
    } as any

    await expect(
      service.uploadChat(chat, { idempotencyKey: 'upload-idem-1' }),
    ).rejects.toThrow('push failed')

    expect(mockAttachmentPut).toHaveBeenCalledTimes(1)
    // The caller's chat object is intentionally NOT mutated; rewrites
    // travel as a side channel and are applied by finalizeUpload.
    expect(chat.messages[0].attachments[0]).toMatchObject({
      id: 'local-att',
    })
  })

  it('does not downgrade v2 attachment reads to legacy fetch on enclave failure', async () => {
    mockAttachmentGet.mockRejectedValueOnce(new Error('attestation failed'))
    const service = new CloudStorageService()
    const images = await service.loadChatImages('chat-1', [
      {
        role: 'user',
        content: 'image',
        attachments: [
          {
            id: 'att-v2',
            type: 'image',
            encryptionKey: 'att-key',
          },
        ],
      },
    ] as any)

    expect(images).toEqual({})
    expect(mockAttachmentGet).toHaveBeenCalledWith({
      id: 'att-v2',
      attKeyB64: 'att-key',
    })
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })
})
