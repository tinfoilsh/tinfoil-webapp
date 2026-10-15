import { CLOUD_SYNC } from '@/config'
import {
  AUTH_ACTIVE_USER_ID,
  SETTINGS_CLOUD_SYNC_ENABLED,
  SYNC_CHAT_DELETION_REVISION,
} from '@/constants/storage-keys'
import { BOOTSTRAP_RECENT_CONTENT_LIMIT } from '@/services/cloud/chat-revision-sync'
import { cloudStorage } from '@/services/cloud/cloud-storage'
import { CloudSyncService } from '@/services/cloud/cloud-sync'
import {
  getSyncHealthSnapshot,
  resetSyncHealth,
} from '@/services/cloud/sync-health'
import {
  chatEvents,
  type ChatChangedEvent,
} from '@/services/storage/chat-events'
import { DB_NAME, indexedDBStorage } from '@/services/storage/indexed-db'
import {
  bytesToBase64,
  deleteRow,
  listStatus,
  pull,
  revisionEvents,
  revisionSnapshot,
  revisionSummary,
  type PullItem,
} from '@/services/sync-enclave/sync-api'
import { SyncNetworkError } from '@/services/sync-enclave/sync-enclave-client'
import { logError } from '@/utils/error-handling'
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/services/cloud/cek-encoding', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/cloud/cek-encoding')>()),
  hasPrimaryKey: () => false,
  pullKey: () => [{ key: 'test-key' }],
  requirePrimaryKeyB64: () => 'test-key',
}))
vi.mock('@/services/sync-enclave/sync-api', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@/services/sync-enclave/sync-api')
  >()),
  deleteRow: vi.fn(),
  listStatus: vi.fn(),
  pull: vi.fn(),
  revisionEvents: vi.fn(),
  revisionSnapshot: vi.fn(),
  revisionSummary: vi.fn(),
}))
vi.mock('@/utils/error-handling', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarning: vi.fn(),
}))

const USER_ID = 'user-1'
const PROJECT_ID = 'project-1'
const REVISION = '7'

interface ServerChat {
  id: string
  etag: string
  projectId: string | null
  updatedAt: string
  /** Pull outcome code when the enclave cannot return this chat. */
  unavailableCode?: string
  /** Raw plaintext overriding the default valid chat body. */
  plaintext?: string
}

let serverChats: ServerChat[]
let lockHeld: boolean
let listedWhileLocked: boolean[]
let events: ChatChangedEvent[]
let unsubscribeEvents: () => void
let originalLocks: PropertyDescriptor | undefined
let originalIndexedDB: PropertyDescriptor | undefined

function chatPlaintext(chat: ServerChat): string {
  return (
    chat.plaintext ??
    JSON.stringify({
      title: `Title ${chat.id}`,
      // Stale plaintext membership: the server's project_id must win.
      projectId: null,
      messages: [{ role: 'user', content: `Body of ${chat.id}` }],
    })
  )
}

function pullItem(id: string): PullItem {
  const chat = serverChats.find((candidate) => candidate.id === id)
  if (!chat) return { id, ok: false, code: 'NOT_FOUND' }
  if (chat.unavailableCode) {
    return { id, ok: false, code: chat.unavailableCode }
  }
  return {
    id,
    ok: true,
    etag: chat.etag,
    plaintext: bytesToBase64(new TextEncoder().encode(chatPlaintext(chat))),
  }
}

function serverRow(chat: ServerChat) {
  return {
    id: chat.id,
    etag: chat.etag,
    key_id: 'key-1',
    project_id: chat.projectId,
    updated_at: chat.updatedAt,
  }
}

function pulledIds(): string[][] {
  return vi.mocked(pull).mock.calls.map(([request]) => request.ids ?? [])
}

async function projectChatIds(): Promise<string[]> {
  return (await indexedDBStorage.getAllChats())
    .filter((chat) => chat.projectId === PROJECT_ID)
    .map((chat) => chat.id)
    .sort()
}

/** Mark the account as already bootstrapped and current with the server. */
async function seedCurrentCheckpoint(): Promise<void> {
  await indexedDBStorage.commitRevisionBatch([], REVISION, USER_ID)
}

/** Store a chat the way a previous sync would have. */
async function seedSyncedChat(
  id: string,
  syncVersion: number,
  projectId: string,
): Promise<void> {
  const applied = await indexedDBStorage.applyRemoteChatIfFresh({
    chat: {
      id,
      title: `Local ${id}`,
      messages: [],
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
      projectId,
    },
    syncVersion,
    expectedLocalUpdatedAt: null,
    userId: USER_ID,
  })
  expect(applied).toEqual({ applied: true })
}

describe('project chat synchronization', () => {
  beforeEach(async () => {
    vi.resetAllMocks()
    resetSyncHealth()
    originalIndexedDB = Object.getOwnPropertyDescriptor(window, 'indexedDB')
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
    localStorage.setItem(AUTH_ACTIVE_USER_ID, USER_ID)
    localStorage.setItem(SETTINGS_CLOUD_SYNC_ENABLED, 'true')
    vi.spyOn(cloudStorage, 'isAuthenticated').mockResolvedValue(true)

    lockHeld = false
    listedWhileLocked = []
    originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks')
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: {
        request: async (
          _name: string,
          _options: LockOptions,
          callback: () => Promise<unknown>,
        ) => {
          lockHeld = true
          try {
            return await callback()
          } finally {
            lockHeld = false
          }
        },
      },
    })

    serverChats = []
    vi.mocked(revisionSummary).mockResolvedValue({
      current_revision: REVISION,
      oldest_replayable_revision: '1',
    })
    vi.mocked(revisionSnapshot).mockImplementation(async () => ({
      snapshot_revision: REVISION,
      items: serverChats.map(serverRow),
    }))
    vi.mocked(revisionEvents).mockResolvedValue({ events: [] })
    vi.mocked(listStatus).mockImplementation(async (request) => {
      listedWhileLocked.push(lockHeld)
      return {
        updates: serverChats
          .filter(
            (chat) =>
              request.scope === 'chat' && chat.projectId === request.projectId,
          )
          .map(serverRow),
        deletes: [],
      }
    })
    vi.mocked(pull).mockImplementation(async (request) => ({
      items: (request.ids ?? []).map(pullItem),
    }))
    vi.mocked(deleteRow).mockResolvedValue({ ok: true })

    events = []
    unsubscribeEvents = chatEvents.on((event) => events.push(event))
  })

  afterEach(() => {
    unsubscribeEvents()
    if (originalLocks) {
      Object.defineProperty(navigator, 'locks', originalLocks)
    } else {
      delete (navigator as { locks?: LockManager }).locks
    }
    if (originalIndexedDB) {
      Object.defineProperty(window, 'indexedDB', originalIndexedDB)
    } else {
      delete (window as { indexedDB?: IDBFactory }).indexedDB
    }
    resetSyncHealth()
    sessionStorage.clear()
    vi.restoreAllMocks()
  })

  it('stores old project chats that the recent-chat bootstrap leaves out', async () => {
    serverChats = [
      ...Array.from({ length: BOOTSTRAP_RECENT_CONTENT_LIMIT }, (_, index) => ({
        id: `recent-${index}`,
        etag: '1',
        projectId: null,
        updatedAt: new Date(Date.UTC(2026, 1, 1, index)).toISOString(),
      })),
      {
        id: 'old-project-chat',
        etag: '3',
        projectId: PROJECT_ID,
        updatedAt: '2025-06-01T00:00:00.000Z',
      },
    ]

    const result = await new CloudSyncService().smartSync(PROJECT_ID)

    const bootstrapPulls = pulledIds().slice(0, -1)
    expect(bootstrapPulls.flat()).toHaveLength(BOOTSTRAP_RECENT_CONTENT_LIMIT)
    expect(bootstrapPulls.flat()).not.toContain('old-project-chat')
    expect(pulledIds().at(-1)).toEqual(['old-project-chat'])
    expect(vi.mocked(listStatus)).toHaveBeenCalledExactlyOnceWith({
      scope: 'chat',
      projectId: PROJECT_ID,
      cursor: undefined,
      limit: 500,
    })
    expect(listedWhileLocked).toEqual([true])
    expect(result).toEqual({
      uploaded: 0,
      downloaded: BOOTSTRAP_RECENT_CONTENT_LIMIT + 1,
      errors: [],
    })
    expect(await indexedDBStorage.getChat('old-project-chat')).toMatchObject({
      id: 'old-project-chat',
      title: 'Title old-project-chat',
      messages: [{ role: 'user', content: 'Body of old-project-chat' }],
      projectId: PROJECT_ID,
      syncVersion: 3,
      updatedAt: '2025-06-01T00:00:00.000Z',
      syncUserId: USER_ID,
      locallyModified: false,
      pendingUpload: 0,
    })
    expect(await projectChatIds()).toEqual(['old-project-chat'])
    expect(events).toContainEqual({
      reason: 'sync',
      ids: ['old-project-chat'],
    })
  })

  it('pulls only project chats that have no local row', async () => {
    await seedCurrentCheckpoint()
    await seedSyncedChat('local-chat', 2, PROJECT_ID)
    serverChats = [
      {
        id: 'local-chat',
        etag: '5',
        projectId: PROJECT_ID,
        updatedAt: '2025-03-01T00:00:00.000Z',
      },
      {
        id: 'missing-chat',
        etag: '4',
        projectId: PROJECT_ID,
        updatedAt: '2025-02-01T00:00:00.000Z',
      },
      {
        id: 'other-project-chat',
        etag: '1',
        projectId: 'project-2',
        updatedAt: '2025-02-01T00:00:00.000Z',
      },
    ]

    const result = await new CloudSyncService().smartSync(PROJECT_ID)

    expect(pulledIds()).toEqual([['missing-chat']])
    expect(result).toEqual({ uploaded: 0, downloaded: 1, errors: [] })
    expect(localStorage.getItem(SYNC_CHAT_DELETION_REVISION)).not.toBeNull()
    expect(events).toEqual([{ reason: 'sync', ids: ['missing-chat'] }])
    expect(await indexedDBStorage.getChat('local-chat')).toMatchObject({
      title: 'Local local-chat',
      syncVersion: 2,
    })
    expect(await indexedDBStorage.getChat('missing-chat')).toMatchObject({
      projectId: PROJECT_ID,
      syncVersion: 4,
    })
    expect(await indexedDBStorage.getChat('other-project-chat')).toBeNull()
  })

  it('does not bring back a project chat with a pending local delete', async () => {
    await seedCurrentCheckpoint()
    await seedSyncedChat('deleted-chat', 1, PROJECT_ID)
    await expect(
      indexedDBStorage.deleteChatWithPendingIntent(
        'deleted-chat',
        'delete-key',
        USER_ID,
      ),
    ).resolves.toBe(true)
    // The delete has not reached the server yet, so it still lists the chat.
    vi.mocked(deleteRow).mockRejectedValue(new SyncNetworkError())
    serverChats = [
      {
        id: 'deleted-chat',
        etag: '1',
        projectId: PROJECT_ID,
        updatedAt: '2025-03-01T00:00:00.000Z',
      },
      {
        id: 'kept-chat',
        etag: '2',
        projectId: PROJECT_ID,
        updatedAt: '2025-02-01T00:00:00.000Z',
      },
    ]

    const result = await new CloudSyncService().smartSync(PROJECT_ID)

    expect(vi.mocked(deleteRow)).toHaveBeenCalledOnce()
    expect(pulledIds()).toEqual([['kept-chat']])
    expect(result.downloaded).toBe(1)
    expect(await indexedDBStorage.getChat('deleted-chat')).toBeNull()
    expect(
      (await indexedDBStorage.getPendingDeletes(USER_ID)).map(
        (entry) => entry.id,
      ),
    ).toEqual(['deleted-chat'])
    expect(await projectChatIds()).toEqual(['kept-chat'])
  })

  it('stores readable project chats when others cannot be returned', async () => {
    await seedCurrentCheckpoint()
    serverChats = [
      {
        id: 'locked-chat',
        etag: '2',
        projectId: PROJECT_ID,
        updatedAt: '2025-01-01T00:00:00.000Z',
        unavailableCode: 'UNKNOWN_KEY',
      },
      {
        id: 'vanished-chat',
        etag: '2',
        projectId: PROJECT_ID,
        updatedAt: '2025-01-02T00:00:00.000Z',
        unavailableCode: 'NOT_FOUND',
      },
      {
        id: 'readable-chat',
        etag: '3',
        projectId: PROJECT_ID,
        updatedAt: '2025-01-03T00:00:00.000Z',
      },
    ]

    const result = await new CloudSyncService().smartSync(PROJECT_ID)

    expect(pulledIds()).toEqual([
      ['locked-chat', 'vanished-chat', 'readable-chat'],
    ])
    expect(result).toEqual({ uploaded: 0, downloaded: 1, errors: [] })
    expect(await projectChatIds()).toEqual(['readable-chat'])
    expect(getSyncHealthSnapshot().gate).toMatchObject({
      kind: 'action-required',
      reason: 'key-recovery',
    })
    expect(getSyncHealthSnapshot().failedChats).toEqual({})
  })

  it('stores readable project chats when another one cannot be decoded', async () => {
    await seedCurrentCheckpoint()
    serverChats = [
      {
        id: 'corrupt-chat',
        etag: '2',
        projectId: PROJECT_ID,
        updatedAt: '2025-01-01T00:00:00.000Z',
        plaintext: '{not json',
      },
      {
        id: 'readable-chat',
        etag: '3',
        projectId: PROJECT_ID,
        updatedAt: '2025-01-02T00:00:00.000Z',
      },
    ]

    const result = await new CloudSyncService().smartSync(PROJECT_ID)

    expect(result).toEqual({ uploaded: 0, downloaded: 1, errors: [] })
    expect(await projectChatIds()).toEqual(['readable-chat'])
    expect(getSyncHealthSnapshot().failedChats).toEqual({
      'corrupt-chat': "This chat couldn't be read",
    })
  })

  it('pulls every batch of a large project', async () => {
    await seedCurrentCheckpoint()
    const ids = Array.from(
      { length: CLOUD_SYNC.PULL_BATCH_SIZE + 1 },
      (_, index) => `project-chat-${String(index).padStart(2, '0')}`,
    )
    serverChats = ids.map((id, index) => ({
      id,
      etag: '1',
      projectId: PROJECT_ID,
      updatedAt: new Date(Date.UTC(2025, 0, 1, index)).toISOString(),
    }))

    const result = await new CloudSyncService().smartSync(PROJECT_ID)

    expect(pulledIds()).toEqual([
      ids.slice(0, CLOUD_SYNC.PULL_BATCH_SIZE),
      ids.slice(CLOUD_SYNC.PULL_BATCH_SIZE),
    ])
    expect(result.downloaded).toBe(ids.length)
    expect(await projectChatIds()).toEqual(ids)
  })

  it('keeps the sync result when listing the project fails', async () => {
    await seedCurrentCheckpoint()
    const failure = new SyncNetworkError()
    vi.mocked(listStatus).mockRejectedValue(failure)

    await expect(new CloudSyncService().smartSync(PROJECT_ID)).resolves.toEqual(
      { uploaded: 0, downloaded: 0, errors: [] },
    )

    expect(vi.mocked(pull)).not.toHaveBeenCalled()
    expect(vi.mocked(logError)).toHaveBeenCalledWith(
      'Failed to load missing project chats',
      failure,
      expect.objectContaining({ metadata: { projectId: PROJECT_ID } }),
    )
  })

  it('stops without storing when the account changes during listing', async () => {
    await seedCurrentCheckpoint()
    serverChats = [
      {
        id: 'project-chat',
        etag: '1',
        projectId: PROJECT_ID,
        updatedAt: '2025-01-01T00:00:00.000Z',
      },
    ]
    vi.mocked(listStatus).mockImplementationOnce(async () => {
      localStorage.setItem(AUTH_ACTIVE_USER_ID, 'user-2')
      return { updates: serverChats.map(serverRow), deletes: [] }
    })

    await expect(new CloudSyncService().smartSync(PROJECT_ID)).rejects.toThrow(
      'Cloud account changed during synchronization',
    )

    expect(vi.mocked(pull)).not.toHaveBeenCalled()
    expect(await indexedDBStorage.getChat('project-chat')).toBeNull()
  })

  it('stops without reporting when the account changes while storing', async () => {
    await seedCurrentCheckpoint()
    serverChats = [
      {
        id: 'locked-chat',
        etag: '2',
        projectId: PROJECT_ID,
        updatedAt: '2025-01-01T00:00:00.000Z',
        unavailableCode: 'UNKNOWN_KEY',
      },
      {
        id: 'readable-chat',
        etag: '3',
        projectId: PROJECT_ID,
        updatedAt: '2025-01-02T00:00:00.000Z',
      },
    ]
    const getChat = indexedDBStorage.getChat.bind(indexedDBStorage)
    const spy = vi
      .spyOn(indexedDBStorage, 'getChat')
      .mockImplementation(async (id) => {
        if (id === 'readable-chat') {
          localStorage.setItem(AUTH_ACTIVE_USER_ID, 'user-2')
        }
        return getChat(id)
      })

    try {
      await expect(
        new CloudSyncService().smartSync(PROJECT_ID),
      ).rejects.toThrow('Cloud account changed during synchronization')
    } finally {
      spy.mockRestore()
    }

    expect(pulledIds()).toEqual([['locked-chat', 'readable-chat']])
    expect(await indexedDBStorage.getChat('readable-chat')).toBeNull()
    expect(getSyncHealthSnapshot().gate).not.toMatchObject({
      reason: 'key-recovery',
    })
  })

  it('does not list project chats for an account-wide sync', async () => {
    await seedCurrentCheckpoint()
    serverChats = [
      {
        id: 'project-chat',
        etag: '1',
        projectId: PROJECT_ID,
        updatedAt: '2025-01-01T00:00:00.000Z',
      },
    ]

    await expect(new CloudSyncService().smartSync()).resolves.toEqual({
      uploaded: 0,
      downloaded: 0,
      errors: [],
    })

    expect(vi.mocked(revisionSummary)).toHaveBeenCalledOnce()
    expect(vi.mocked(listStatus)).not.toHaveBeenCalled()
    expect(vi.mocked(pull)).not.toHaveBeenCalled()
  })
})
