import { localThreadStore } from '@/services/harness/local-threads'
import { HarnessError } from '@/services/harness/sse'
import {
  formatNativeBackupV2,
  type NativeBackupOmission,
  type NativeBackupV2Input,
} from '@/services/native-backup/format'
import { restoreNativeBackup } from '@/services/native-backup/orchestrate'
import { validateAndPackageNativeBackup } from '@/services/native-backup/restore'
import { chatEvents } from '@/services/storage/chat-events'
import { deletedChatsTracker } from '@/services/storage/deleted-chats-tracker'
import { indexedDBStorage } from '@/services/storage/indexed-db'
import { uint8ArrayToBase64 } from '@/utils/binary-codec'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { IDBKeyRange as FakeIDBKeyRange, IDBFactory } from 'fake-indexeddb'
import { unzipSync, zipSync } from 'fflate'
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { client, KEY, signIn } from '../../harness-fixture'

const backupId = '123e4567-e89b-42d3-a456-426614174000'
const timestamp = '2026-08-20T12:00:00.000Z'
const later = '2026-08-20T12:05:00.000Z'
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13])
const pageImage = new Uint8Array([255, 216, 255, 224, 0, 16])

const localChat: NativeBackupV2Input['localChats'][number] = {
  id: 'local-1',
  title: 'Local chat',
  titleState: 'manual',
  createdAt: timestamp,
  updatedAt: later,
  model: 'test-model',
  webSearchEnabled: false,
  messages: [
    {
      role: 'user',
      content: 'See these',
      timestamp,
      attachments: [
        { id: 'photo', type: 'image', imageId: 'local-image' },
        {
          id: 'scan',
          type: 'document',
          fileName: 'scan.pdf',
          textContent: 'Scanned text',
          pages: [
            {
              page: 1,
              text: 'Scanned text',
              is_scanned: true,
              imageId: 'page',
            },
          ],
        },
      ],
    },
    {
      role: 'assistant',
      content: 'Both are clear.',
      timestamp: later,
      thoughts: 'Reading',
      timeline: [
        { type: 'thinking', id: 'r-t', content: 'Reading', isThinking: false },
        { type: 'content', id: 'r-c', content: 'Both are clear.' },
      ],
    },
  ],
}

function backup(
  parts: { cloud?: boolean; local?: boolean; localInProject?: boolean } = {},
  omissions: NativeBackupOmission[] = [],
  warnings: NativeBackupV2Input['warnings'] = [],
) {
  const cloud = parts.cloud ?? true
  const local = parts.local ?? true
  const inProject = cloud && local && parts.localInProject === true
  const input: NativeBackupV2Input = {
    backupId,
    createdAt: timestamp,
    projects: cloud
      ? [
          {
            id: 'project-1',
            name: 'Research',
            description: '',
            systemInstructions: '',
            memory: [],
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        ]
      : [],
    projectDocuments: [],
    cloudChats: cloud
      ? [
          {
            id: 'cloud-1',
            title: 'Cloud chat',
            createdAt: timestamp,
            updatedAt: timestamp,
            projectId: 'project-1',
            messages: [
              {
                role: 'user',
                content: 'hello',
                timestamp,
                attachments: [
                  { id: 'cloud-photo', type: 'image', imageId: 'cloud-image' },
                ],
              },
            ],
          },
        ]
      : [],
    localChats: local
      ? [inProject ? { ...localChat, projectId: 'project-1' } : localChat]
      : [],
    relationships: {
      projectChats: [
        ...(cloud ? [{ projectId: 'project-1', chatId: 'cloud-1' }] : []),
        ...(inProject ? [{ projectId: 'project-1', chatId: 'local-1' }] : []),
      ],
      projectDocuments: [],
      chatImages: [
        ...(cloud ? [{ chatId: 'cloud-1', imageId: 'cloud-image' }] : []),
        ...(local
          ? [
              { chatId: 'local-1', imageId: 'local-image' },
              { chatId: 'local-1', imageId: 'page' },
            ]
          : []),
      ],
    },
    images: [
      ...(cloud
        ? [
            {
              metadata: {
                id: 'cloud-image',
                chatId: 'cloud-1',
                messageIndex: 0,
                attachmentId: 'cloud-photo',
                fileName: 'cloud.png',
                mimeType: 'image/png' as const,
              },
              bytes: png,
            },
          ]
        : []),
      ...(local
        ? [
            {
              metadata: {
                id: 'local-image',
                chatId: 'local-1',
                messageIndex: 0,
                attachmentId: 'photo',
                fileName: 'photo.png',
                mimeType: 'image/png' as const,
              },
              bytes: png,
            },
            {
              metadata: {
                id: 'page',
                chatId: 'local-1',
                messageIndex: 0,
                attachmentId: 'scan',
                page: 1,
                fileName: 'scan-page-1.jpg',
                mimeType: 'image/jpeg' as const,
              },
              bytes: pageImage,
            },
          ]
        : []),
    ],
    omissions,
    warnings,
  }
  const formatted = formatNativeBackupV2(input)
  return new File(
    [
      zipSync({
        'manifest.json': formatted.manifestBytes,
        ...Object.fromEntries(
          formatted.files.map(({ path, bytes }) => [path, bytes]),
        ),
      }),
    ],
    'tinfoil-backup.zip',
    { type: 'application/zip' },
  )
}

const restoredId = (ownerId: string, sourceId = 'local-1') =>
  `native-${bytesToHex(sha256(new TextEncoder().encode(`${ownerId}\0${backupId}\0${sourceId}`)))}`

function acceptUpload(statuses: Record<string, unknown>[]) {
  client.upload.mockResolvedValue({ jobId: 'job-1' })
  client.post.mockImplementation(async (path: string) => {
    if (path !== '/v1/import/status') throw new Error(`Unexpected ${path}`)
    const status = statuses.length > 1 ? statuses.shift() : statuses[0]
    return { jobId: 'job-1', imported: 0, failed: 0, total: 1, ...status }
  })
}

const restore = (
  file: File,
  overrides: Parameters<typeof restoreNativeBackup>[4] = {},
  ownerId = 'alice',
) =>
  restoreNativeBackup(
    file,
    ownerId,
    new AbortController().signal,
    {},
    { wait: async () => {}, ...overrides },
  )

beforeAll(() => {
  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    value: new IDBFactory(),
  })
  Object.defineProperty(globalThis, 'IDBKeyRange', {
    configurable: true,
    value: FakeIDBKeyRange,
  })
})

beforeEach(async () => {
  sessionStorage.clear()
  deletedChatsTracker.clear()
  await indexedDBStorage.deleteAllChats()
  deletedChatsTracker.clear()
  signIn()
})

afterEach(() => {
  chatEvents.clear()
  deletedChatsTracker.clear()
  vi.restoreAllMocks()
})

describe('restoring a native backup', () => {
  it('uploads only the cloud part and restores the local chats on this device', async () => {
    acceptUpload([{ status: 'completed' }])

    const result = await restore(backup())

    expect(client.upload).toHaveBeenCalledOnce()
    const [path, uploaded, fields] = client.upload.mock.calls[0]
    expect([path, fields]).toEqual([
      '/v1/import',
      { key: KEY, source: 'tinfoil' },
    ])
    const entries = Object.keys(
      unzipSync(new Uint8Array(await (uploaded as File).arrayBuffer())),
    )
    expect(entries.some((entry) => entry.startsWith('local_chats/'))).toBe(
      false,
    )
    const cloudPart = await validateAndPackageNativeBackup(uploaded as File)
    expect(cloudPart.local).toEqual({ chats: [], images: [] })
    expect(cloudPart.backup.counts).toMatchObject({
      cloud_chats: 1,
      local_chats: 0,
      images: 1,
    })
    expect(client.post).toHaveBeenCalledExactlyOnceWith(
      '/v1/import/status',
      { jobId: 'job-1' },
      expect.any(AbortSignal),
    )

    const id = restoredId('alice')
    const restored = await localThreadStore('device').get(id)
    expect(restored).toEqual({
      id,
      title: 'Local chat',
      titleState: 'manual',
      createdAt: '2026-08-20T12:00:00Z',
      updatedAt: '2026-08-20T12:05:00Z',
      model: 'test-model',
      webSearchEnabled: false,
      codeExecutionAccessToken: expect.stringMatching(/^[0-9a-f]{64}$/),
      messages: [
        {
          id: `${id}-message-0`,
          role: 'user',
          createdAt: '2026-08-20T12:00:00Z',
          content: 'See these',
          attachments: [
            {
              id: 'photo',
              type: 'image',
              fileName: 'photo.png',
              mimeType: 'image/png',
              fileSize: png.length,
              base64: uint8ArrayToBase64(png),
            },
            {
              id: 'scan',
              type: 'document',
              fileName: 'scan.pdf',
              textContent: 'Scanned text',
              pages: [
                {
                  page: 1,
                  text: 'Scanned text',
                  is_scanned: true,
                  image: uint8ArrayToBase64(pageImage),
                },
              ],
            },
          ],
        },
        {
          id: `${id}-message-1`,
          role: 'assistant',
          createdAt: '2026-08-20T12:05:00Z',
          content: 'Both are clear.',
          timeline: [
            {
              type: 'thinking',
              id: 'r-t',
              content: 'Reading',
              isThinking: false,
            },
            { type: 'content', id: 'r-c', content: 'Both are clear.' },
          ],
        },
      ],
    })
    expect(result.state).toBe('completed')
    expect(result.report).toMatchObject({
      projects: { imported: 1 },
      cloud_chats: { imported: 1 },
      local_chats: { imported: 1, skipped: 0, failed: 0 },
      attachments: { imported: 3 },
    })
  })

  it('skips local chats restored before and keeps them apart per account', async () => {
    acceptUpload([{ status: 'completed' }])
    await restore(backup({ cloud: false }))
    const first = await localThreadStore('device').get(restoredId('alice'))

    const again = await restore(backup({ cloud: false }))

    expect(again.report.local_chats).toMatchObject({ imported: 0, skipped: 1 })
    expect(again.report.attachments).toMatchObject({ imported: 0, skipped: 2 })
    expect(await localThreadStore('device').get(restoredId('alice'))).toEqual(
      first,
    )
    expect((await localThreadStore('device').list()).map((t) => t.id)).toEqual([
      restoredId('alice'),
    ])

    await restore(backup({ cloud: false }), {}, 'bob')
    expect(
      (await localThreadStore('device').list()).map((t) => t.id).sort(),
    ).toEqual([restoredId('alice'), restoredId('bob')].sort())
    expect(client.upload).not.toHaveBeenCalled()
  })

  it('restores no local chats when the cloud restore fails', async () => {
    acceptUpload([{ status: 'failed', failure_reason: 'invalid_archive' }])

    const result = await restore(backup())

    expect(result).toMatchObject({
      state: 'failed',
      jobId: 'job-1',
      failureReason: 'invalid_archive',
    })
    expect(await localThreadStore('device').list()).toEqual([])
  })

  it('leaves a restore pending while the cloud job keeps running', async () => {
    acceptUpload([{ status: 'running' }])
    const wait = vi.fn(async () => {})

    const result = await restore(backup(), { wait })

    expect(result).toMatchObject({ state: 'pending', jobId: 'job-1' })
    expect(wait).toHaveBeenCalledTimes(20)
    expect(client.post).toHaveBeenCalledTimes(21)
    expect(await localThreadStore('device').list()).toEqual([])
  })

  it('reports an interrupted restore when the chat service forgets the job', async () => {
    client.upload.mockResolvedValue({ jobId: 'job-1' })
    let polls = 0
    client.post.mockImplementation(async (path: string) => {
      if (path !== '/v1/import/status') throw new Error(`Unexpected ${path}`)
      if (polls++ === 0)
        return {
          jobId: 'job-1',
          status: 'running',
          imported: 0,
          failed: 0,
          total: 1,
        }
      throw new HarnessError({ code: 'THREAD_NOT_FOUND', message: 'Gone' }, 404)
    })

    const result = await restore(backup())

    expect(result).toMatchObject({ state: 'interrupted', jobId: 'job-1' })
    expect(await localThreadStore('device').list()).toEqual([])
  })

  it('rethrows status failures other than a missing job', async () => {
    client.upload.mockResolvedValue({ jobId: 'job-1' })
    const failure = new HarnessError(
      { code: 'UPSTREAM_REFUSED', message: 'Down' },
      503,
    )
    let polls = 0
    client.post.mockImplementation(async (path: string) => {
      if (path !== '/v1/import/status') throw new Error(`Unexpected ${path}`)
      if (polls++ === 0)
        return {
          jobId: 'job-1',
          status: 'running',
          imported: 0,
          failed: 0,
          total: 1,
        }
      throw failure
    })

    await expect(restore(backup())).rejects.toBe(failure)
  })

  it('surfaces partial source coverage through the restore report', async () => {
    acceptUpload([{ status: 'completed' }])
    const file = backup(
      {},
      [
        {
          kind: 'cloud_chat',
          source_id: 'private-source-id',
          category: 'invalid',
          reason: 'record_invalid',
        },
      ],
      [{ code: 'source_items_omitted', category: 'source_coverage', count: 1 }],
    )

    const result = await restore(file)

    expect(result.state).toBe('partial')
    expect(result.report.cloud_chats.warnings).toEqual([
      'Source archive omitted 1 cloud chat.',
    ])
    expect(JSON.stringify(result.report)).not.toContain('private-source-id')
    expect(
      await localThreadStore('device').get(restoredId('alice')),
    ).not.toBeNull()
  })

  it('restores a local chat from a project without it, as chats on this device have none', async () => {
    acceptUpload([{ status: 'completed' }])

    const result = await restore(backup({ localInProject: true }))

    expect(result.state).toBe('partial')
    expect(result.report.local_chats).toMatchObject({
      imported: 1,
      warnings: ['Restored "Local chat" without its unavailable project.'],
    })
    const [summary] = await localThreadStore('device').list()
    expect(summary).toMatchObject({ id: restoredId('alice'), projectId: null })
  })

  it('counts a local chat that cannot be stored as failed', async () => {
    const result = await restore(backup({ cloud: false }), {
      saveChat: async () => null,
    })

    expect(result.state).toBe('partial')
    expect(result.report.local_chats).toMatchObject({ imported: 0, failed: 1 })
    expect(result.report.attachments).toMatchObject({ imported: 0, failed: 2 })
    expect(await localThreadStore('device').list()).toEqual([])
  })
})
