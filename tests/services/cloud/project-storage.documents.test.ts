import {
  CloudBackupReadError,
  unwrapBackupPullResult,
} from '@/services/cloud/backup-read-error'
import { ProjectStorageService } from '@/services/cloud/project-storage'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  enclavePull: vi.fn(),
  enclavePush: vi.fn(),
  enclaveListStatus: vi.fn(),
  pullItemPlaintext: vi.fn(),
}))

vi.mock('@/services/auth', () => ({
  authTokenManager: { getToken: vi.fn() },
}))

vi.mock('@/services/cloud/cloud-key-authorization', () => ({
  canWriteToCloud: vi.fn().mockResolvedValue(true),
}))

vi.mock('@/services/cloud/cek-encoding', () => ({
  pullKey: () => [{ key: 'primary-key' }],
  requirePrimaryKeyB64: () => 'primary-key',
}))

vi.mock('@/services/sync-enclave/sync-api', async () => {
  const actual = await vi.importActual<
    typeof import('@/services/sync-enclave/sync-api')
  >('@/services/sync-enclave/sync-api')
  return {
    ...actual,
    deleteRow: vi.fn(),
    listStatus: mocks.enclaveListStatus,
    pull: mocks.enclavePull,
    push: mocks.enclavePush,
    newIdempotencyKey: () => 'idempotency-key',
    pullItemPlaintext: mocks.pullItemPlaintext,
  }
})

vi.mock('@/utils/error-handling', () => ({
  logError: vi.fn(),
}))

async function getDocumentForBackup(
  storage: ProjectStorageService,
  projectId: string,
  id: string,
  expectedEtag: string,
) {
  return unwrapBackupPullResult(
    (await storage.getDocumentsForBackup([{ projectId, id, expectedEtag }]))[0],
  )
}

describe('ProjectStorageService documents', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('persists and restores the original file size', async () => {
    const storage = new ProjectStorageService()
    vi.spyOn(storage, 'generateDocumentId').mockResolvedValue({
      documentId: 'doc-1',
      timestamp: '2026-01-01T00:00:00.000Z',
      reverseTimestamp: 1,
    })
    mocks.enclavePush.mockResolvedValue({ etag: '1' })

    const document = await storage.uploadDocument(
      'project-1',
      'notes.pdf',
      'application/pdf',
      'Extracted text',
      8192,
    )

    const pushRequest = mocks.enclavePush.mock.calls[0][0]
    const payload = JSON.parse(new TextDecoder().decode(pushRequest.plaintext))
    expect(payload.sizeBytes).toBe(8192)
    expect(document.sizeBytes).toBe(8192)

    mocks.enclavePull.mockResolvedValue({
      items: [{ id: 'project-1/doc-1', ok: true, etag: '1' }],
    })
    mocks.pullItemPlaintext.mockReturnValue(pushRequest.plaintext)
    const restored = await storage.getDocuments('project-1', ['doc-1'])
    expect(restored.get('doc-1')?.sizeBytes).toBe(8192)
  })

  it('persists and restores an image thumbnail', async () => {
    const storage = new ProjectStorageService()
    vi.spyOn(storage, 'generateDocumentId').mockResolvedValue({
      documentId: 'doc-1',
      timestamp: '2026-01-01T00:00:00.000Z',
      reverseTimestamp: 1,
    })
    mocks.enclavePush.mockResolvedValue({ etag: '1' })

    const document = await storage.uploadDocument(
      'project-1',
      'photo.png',
      'image/png',
      'A description of the photo',
      4096,
      'dGh1bWI=',
    )
    expect(document.thumbnailBase64).toBe('dGh1bWI=')

    const pushRequest = mocks.enclavePush.mock.calls[0][0]
    const payload = JSON.parse(new TextDecoder().decode(pushRequest.plaintext))
    expect(payload.thumbnailBase64).toBe('dGh1bWI=')

    mocks.enclavePull.mockResolvedValue({
      items: [{ id: 'project-1/doc-1', ok: true, etag: '1' }],
    })
    mocks.pullItemPlaintext.mockReturnValue(pushRequest.plaintext)
    const restored = await storage.getDocuments('project-1', ['doc-1'])
    expect(restored.get('doc-1')?.thumbnailBase64).toBe('dGh1bWI=')
  })

  it('omits the thumbnail field for documents without one', async () => {
    const storage = new ProjectStorageService()
    vi.spyOn(storage, 'generateDocumentId').mockResolvedValue({
      documentId: 'doc-1',
      timestamp: '2026-01-01T00:00:00.000Z',
      reverseTimestamp: 1,
    })
    mocks.enclavePush.mockResolvedValue({ etag: '1' })

    await storage.uploadDocument(
      'project-1',
      'notes.txt',
      'text/plain',
      'Plain notes',
    )

    const pushRequest = mocks.enclavePush.mock.calls[0][0]
    const payload = JSON.parse(new TextDecoder().decode(pushRequest.plaintext))
    expect('thumbnailBase64' in payload).toBe(false)
  })

  it('derives a size when reading legacy document payloads', async () => {
    const storage = new ProjectStorageService()
    const content = 'R\u00e9sum\u00e9'
    mocks.enclavePull.mockResolvedValue({
      items: [{ id: 'project-1/doc-1', ok: true, etag: '1' }],
    })
    mocks.pullItemPlaintext.mockReturnValue(
      new TextEncoder().encode(
        JSON.stringify({
          content,
          filename: 'notes.txt',
          contentType: 'text/plain',
        }),
      ),
    )

    const documents = await storage.getDocuments('project-1', ['doc-1'])

    expect(documents.get('doc-1')?.sizeBytes).toBe(
      new TextEncoder().encode(content).length,
    )
  })

  it('strictly distinguishes malformed document data from runtime failures', async () => {
    const storage = new ProjectStorageService()
    mocks.enclavePull.mockResolvedValue({
      items: [{ id: 'project-1/doc-1', ok: true, etag: '1' }],
    })
    mocks.pullItemPlaintext.mockReturnValue(new TextEncoder().encode('{'))

    const malformed = await getDocumentForBackup(
      storage,
      'project-1',
      'doc-1',
      '1',
    ).catch((error: unknown) => error)
    expect(malformed).toBeInstanceOf(CloudBackupReadError)
    expect(malformed).toMatchObject({
      category: 'item_invalid',
      reason: 'document_payload_invalid',
      omittable: true,
    })

    const runtimeFailure = new Error('unexpected JSON runtime failure')
    const parse = vi.spyOn(JSON, 'parse').mockImplementationOnce(() => {
      throw runtimeFailure
    })
    mocks.pullItemPlaintext.mockReturnValue(new TextEncoder().encode('{}'))
    try {
      await expect(
        getDocumentForBackup(storage, 'project-1', 'doc-1', '1'),
      ).rejects.toBe(runtimeFailure)
    } finally {
      parse.mockRestore()
    }
  })

  it('enforces captured document identity and opaque ETag for backup reads', async () => {
    const storage = new ProjectStorageService()
    mocks.enclavePull.mockResolvedValueOnce({
      items: [
        {
          id: 'project-1/doc-1',
          ok: true,
          etag: 'new-etag',
          plaintext: 'ignored',
        },
      ],
    })
    await expect(
      getDocumentForBackup(storage, 'project-1', 'doc-1', 'captured-etag'),
    ).rejects.toMatchObject({
      category: 'snapshot_changed',
      reason: 'record_changed_after_snapshot',
    })

    mocks.enclavePull.mockResolvedValueOnce({
      items: [{ id: 'doc-1', ok: true, etag: 'captured-etag' }],
    })
    await expect(
      getDocumentForBackup(storage, 'project-1', 'doc-1', 'captured-etag'),
    ).rejects.toMatchObject({ code: 'unexpected_item' })
  })

  it('accepts a document lazily rewrapped from the captured ETag', async () => {
    const storage = new ProjectStorageService()
    mocks.enclavePull.mockResolvedValueOnce({
      items: [
        {
          id: 'project-1/doc-1',
          ok: true,
          etag: 'rewrapped-etag',
          previous_etag: 'captured-etag',
        },
      ],
    })
    mocks.pullItemPlaintext.mockReturnValue(
      new TextEncoder().encode(
        JSON.stringify({
          filename: 'notes.txt',
          contentType: 'text/plain',
          content: 'rewrapped content',
        }),
      ),
    )

    await expect(
      getDocumentForBackup(storage, 'project-1', 'doc-1', 'captured-etag'),
    ).resolves.toMatchObject({
      id: 'doc-1',
      projectId: 'project-1',
      content: 'rewrapped content',
    })
  })

  it('deduplicates documents listed on multiple pages', async () => {
    const storage = new ProjectStorageService()
    // Simulates a row whose updated_at was bumped mid-walk (enclave
    // rewrap-on-pull), so the same id appears on two pages.
    mocks.enclaveListStatus
      .mockResolvedValueOnce({
        updates: [
          {
            id: 'project-1/doc-1',
            etag: '1',
            updated_at: '2026-01-01T00:00:00.000Z',
          },
          {
            id: 'project-1/doc-2',
            etag: '1',
            updated_at: '2026-01-01T00:00:01.000Z',
          },
        ],
        next_cursor: 'page-2',
      })
      .mockResolvedValueOnce({
        updates: [
          {
            id: 'project-1/doc-1',
            etag: '2',
            updated_at: '2026-01-01T00:00:02.000Z',
          },
          // Stale copy arriving after the fresher page-1 row: the
          // freshest copy must win, not the last occurrence.
          {
            id: 'project-1/doc-2',
            etag: '0',
            updated_at: '2025-12-31T00:00:00.000Z',
          },
        ],
        next_cursor: undefined,
      })

    const { documents } = await storage.listDocuments('project-1')

    // The freshest copy of each row wins, ordered by updated_at.
    expect(
      documents.map((doc) => ({ id: doc.id, updatedAt: doc.updatedAt })),
    ).toEqual([
      { id: 'doc-2', updatedAt: '2026-01-01T00:00:01.000Z' },
      { id: 'doc-1', updatedAt: '2026-01-01T00:00:02.000Z' },
    ])
  })

  it('excludes other projects\u2019 documents from the listing', async () => {
    const storage = new ProjectStorageService()
    mocks.enclaveListStatus.mockResolvedValueOnce({
      updates: [
        {
          id: 'project-1/doc-1',
          etag: '1',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
        {
          id: 'project-2/doc-9',
          etag: '1',
          updated_at: '2026-01-01T00:00:01.000Z',
        },
      ],
      next_cursor: undefined,
    })

    const { documents } = await storage.listDocuments('project-1')

    expect(documents).toHaveLength(1)
    expect(documents[0]).toMatchObject({ id: 'doc-1', projectId: 'project-1' })
  })

  it('marks failed pulls as unavailable documents', async () => {
    const storage = new ProjectStorageService()
    mocks.enclavePull.mockResolvedValue({
      items: [
        {
          id: 'project-1/doc-1',
          ok: false,
          code: 'UNKNOWN_KEY',
        },
      ],
    })

    const documents = await storage.getDocuments('project-1', ['doc-1'])

    expect(documents.get('doc-1')).toMatchObject({
      id: 'doc-1',
      projectId: 'project-1',
      decryptionFailed: true,
    })
  })
})
