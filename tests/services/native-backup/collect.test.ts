import type { Attachment } from '@/components/chat/types'
import { AuthTokenUnavailableError } from '@/services/auth'
import type { BackupPullResult } from '@/services/cloud/backup-read-error'
import { CloudBackupReadError } from '@/services/cloud/cloud-storage'
import {
  NativeBackupCollectionError,
  collectNativeBackupV2,
  formatNativeBackupV2,
  type NativeBackupCollectionDependencies,
} from '@/services/native-backup'
import { CLOUD_PULL_BATCH_SIZE } from '@/services/native-backup/collect'
import type { StoredChat } from '@/services/storage/indexed-db'
import type {
  BackupInventoryItem,
  BackupInventoryResponse,
} from '@/services/sync-enclave/sync-api'
import { SyncNetworkError } from '@/services/sync-enclave/sync-enclave-client'
import type { Project, ProjectDocument } from '@/types/project'

async function settle<T>(read: () => Promise<T>): Promise<BackupPullResult<T>> {
  try {
    return { ok: true, value: await read() }
  } catch (error) {
    return { ok: false, error }
  }
}

function batchReads<T>(fn: (id: string, expectedEtag: string) => Promise<T>) {
  return (requests: ReadonlyArray<{ id: string; expectedEtag: string }>) =>
    Promise.all(
      requests.map(({ id, expectedEtag }) =>
        settle(() => fn(id, expectedEtag)),
      ),
    )
}

function batchDocumentReads<T>(
  fn: (projectId: string, id: string, expectedEtag: string) => Promise<T>,
) {
  return (
    requests: ReadonlyArray<{
      projectId: string
      id: string
      expectedEtag: string
    }>,
  ) =>
    Promise.all(
      requests.map(({ projectId, id, expectedEtag }) =>
        settle(() => fn(projectId, id, expectedEtag)),
      ),
    )
}

const timestamp = '2026-08-20T12:00:00.000Z'
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])

function chat(overrides: Partial<StoredChat> = {}): StoredChat {
  return {
    id: 'chat',
    title: 'Chat',
    messages: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    lastAccessedAt: 0,
    syncVersion: 1,
    ...overrides,
  }
}

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'project',
    name: 'Project',
    description: '',
    systemInstructions: 'Be concise',
    color: 'blue',
    memory: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    syncVersion: 1,
    ...overrides,
  }
}

function document(overrides: Partial<ProjectDocument> = {}): ProjectDocument {
  return {
    id: 'document',
    projectId: 'project',
    filename: 'notes.txt',
    contentType: 'text/plain',
    sizeBytes: 4,
    syncVersion: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    content: 'text',
    ...overrides,
  }
}

function item(
  scope: BackupInventoryItem['scope'],
  id: string,
  etag: string,
  projectId?: string,
): BackupInventoryItem {
  return {
    scope,
    id,
    etag,
    ...(projectId ? { project_id: projectId } : {}),
    created_at: timestamp,
    updated_at: timestamp,
  }
}

function inventory(items: BackupInventoryItem[] = []): BackupInventoryResponse {
  return { captured_at: timestamp, total_items: items.length, items }
}

function dependencies(
  overrides: Partial<NativeBackupCollectionDependencies> = {},
): NativeBackupCollectionDependencies {
  return {
    isAuthenticated: async () => true,
    activeUserId: () => 'user',
    requireUnlockedCek: () => {},
    getCloudInventory: async () => inventory(),
    getCloudChats: batchReads(async () => null),
    getCloudImage: async () => null,
    getProjects: batchReads(async () => null),
    getDocuments: batchDocumentReads(async () => null),
    getLocalChats: async () => [],
    getLocalChat: async () => null,
    ...overrides,
  }
}

describe('native backup collection', () => {
  it('uses one captured inventory and passes opaque ETags to grouped reads', async () => {
    const getCloudInventory = vi
      .fn()
      .mockResolvedValue(
        inventory([
          item('chat', 'chat', 'chat-etag', 'project'),
          item('project', 'project', 'project-etag'),
          item('project_document', 'document', 'document-etag', 'project'),
        ]),
      )
    const getCloudChat = vi
      .fn()
      .mockResolvedValue(chat({ projectId: 'project' }))
    const getProject = vi.fn().mockResolvedValue(project())
    const getDocument = vi.fn().mockResolvedValue(document())

    const result = await collectNativeBackupV2(
      dependencies({
        getCloudInventory,
        getCloudChats: batchReads(getCloudChat),
        getProjects: batchReads(getProject),
        getDocuments: batchDocumentReads(getDocument),
      }),
    )

    expect(getCloudInventory).toHaveBeenCalledOnce()
    expect(getCloudChat).toHaveBeenCalledWith('chat', 'chat-etag')
    expect(getProject).toHaveBeenCalledWith('project', 'project-etag')
    expect(getDocument).toHaveBeenCalledWith(
      'project',
      'document',
      'document-etag',
    )
    expect(result.projects[0]).toMatchObject({
      id: 'project',
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    expect(result.relationships).toMatchObject({
      projectChats: [{ projectId: 'project', chatId: 'chat' }],
      projectDocuments: [{ projectId: 'project', documentId: 'document' }],
    })
    expect(() => formatNativeBackupV2(result)).not.toThrow()
  })

  it('pulls inventory records in batches and isolates per-record failures', async () => {
    const items = Array.from(
      { length: CLOUD_PULL_BATCH_SIZE + 5 },
      (_, index) => item('chat', `chat-${index}`, `etag-${index}`),
    )
    const getCloudChats = vi.fn(
      async (requests: ReadonlyArray<{ id: string; expectedEtag: string }>) =>
        requests.map(({ id }) =>
          id === 'chat-3'
            ? {
                ok: false as const,
                error: new CloudBackupReadError(
                  'snapshot_deleted',
                  'record_deleted_after_snapshot',
                  true,
                ),
              }
            : { ok: true as const, value: chat({ id }) },
        ),
    )

    const result = await collectNativeBackupV2(
      dependencies({
        getCloudInventory: async () => inventory(items),
        getCloudChats,
      }),
    )

    expect(getCloudChats).toHaveBeenCalledTimes(2)
    expect(getCloudChats.mock.calls[0][0]).toHaveLength(CLOUD_PULL_BATCH_SIZE)
    expect(getCloudChats.mock.calls[1][0]).toHaveLength(5)
    expect(getCloudChats.mock.calls[0][0][0]).toEqual({
      id: 'chat-0',
      expectedEtag: 'etag-0',
    })
    expect(result.cloudChats).toHaveLength(items.length - 1)
    expect(result.omissions).toEqual([
      {
        kind: 'cloud_chat',
        source_id: 'chat-3',
        category: 'deleted',
        reason: 'record_deleted_after_snapshot',
      },
    ])
  })

  it('reuses the captured cloud inventory while local inventory converges', async () => {
    const local = chat({
      id: 'local',
      isLocalOnly: true,
      syncUserId: 'user',
    })
    const getCloudInventory = vi.fn().mockResolvedValue(inventory())
    const getLocalChats = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([local])
      .mockResolvedValue([local])
    const getLocalChat = vi.fn().mockResolvedValue(local)

    const result = await collectNativeBackupV2(
      dependencies({ getCloudInventory, getLocalChats, getLocalChat }),
    )

    expect(getCloudInventory).toHaveBeenCalledOnce()
    expect(result.localChats.map(({ id }) => id)).toEqual(['local'])
  })

  it.each([
    ['snapshot_deleted', 'deleted', 'record_deleted_after_snapshot'],
    ['snapshot_changed', 'unstable', 'record_changed_after_snapshot'],
  ] as const)(
    'omits a cloud item reported as %s after capture',
    async (readCategory, omissionCategory, reason) => {
      const getCloudChat = vi.fn(async () => {
        throw new CloudBackupReadError(readCategory, reason, true)
      })

      const result = await collectNativeBackupV2(
        dependencies({
          getCloudInventory: async () =>
            inventory([item('chat', 'chat', 'opaque-etag')]),
          getCloudChats: batchReads(getCloudChat),
        }),
      )

      expect(getCloudChat).toHaveBeenCalledOnce()
      expect(result.cloudChats).toEqual([])
      expect(result.omissions).toContainEqual({
        kind: 'cloud_chat',
        source_id: 'chat',
        category: omissionCategory,
        reason,
      })
    },
  )

  it('omits dependent documents and repairs relationships for an omitted project', async () => {
    const cloudChat = chat({ projectId: 'project' })
    const result = await collectNativeBackupV2(
      dependencies({
        getCloudInventory: async () =>
          inventory([
            item('chat', 'chat', 'chat-etag', 'project'),
            item('project', 'project', 'project-etag'),
            item('project_document', 'document', 'doc-etag', 'project'),
          ]),
        getCloudChats: batchReads(async () => cloudChat),
        getProjects: batchReads(async () => {
          throw new CloudBackupReadError(
            'item_invalid',
            'project_payload_invalid',
            true,
          )
        }),
      }),
    )

    expect(result.projects).toEqual([])
    expect(result.projectDocuments).toEqual([])
    expect(result.cloudChats[0].projectId).toBeUndefined()
    expect(result.omissions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'project', source_id: 'project' }),
        expect.objectContaining({
          kind: 'project_document',
          source_id: 'document',
          reason: 'parent_project_omitted',
        }),
        expect.objectContaining({ kind: 'relationship', source_id: 'chat' }),
      ]),
    )
  })

  it('keeps owner local chats and omits unavailable attachments', async () => {
    const attachment: Attachment = {
      id: 'image',
      type: 'image',
      fileName: 'image.png',
      encryptionKey: 'key',
    }
    const source = chat({
      id: 'local',
      isLocalOnly: true,
      syncUserId: 'user',
      messages: [
        {
          role: 'user',
          content: 'image',
          timestamp: new Date(timestamp),
          attachments: [attachment],
        },
      ],
    })
    const foreign = chat({
      id: 'foreign',
      isLocalOnly: true,
      syncUserId: 'other',
    })
    const anonymous = chat({ id: 'anonymous', isLocalOnly: true })
    const changing = { ...source, id: 'changing' }
    const getLocalChat = vi.fn(async (id: string) => {
      if (id === source.id) return source
      if (id === changing.id) return { ...changing, syncUserId: 'other' }
      throw new Error(`Unexpected local read: ${id}`)
    })
    const result = await collectNativeBackupV2(
      dependencies({
        getLocalChats: async () => [source, foreign, anonymous, changing],
        getLocalChat,
      }),
    )

    expect(result.localChats.map(({ id }) => id)).toEqual(['local'])
    expect(getLocalChat.mock.calls.map(([id]) => id)).not.toContain('foreign')
    expect(getLocalChat.mock.calls.map(([id]) => id)).not.toContain('anonymous')
    expect(result.localChats[0].messages[0].attachments).toEqual([])
    expect(result.omissions[0]).toMatchObject({
      kind: 'attachment',
      parent_source_id: 'local',
    })
  })

  it('includes available embedded local images in the browser archive input', async () => {
    const source = chat({
      id: 'local',
      isLocalOnly: true,
      syncUserId: 'user',
      messages: [
        {
          role: 'user',
          content: 'image',
          timestamp: new Date(timestamp),
          attachments: [
            {
              id: 'image',
              type: 'image',
              fileName: 'image.png',
              base64: btoa(String.fromCharCode(...png)),
            },
          ],
        },
      ],
    })
    const result = await collectNativeBackupV2(
      dependencies({
        getLocalChats: async () => [source],
        getLocalChat: async () => source,
      }),
    )

    expect(result.images).toHaveLength(1)
    expect(result.images[0].bytes).toEqual(png)
  })

  it('downloads attachments concurrently within a bounded ordered pool', async () => {
    const attachmentIds = Array.from(
      { length: 8 },
      (_, index) => `image-${index}`,
    )
    const source = chat({
      messages: [
        {
          role: 'user',
          content: 'images',
          timestamp: new Date(timestamp),
          attachments: attachmentIds.map((id) => ({
            id,
            type: 'image' as const,
            fileName: `${id}.png`,
            encryptionKey: 'key',
          })),
        },
      ],
    })
    const releases: Array<() => void> = []
    const payloads = attachmentIds.map(
      (_, index) => new Uint8Array([...png, index]),
    )
    const downloads = payloads.map(
      (bytes) =>
        new Promise<Uint8Array>((resolve) => {
          releases.push(() => resolve(bytes))
        }),
    )
    let active = 0
    let maxActive = 0
    const getCloudImage = vi.fn(async ({ id }: { id: string }) => {
      active++
      maxActive = Math.max(maxActive, active)
      const bytes = await downloads[attachmentIds.indexOf(id)]
      active--
      return bytes
    })

    const collection = collectNativeBackupV2(
      dependencies({
        getCloudInventory: async () =>
          inventory([item('chat', 'chat', 'etag')]),
        getCloudChats: batchReads(async () => source),
        getCloudImage,
      }),
    )
    try {
      await vi.waitFor(() => expect(getCloudImage).toHaveBeenCalledTimes(4))
      for (const [completed, index] of [3, 2, 1, 0].entries()) {
        releases[index]()
        await vi.waitFor(() =>
          expect(getCloudImage).toHaveBeenCalledTimes(5 + completed),
        )
      }
    } finally {
      releases.forEach((release) => release())
    }

    const result = await collection
    expect(maxActive).toBe(4)
    expect(result.images.map(({ bytes }) => bytes)).toEqual(payloads)
    expect(
      result.relationships.chatImages.map(
        ({ imageId }) => JSON.parse(imageId)[4],
      ),
    ).toEqual(attachmentIds)
  })

  it('keeps an explicitly omittable systemic attachment failure fatal', async () => {
    const source = chat({
      messages: [
        {
          role: 'user',
          content: 'image',
          timestamp: new Date(timestamp),
          attachments: [
            {
              id: 'image',
              type: 'image',
              fileName: 'image.png',
              encryptionKey: 'key',
            },
          ],
        },
      ],
    })
    const failure = new NativeBackupCollectionError(
      'image',
      'image',
      'system unavailable',
      'systemic',
      'system_unavailable',
      true,
    )

    await expect(
      collectNativeBackupV2(
        dependencies({
          getCloudInventory: async () =>
            inventory([item('chat', 'chat', 'etag')]),
          getCloudChats: batchReads(async () => source),
          getCloudImage: async () => {
            throw failure
          },
        }),
      ),
    ).rejects.toBe(failure)
  })

  it.each([
    new AuthTokenUnavailableError('unavailable'),
    new SyncNetworkError(),
    new CloudBackupReadError('key_unavailable', 'cloud_key_unavailable', false),
  ])(
    'keeps authentication, network, and key failures fatal',
    async (failure) => {
      await expect(
        collectNativeBackupV2(
          dependencies({
            getCloudInventory: async () =>
              inventory([item('chat', 'chat', 'etag')]),
            getCloudChats: batchReads(async () => {
              throw failure
            }),
          }),
        ),
      ).rejects.toBe(failure)
    },
  )
})
