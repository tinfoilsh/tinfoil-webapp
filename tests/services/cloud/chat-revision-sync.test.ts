import { CLOUD_SYNC } from '@/config'
import {
  BOOTSTRAP_RECENT_CONTENT_LIMIT,
  drainChatRevisionSync,
} from '@/services/cloud/chat-revision-sync'
import type { StoredChat } from '@/services/storage/indexed-db'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  getSyncState,
  hasPendingSyncWork,
  getChat,
  applyRemoteDeletion,
  commitRevisionBatch,
  reconcileRevisionSnapshot,
  getPendingDeletes,
  acknowledgePendingDelete,
  getPendingUploadChats,
  revisionSummary,
  revisionEvents,
  revisionSnapshot,
  downloadChats,
  deleteChat,
  ingestRemoteChats,
  markAsRemoteDeleted,
  removeRemoteDeletion,
  emitChatEvent,
} = vi.hoisted(() => ({
  getSyncState: vi.fn(),
  hasPendingSyncWork: vi.fn(),
  getChat: vi.fn(),
  applyRemoteDeletion: vi.fn(),
  commitRevisionBatch: vi.fn(),
  reconcileRevisionSnapshot: vi.fn(),
  getPendingDeletes: vi.fn(),
  acknowledgePendingDelete: vi.fn(),
  getPendingUploadChats: vi.fn(),
  revisionSummary: vi.fn(),
  revisionEvents: vi.fn(),
  revisionSnapshot: vi.fn(),
  downloadChats: vi.fn(),
  deleteChat: vi.fn(),
  ingestRemoteChats: vi.fn(),
  markAsRemoteDeleted: vi.fn(),
  removeRemoteDeletion: vi.fn(),
  emitChatEvent: vi.fn(),
}))

vi.mock('@/services/storage/indexed-db', () => ({
  indexedDBStorage: {
    getSyncState,
    hasPendingSyncWork,
    getChat,
    applyRemoteDeletion,
    commitRevisionBatch,
    reconcileRevisionSnapshot,
    getPendingDeletes,
    acknowledgePendingDelete,
    getPendingUploadChats,
  },
}))

vi.mock('@/services/sync-enclave/sync-api', async () => ({
  ...(await vi.importActual<typeof import('@/services/sync-enclave/sync-api')>(
    '@/services/sync-enclave/sync-api',
  )),
  revisionSummary,
  revisionEvents,
  revisionSnapshot,
}))

vi.mock('@/services/cloud/cloud-storage', () => ({
  cloudStorage: { downloadChats, deleteChat },
}))

vi.mock('@/services/cloud/chat-ingestion', () => ({ ingestRemoteChats }))
vi.mock('@/services/storage/chat-events', () => ({
  chatEvents: { emit: emitChatEvent },
}))
vi.mock('@/services/storage/deleted-chats-tracker', () => ({
  deletedChatsTracker: { markAsRemoteDeleted, removeRemoteDeletion },
}))
function pendingChat(id: string): StoredChat {
  return {
    id,
    title: id,
    messages: [
      { role: 'user', content: 'Pending edit', timestamp: new Date(0) },
    ],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    lastAccessedAt: 0,
    locallyModified: true,
    pendingUpload: 1,
    syncUserId: 'user-1',
  }
}

describe('chat revision synchronization', () => {
  const userId = 'user-1'
  const adapter = {
    upload: vi.fn(),
    isStreaming: vi.fn<(id: string) => boolean>(() => false),
    waitForUpload: vi.fn<(id: string) => Promise<void>>(() =>
      Promise.resolve(),
    ),
  }

  beforeEach(() => {
    vi.resetAllMocks()
    getSyncState.mockResolvedValue({
      id: 'account',
      userId,
      appliedRevision: '7',
      bootstrapped: true,
    })
    hasPendingSyncWork.mockResolvedValue(false)
    revisionSummary.mockResolvedValue({
      current_revision: '7',
      oldest_replayable_revision: '1',
    })
    getPendingDeletes.mockResolvedValue([])
    getPendingUploadChats.mockResolvedValue([])
    applyRemoteDeletion.mockResolvedValue(true)
    commitRevisionBatch.mockResolvedValue(undefined)
    reconcileRevisionSnapshot.mockResolvedValue([])
    ingestRemoteChats.mockResolvedValue({
      savedIds: [],
      downloaded: 0,
      errors: [],
    })
    removeRemoteDeletion.mockReturnValue(false)
    adapter.upload.mockResolvedValue(undefined)
  })

  it('uses one summary request and stops when nothing changed', async () => {
    await expect(drainChatRevisionSync(adapter, userId)).resolves.toEqual({
      uploaded: 0,
      downloaded: 0,
      errors: [],
    })

    expect(revisionSummary).toHaveBeenCalledTimes(1)
    expect(revisionEvents).not.toHaveBeenCalled()
    expect(revisionSnapshot).not.toHaveBeenCalled()
    expect(getPendingUploadChats).not.toHaveBeenCalled()
  })

  it('does not send metadata-only rows through the revision uploader', async () => {
    hasPendingSyncWork.mockResolvedValue(true)
    getPendingUploadChats.mockResolvedValue([
      {
        id: 'metadata-only',
        messages: [],
        messageCount: 4,
        isMetadataOnly: true,
        pendingUpload: 1,
      },
    ])

    await drainChatRevisionSync(adapter, userId)

    expect(adapter.upload).not.toHaveBeenCalled()
  })

  it('applies ordered deletes and project moves before pending uploads', async () => {
    const order: string[] = []
    let finishCommit!: () => void
    const commit = new Promise<void>((resolve) => {
      finishCommit = resolve
    })
    hasPendingSyncWork.mockResolvedValue(true)
    revisionSummary.mockResolvedValue({
      current_revision: '9',
      oldest_replayable_revision: '1',
    })
    revisionEvents.mockResolvedValue({
      events: [
        {
          revision: '8',
          kind: 'delete',
          id: 'deleted-chat',
          project_id: null,
          updated_at: '2026-01-01T00:00:00Z',
        },
        {
          revision: '9',
          kind: 'upsert',
          id: 'moved-chat',
          etag: '3',
          key_id: 'key-1',
          project_id: 'project-2',
          updated_at: '2026-01-02T00:00:00Z',
        },
      ],
    })
    applyRemoteDeletion.mockImplementation(async () => {
      order.push('remote-delete')
      return true
    })
    getChat.mockResolvedValue({ id: 'moved-chat', syncVersion: 3 })
    commitRevisionBatch.mockImplementation(async () => {
      await commit
      order.push('checkpoint')
    })
    getPendingUploadChats.mockResolvedValue([pendingChat('local-chat')])
    adapter.upload.mockImplementation(async () => {
      order.push('upload')
    })

    const sync = drainChatRevisionSync(adapter, userId)
    await vi.waitFor(() => expect(commitRevisionBatch).toHaveBeenCalledOnce())
    expect(adapter.upload).not.toHaveBeenCalled()
    finishCommit()
    await sync

    expect(order).toEqual(['remote-delete', 'checkpoint', 'upload'])
    expect(markAsRemoteDeleted).toHaveBeenCalledWith('deleted-chat')
    expect(removeRemoteDeletion).toHaveBeenCalledWith('moved-chat')
    expect(commitRevisionBatch).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'moved-chat',
          projectId: 'project-2',
          revision: '9',
        }),
      ]),
      '9',
      userId,
    )
  })

  it('does not tombstone a remote delete before its transaction commits', async () => {
    revisionSummary.mockResolvedValue({
      current_revision: '8',
      oldest_replayable_revision: '1',
    })
    revisionEvents.mockResolvedValue({
      events: [
        {
          revision: '8',
          kind: 'delete',
          id: 'deleted-chat',
          project_id: null,
          updated_at: '2026-01-01T00:00:00Z',
        },
      ],
    })
    applyRemoteDeletion.mockRejectedValue(new Error('transaction failed'))

    await expect(drainChatRevisionSync(adapter, userId)).rejects.toThrow(
      'transaction failed',
    )

    expect(markAsRemoteDeleted).not.toHaveBeenCalled()
  })

  it.each([null, undefined])(
    'repairs an expired checkpoint with a metadata snapshot',
    async (missingLocal) => {
      getSyncState.mockResolvedValue({
        id: 'account',
        userId,
        appliedRevision: '2',
        bootstrapped: true,
      })
      revisionSummary.mockResolvedValue({
        current_revision: '12',
        oldest_replayable_revision: '5',
      })
      revisionSnapshot.mockResolvedValue({
        snapshot_revision: '12',
        items: [
          {
            id: 'remote-chat',
            etag: '4',
            key_id: 'key-1',
            project_id: null,
            updated_at: '2026-01-02T00:00:00Z',
          },
        ],
      })
      getChat.mockResolvedValue(missingLocal)
      downloadChats.mockResolvedValue([
        { status: 'ok', id: 'remote-chat', syncVersion: 4, content: '{}' },
      ])
      ingestRemoteChats.mockResolvedValue({
        savedIds: ['remote-chat'],
        downloaded: 1,
        errors: [],
      })

      const result = await drainChatRevisionSync(adapter, userId)

      expect(result.downloaded).toBe(1)
      expect(reconcileRevisionSnapshot).toHaveBeenCalledWith(
        [expect.objectContaining({ id: 'remote-chat', revision: '12' })],
        '12',
        userId,
      )
      expect(revisionEvents).not.toHaveBeenCalled()
    },
  )

  it('marks snapshot deletions and clears tombstones for remote rows', async () => {
    getSyncState.mockResolvedValue(null)
    revisionSummary.mockResolvedValue({
      current_revision: '12',
      oldest_replayable_revision: '1',
    })
    revisionSnapshot.mockResolvedValue({
      snapshot_revision: '12',
      items: [
        {
          id: 'restored-chat',
          etag: '4',
          key_id: 'key-1',
          project_id: null,
          updated_at: '2026-01-02T00:00:00Z',
        },
      ],
    })
    getChat.mockResolvedValue({ id: 'restored-chat', syncVersion: 4 })
    reconcileRevisionSnapshot.mockResolvedValue(['deleted-chat'])
    removeRemoteDeletion.mockImplementation(
      (id: string) => id === 'restored-chat',
    )

    await drainChatRevisionSync(adapter, userId)

    expect(markAsRemoteDeleted).toHaveBeenCalledWith('deleted-chat')
    expect(removeRemoteDeletion).toHaveBeenCalledWith('restored-chat')
    expect(emitChatEvent).toHaveBeenCalledWith({
      reason: 'sync',
      ids: ['restored-chat'],
    })
  })

  it('notifies once after committed replay upserts remove tombstones', async () => {
    let finishCommit!: () => void
    commitRevisionBatch.mockReturnValue(
      new Promise<void>((resolve) => {
        finishCommit = resolve
      }),
    )
    revisionSummary.mockResolvedValue({
      current_revision: '9',
      oldest_replayable_revision: '1',
    })
    revisionEvents.mockResolvedValue({
      events: [
        {
          revision: '8',
          kind: 'upsert',
          id: 'restored-chat',
          etag: '4',
          key_id: 'key-1',
          project_id: null,
          updated_at: '2026-01-02T00:00:00Z',
        },
        {
          revision: '9',
          kind: 'upsert',
          id: 'untombstoned-chat',
          etag: '2',
          key_id: 'key-1',
          project_id: null,
          updated_at: '2026-01-03T00:00:00Z',
        },
      ],
    })
    getChat.mockImplementation(async (id: string) => ({
      id,
      syncVersion: id === 'restored-chat' ? 4 : 2,
    }))
    removeRemoteDeletion.mockImplementation(
      (id: string) => id === 'restored-chat',
    )

    const sync = drainChatRevisionSync(adapter, userId)
    await vi.waitFor(() => expect(commitRevisionBatch).toHaveBeenCalledOnce())
    expect(removeRemoteDeletion).not.toHaveBeenCalled()
    expect(emitChatEvent).not.toHaveBeenCalled()
    finishCommit()
    await sync

    expect(emitChatEvent).toHaveBeenCalledTimes(1)
    expect(emitChatEvent).toHaveBeenCalledWith({
      reason: 'sync',
      ids: ['restored-chat'],
    })
  })

  it('does not notify when a later local delete keeps the tombstone', async () => {
    revisionSummary.mockResolvedValue({
      current_revision: '8',
      oldest_replayable_revision: '1',
    })
    revisionEvents.mockResolvedValue({
      events: [
        {
          revision: '8',
          kind: 'upsert',
          id: 'locally-deleted-chat',
          etag: '4',
          key_id: 'key-1',
          project_id: null,
          updated_at: '2026-01-02T00:00:00Z',
        },
      ],
    })
    getChat.mockResolvedValue({
      id: 'locally-deleted-chat',
      syncVersion: 4,
    })
    removeRemoteDeletion.mockReturnValue(false)

    await drainChatRevisionSync(adapter, userId)

    expect(removeRemoteDeletion).toHaveBeenCalledWith('locally-deleted-chat')
    expect(emitChatEvent).not.toHaveBeenCalled()
  })

  it('keeps a tombstone when a remote upsert has a pending local delete', async () => {
    revisionSummary.mockResolvedValue({
      current_revision: '8',
      oldest_replayable_revision: '1',
    })
    revisionEvents.mockResolvedValue({
      events: [
        {
          revision: '8',
          kind: 'upsert',
          id: 'deleted-chat',
          etag: '4',
          key_id: 'key-1',
          project_id: null,
          updated_at: '2026-01-02T00:00:00Z',
        },
      ],
    })
    getPendingDeletes.mockResolvedValue([
      { id: 'deleted-chat', userId, idempotencyKey: 'delete-key' },
    ])

    await drainChatRevisionSync(adapter, userId)

    expect(removeRemoteDeletion).not.toHaveBeenCalledWith('deleted-chat')
    expect(emitChatEvent).not.toHaveBeenCalled()
  })

  it('fails closed without uploads or checkpoint advancement', async () => {
    hasPendingSyncWork.mockResolvedValue(true)
    getPendingUploadChats.mockResolvedValue([pendingChat('must-not-upload')])
    revisionSummary.mockResolvedValue({
      current_revision: '8',
      oldest_replayable_revision: '1',
    })
    revisionEvents.mockRejectedValue(new Error('protocol unavailable'))

    await expect(drainChatRevisionSync(adapter, userId)).rejects.toThrow(
      'protocol unavailable',
    )
    expect(commitRevisionBatch).not.toHaveBeenCalled()
    expect(adapter.upload).not.toHaveBeenCalled()
  })

  it('repairs a checkpoint ahead of the server revision', async () => {
    getSyncState.mockResolvedValue({
      id: 'account',
      userId,
      appliedRevision: '20',
      bootstrapped: true,
    })
    revisionSummary.mockResolvedValue({
      current_revision: '10',
      oldest_replayable_revision: '1',
    })
    revisionSnapshot.mockResolvedValue({
      snapshot_revision: '10',
      items: [],
    })

    await drainChatRevisionSync(adapter, userId)

    expect(revisionSnapshot).toHaveBeenCalledTimes(1)
    expect(reconcileRevisionSnapshot).toHaveBeenCalledWith([], '10', userId)
  })

  it('pulls all stale clean local rows plus only recent missing rows', async () => {
    getSyncState.mockResolvedValue(null)
    revisionSummary.mockResolvedValue({
      current_revision: '60',
      oldest_replayable_revision: '1',
    })
    const missingItems = Array.from(
      { length: BOOTSTRAP_RECENT_CONTENT_LIMIT + 2 },
      (_, index) => ({
        id: `missing-${index}`,
        etag: '2',
        key_id: 'key-1',
        project_id: null,
        updated_at: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
      }),
    )
    const staleItem = {
      id: 'stale-existing',
      etag: '9',
      key_id: 'key-1',
      project_id: null,
      updated_at: '2025-01-01T00:00:00Z',
    }
    revisionSnapshot.mockResolvedValue({
      snapshot_revision: '60',
      items: [
        ...missingItems,
        staleItem,
        { ...staleItem, id: 'current-existing', etag: '1' },
        { ...staleItem, id: 'dirty-existing' },
      ],
    })
    getChat.mockImplementation(async (id: string) =>
      id.endsWith('existing')
        ? {
            id,
            syncVersion: 1,
            locallyModified: id === 'dirty-existing',
            syncedAt: Date.parse('2099-01-01T00:00:00Z'),
          }
        : null,
    )
    downloadChats.mockImplementation(async (ids: string[]) =>
      ids.map((id) => ({ status: 'ok', id, content: '{}', syncVersion: 2 })),
    )

    await drainChatRevisionSync(adapter, userId)

    const pulledIds = downloadChats.mock.calls.flatMap(([ids]) => ids)
    expect(pulledIds).toContain('stale-existing')
    expect(pulledIds.filter((id) => id.startsWith('missing-'))).toHaveLength(
      BOOTSTRAP_RECENT_CONTENT_LIMIT,
    )
    expect([...pulledIds].sort()).toEqual(
      [
        'stale-existing',
        ...Array.from({ length: 50 }, (_, index) => `missing-${index + 2}`),
      ].sort(),
    )
  })

  it('stores earlier bootstrap batches before a later batch fails', async () => {
    getSyncState.mockResolvedValue(null)
    revisionSummary.mockResolvedValue({
      current_revision: '60',
      oldest_replayable_revision: '1',
    })
    const batchSize = CLOUD_SYNC.PULL_BATCH_SIZE
    const items = Array.from({ length: batchSize + 1 }, (_, index) => ({
      id: `missing-${index}`,
      etag: '2',
      key_id: 'key-1',
      project_id: null,
      // Descending so the pull order matches the array order.
      updated_at: `2026-01-${String(31 - index).padStart(2, '0')}T00:00:00Z`,
    }))
    revisionSnapshot.mockResolvedValue({
      snapshot_revision: '60',
      items,
    })
    getChat.mockResolvedValue(null)
    downloadChats.mockImplementation(async (ids: string[]) => {
      if (ids.includes(items[batchSize].id)) {
        throw new Error('request timed out')
      }
      return ids.map((id) => ({
        status: 'ok',
        id,
        content: '{}',
        syncVersion: 2,
      }))
    })
    ingestRemoteChats.mockImplementation(async (chats: { id: string }[]) => ({
      savedIds: chats.map((chat) => chat.id),
      downloaded: chats.length,
      errors: [],
    }))

    await expect(drainChatRevisionSync(adapter, userId)).rejects.toThrow(
      'request timed out',
    )

    expect(downloadChats).toHaveBeenCalledTimes(2)
    expect(downloadChats.mock.calls[0][0]).toHaveLength(batchSize)
    expect(ingestRemoteChats).toHaveBeenCalledTimes(1)
    expect(
      ingestRemoteChats.mock.calls[0][0].map((c: { id: string }) => c.id),
    ).toEqual(items.slice(0, batchSize).map((item) => item.id))
    expect(reconcileRevisionSnapshot).not.toHaveBeenCalled()
  })

  it.each([false, true])(
    're-pulls failed-decryption rows only when local edits are absent',
    async (locallyModified) => {
      getSyncState.mockResolvedValue(null)
      revisionSummary.mockResolvedValue({
        current_revision: '10',
        oldest_replayable_revision: '1',
      })
      revisionSnapshot.mockResolvedValue({
        snapshot_revision: '10',
        items: [
          {
            id: 'failed-chat',
            etag: '4',
            key_id: 'key-1',
            project_id: null,
            updated_at: '2026-01-01T00:00:00Z',
          },
        ],
      })
      getChat.mockResolvedValue({
        id: 'failed-chat',
        syncVersion: 4,
        decryptionFailed: true,
        locallyModified,
      })
      downloadChats.mockResolvedValue([
        { status: 'ok', id: 'failed-chat', content: '{}', syncVersion: 4 },
      ])

      await drainChatRevisionSync(adapter, userId)

      if (locallyModified) {
        expect(downloadChats).not.toHaveBeenCalled()
        expect(ingestRemoteChats).not.toHaveBeenCalled()
      } else {
        expect(downloadChats).toHaveBeenCalledWith(['failed-chat'])
      }
    },
  )

  it('refuses to advance the checkpoint past a row it cannot read', async () => {
    getSyncState.mockResolvedValue(null)
    revisionSummary.mockResolvedValue({
      current_revision: '10',
      oldest_replayable_revision: '1',
    })
    revisionSnapshot.mockResolvedValue({
      snapshot_revision: '10',
      items: [
        {
          id: 'locked-chat',
          etag: '4',
          key_id: 'other-key',
          project_id: null,
          updated_at: '2026-01-01T00:00:00Z',
        },
      ],
    })
    getChat.mockResolvedValue(null)
    downloadChats.mockResolvedValue([
      { status: 'unavailable', id: 'locked-chat', code: 'UNKNOWN_KEY' },
    ])

    await expect(drainChatRevisionSync(adapter, userId)).rejects.toThrow(
      'UNKNOWN_KEY',
    )
    expect(ingestRemoteChats).not.toHaveBeenCalled()
    expect(reconcileRevisionSnapshot).not.toHaveBeenCalled()
  })

  it('does not pull content for a dirty event row', async () => {
    revisionSummary.mockResolvedValue({
      current_revision: '8',
      oldest_replayable_revision: '1',
    })
    revisionEvents.mockResolvedValue({
      events: [
        {
          revision: '8',
          kind: 'upsert',
          id: 'dirty-chat',
          etag: '5',
          key_id: 'key-1',
          project_id: 'remote-project',
          updated_at: '2026-01-01T00:00:00Z',
        },
      ],
    })
    getChat.mockResolvedValue({
      id: 'dirty-chat',
      syncVersion: 2,
      projectId: 'local-project',
      locallyModified: true,
    })

    await drainChatRevisionSync(adapter, userId)

    expect(downloadChats).not.toHaveBeenCalled()
    expect(commitRevisionBatch).toHaveBeenCalledWith(
      [expect.objectContaining({ id: 'dirty-chat', etag: '5' })],
      '8',
      userId,
    )
  })

  it('advances through a missing upsert when a later delete confirms absence', async () => {
    revisionSummary.mockResolvedValue({
      current_revision: '9',
      oldest_replayable_revision: '1',
    })
    revisionEvents.mockResolvedValue({
      events: [
        {
          revision: '8',
          kind: 'upsert',
          id: 'gone-chat',
          etag: '2',
          key_id: 'key-1',
          project_id: null,
          updated_at: '2026-01-01T00:00:00Z',
        },
        {
          revision: '9',
          kind: 'delete',
          id: 'gone-chat',
          project_id: null,
          updated_at: '2026-01-02T00:00:00Z',
        },
      ],
    })
    getChat.mockResolvedValue(null)
    downloadChats.mockResolvedValue([
      { status: 'unavailable', id: 'gone-chat', code: 'NOT_FOUND' },
    ])

    await drainChatRevisionSync(adapter, userId)

    expect(downloadChats).toHaveBeenCalledWith(['gone-chat'])
    expect(applyRemoteDeletion).toHaveBeenCalledWith(
      'gone-chat',
      userId,
      expect.any(Function),
    )
    expect(commitRevisionBatch).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ id: 'gone-chat', kind: 'delete' }),
      ]),
      '9',
      userId,
    )
  })

  it('retries a durable delete with its original idempotency key', async () => {
    hasPendingSyncWork.mockResolvedValue(true)
    getPendingDeletes.mockResolvedValue([
      {
        id: 'deleted-chat',
        userId,
        idempotencyKey: 'stable-delete-key',
      },
    ])
    deleteChat
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce(undefined)

    const failed = await drainChatRevisionSync(adapter, userId)
    expect(failed.errors).toEqual([
      expect.stringContaining('temporary failure'),
    ])
    expect(acknowledgePendingDelete).not.toHaveBeenCalled()

    await drainChatRevisionSync(adapter, userId)

    expect(deleteChat).toHaveBeenNthCalledWith(
      1,
      'deleted-chat',
      'stable-delete-key',
    )
    expect(deleteChat).toHaveBeenNthCalledWith(
      2,
      'deleted-chat',
      'stable-delete-key',
    )
    expect(acknowledgePendingDelete).toHaveBeenCalledWith(
      'deleted-chat',
      userId,
    )
  })

  it('settles in-flight uploads before issuing a durable delete', async () => {
    const order: string[] = []
    let finishUpload!: () => void
    const upload = new Promise<void>((resolve) => {
      finishUpload = resolve
    })
    hasPendingSyncWork.mockResolvedValue(true)
    getPendingDeletes.mockResolvedValue([
      { id: 'racing-chat', userId, idempotencyKey: 'delete-key' },
    ])
    adapter.waitForUpload.mockImplementation(async () => {
      order.push('wait-upload')
      await upload
    })
    deleteChat.mockImplementation(async () => {
      order.push('delete')
    })

    const sync = drainChatRevisionSync(adapter, userId)
    await vi.waitFor(() => expect(adapter.waitForUpload).toHaveBeenCalledOnce())
    expect(deleteChat).not.toHaveBeenCalled()
    finishUpload()
    await sync

    expect(adapter.waitForUpload).toHaveBeenCalledWith('racing-chat')
    expect(order).toEqual(['wait-upload', 'delete'])
  })

  it('keeps uploading when one durable delete fails', async () => {
    hasPendingSyncWork.mockResolvedValue(true)
    getPendingDeletes.mockResolvedValue([
      { id: 'poison-chat', userId, idempotencyKey: 'poison-key' },
      { id: 'healthy-chat', userId, idempotencyKey: 'healthy-key' },
    ])
    deleteChat
      .mockRejectedValueOnce(new Error('row is wedged'))
      .mockResolvedValueOnce(undefined)
    getPendingUploadChats.mockResolvedValue([pendingChat('dirty-chat')])

    const result = await drainChatRevisionSync(adapter, userId)

    expect(deleteChat).toHaveBeenCalledTimes(2)
    expect(acknowledgePendingDelete).toHaveBeenCalledTimes(1)
    expect(acknowledgePendingDelete).toHaveBeenCalledWith(
      'healthy-chat',
      userId,
    )
    expect(adapter.upload).toHaveBeenCalledWith(pendingChat('dirty-chat'))
    expect(result.uploaded).toBe(1)
    expect(result.errors).toEqual([expect.stringContaining('poison-chat')])
  })

  it('keeps uploading when one chat upload fails terminally', async () => {
    hasPendingSyncWork.mockResolvedValue(true)
    getPendingUploadChats.mockResolvedValue([
      pendingChat('failing-chat'),
      pendingChat('healthy-chat'),
    ])
    adapter.upload
      .mockRejectedValueOnce(new Error('upload exploded'))
      .mockResolvedValueOnce(undefined)

    const result = await drainChatRevisionSync(adapter, userId)

    expect(adapter.upload).toHaveBeenCalledTimes(2)
    expect(result.uploaded).toBe(1)
    expect(result.errors).toEqual([expect.stringContaining('failing-chat')])
  })

  it('aborts before commits and uploads when the account changes', async () => {
    hasPendingSyncWork.mockResolvedValue(true)
    revisionEvents.mockResolvedValue({
      events: [
        {
          revision: '8',
          kind: 'delete',
          id: 'deleted-chat',
          project_id: null,
          updated_at: '2026-01-01T00:00:00Z',
        },
      ],
    })
    getPendingUploadChats.mockResolvedValue([pendingChat('local-chat')])
    // Summary succeeds, then the account switches before events apply.
    let current = true
    revisionSummary.mockImplementation(async () => {
      current = false
      return { current_revision: '9', oldest_replayable_revision: '1' }
    })

    await expect(
      drainChatRevisionSync(adapter, userId, () => current),
    ).rejects.toThrow('Cloud account changed during synchronization')
    expect(commitRevisionBatch).not.toHaveBeenCalled()
    expect(adapter.upload).not.toHaveBeenCalled()
  })

  it('skips streaming chats and counts only completed uploads', async () => {
    hasPendingSyncWork.mockResolvedValue(true)
    getPendingUploadChats.mockResolvedValue([
      pendingChat('streaming-chat'),
      pendingChat('ready-chat'),
    ])
    adapter.isStreaming.mockImplementation((id) => id === 'streaming-chat')

    const result = await drainChatRevisionSync(adapter, userId)

    expect(adapter.upload).toHaveBeenCalledTimes(1)
    expect(adapter.upload).toHaveBeenCalledWith(pendingChat('ready-chat'))
    expect(result.uploaded).toBe(1)
  })
})
