import type { BackupPullResult } from '@/services/cloud/backup-read-error'
import type { NativeBackupCollectionDependencies } from '@/services/native-backup'
import { collectNativeBackupV1 } from '@/services/native-backup'
import { CLOUD_PULL_BATCH_SIZE } from '@/services/native-backup/collect'
import type { StoredChat } from '@/services/storage/indexed-db'

const timestamp = '2026-08-20T12:00:00.000Z'

function batchOf<T>(
  requests: readonly unknown[],
  value: T,
): BackupPullResult<T>[] {
  return requests.map(() => ({ ok: true, value }))
}

function dependencies(
  overrides: Partial<NativeBackupCollectionDependencies> = {},
): NativeBackupCollectionDependencies {
  return {
    isAuthenticated: async () => true,
    activeUserId: () => 'user',
    requireUnlockedCek: () => {},
    getCloudInventory: async () => ({
      captured_at: timestamp,
      total_items: 0,
      items: [],
    }),
    getCloudChats: async (requests) => batchOf(requests, null),
    getCloudImage: async () => null,
    getProjects: async (requests) => batchOf(requests, null),
    getDocuments: async (requests) => batchOf(requests, null),
    getLocalChats: async () => [],
    getLocalChat: async () => null,
    ...overrides,
  }
}

function cloudChat(): StoredChat {
  return {
    id: 'chat',
    title: 'Chat',
    messages: [
      {
        role: 'user',
        content: 'image',
        timestamp: new Date(timestamp),
        attachments: Array.from({ length: 6 }, (_, index) => ({
          id: `image-${index}`,
          type: 'image' as const,
          fileName: `image-${index}.png`,
          encryptionKey: 'key',
        })),
      },
    ],
    createdAt: timestamp,
    updatedAt: timestamp,
    lastAccessedAt: 0,
    syncVersion: 1,
  }
}

describe('native backup collection cancellation', () => {
  it('does not start collection for an already-aborted signal', async () => {
    const controller = new AbortController()
    const reason = new DOMException('Canceled', 'AbortError')
    const isAuthenticated = vi.fn().mockResolvedValue(true)
    controller.abort(reason)

    await expect(
      collectNativeBackupV1(
        dependencies({ isAuthenticated }),
        controller.signal,
      ),
    ).rejects.toBe(reason)
    expect(isAuthenticated).not.toHaveBeenCalled()
  })

  it('stops immediately when the one-shot inventory request aborts', async () => {
    const controller = new AbortController()
    const reason = new DOMException('Canceled', 'AbortError')
    const getCloudChats = vi.fn()
    const getCloudInventory = vi.fn().mockImplementation(async () => {
      controller.abort(reason)
      return { captured_at: timestamp, total_items: 0, items: [] }
    })

    await expect(
      collectNativeBackupV1(
        dependencies({ getCloudInventory, getCloudChats }),
        controller.signal,
      ),
    ).rejects.toBe(reason)
    expect(getCloudInventory).toHaveBeenCalledTimes(1)
    expect(getCloudChats).not.toHaveBeenCalled()
  })

  it('does not process later project batches after a batch read aborts', async () => {
    const controller = new AbortController()
    const reason = new DOMException('Canceled', 'AbortError')
    const getProjects = vi
      .fn()
      .mockImplementation(async (requests: readonly unknown[]) => {
        controller.abort(reason)
        return batchOf(requests, null)
      })
    // More projects than one pull batch so a second batch would be
    // fetched if the abort were ignored.
    const projects = Array.from(
      { length: CLOUD_PULL_BATCH_SIZE + 10 },
      (_, index) => ({
        id: `project-${index}`,
        scope: 'project' as const,
        etag: 'etag',
        created_at: timestamp,
        updated_at: timestamp,
      }),
    )

    await expect(
      collectNativeBackupV1(
        dependencies({
          getCloudInventory: async () => ({
            captured_at: timestamp,
            total_items: projects.length,
            items: projects,
          }),
          getProjects,
        }),
        controller.signal,
      ),
    ).rejects.toBe(reason)
    expect(getProjects).toHaveBeenCalledTimes(1)
    expect(
      getProjects.mock.calls[0][0].map(({ id }: { id: string }) => id),
    ).toEqual(projects.slice(0, CLOUD_PULL_BATCH_SIZE).map(({ id }) => id))
  })

  it('stops image reads and never returns partial input after abort', async () => {
    const controller = new AbortController()
    const reason = new DOMException('Canceled', 'AbortError')
    const chat = cloudChat()
    const getCloudImage = vi.fn().mockImplementation(async () => {
      controller.abort(reason)
      return new Uint8Array([1])
    })
    const getCloudChats = vi
      .fn()
      .mockImplementation(async (requests: readonly unknown[]) =>
        batchOf(requests, chat),
      )

    await expect(
      collectNativeBackupV1(
        dependencies({
          getCloudInventory: async () => ({
            captured_at: timestamp,
            total_items: 1,
            items: [
              {
                scope: 'chat',
                id: chat.id,
                etag: 'etag',
                created_at: timestamp,
                updated_at: timestamp,
              },
            ],
          }),
          getCloudChats,
          getCloudImage,
        }),
        controller.signal,
      ),
    ).rejects.toBe(reason)
    expect(getCloudImage).toHaveBeenCalledTimes(1)
    expect(getCloudChats).toHaveBeenCalledTimes(1)
  })
})
