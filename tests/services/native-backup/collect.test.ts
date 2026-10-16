import { AUTH_ACTIVE_USER_ID } from '@/constants/storage-keys'
import type { HarnessClient } from '@/services/harness/client'
import {
  localThreadStore,
  type LocalThread,
} from '@/services/harness/local-threads'
import { activateAPI, HarnessAPI, publish } from '@/services/harness/runtime'
import { collectNativeBackupV2 } from '@/services/native-backup/collect'
import {
  runNativeBackupExport,
  type NativeBackupExportProgress,
} from '@/services/native-backup/export'
import {
  formatNativeBackupV2,
  type NativeBackupOmission,
  type NativeBackupV2Input,
} from '@/services/native-backup/format'
import {
  readNativeBackup,
  validateAndPackageNativeBackup,
} from '@/services/native-backup/restore'
import { writeNativeBackupArchive } from '@/services/native-backup/write'
import { chatEvents } from '@/services/storage/chat-events'
import { deletedChatsTracker } from '@/services/storage/deleted-chats-tracker'
import { indexedDBStorage } from '@/services/storage/indexed-db'
import { uint8ArrayToBase64 } from '@/utils/binary-codec'
import { IDBKeyRange as FakeIDBKeyRange, IDBFactory } from 'fake-indexeddb'
import { zipSync } from 'fflate'
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { testSession } from '../../harness-fixture'

const KEY = 'Y29udGVudC1rZXk='
const backupId = '123e4567-e89b-42d3-a456-426614174000'
const timestamp = '2026-08-20T12:00:00.000Z'
const LOCAL_ID = '8233746419000_1c4e7a52-9a2b-4f7e-8d1a-5b6c7d8e9f00'
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13])
const jpeg = new Uint8Array([255, 216, 255, 224, 0, 16])

let client: {
  events: ReturnType<typeof vi.fn>
  post: ReturnType<typeof vi.fn>
  upload: ReturnType<typeof vi.fn>
  download: ReturnType<typeof vi.fn>
}

// The harness's archive of the cloud's data: a project, a chat in it, and
// the chat's image.
function cloudBackup(
  omissions: NativeBackupOmission[] = [],
  cloudChatId = 'cloud-1',
): Blob {
  const input: NativeBackupV2Input = {
    backupId,
    createdAt: timestamp,
    projects: [
      {
        id: 'project-1',
        name: 'Garden',
        description: '',
        systemInstructions: '',
        memory: [],
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    projectDocuments: [],
    cloudChats: [
      {
        id: cloudChatId,
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
    ],
    localChats: [],
    relationships: {
      projectChats: [{ projectId: 'project-1', chatId: cloudChatId }],
      projectDocuments: [],
      chatImages: [{ chatId: cloudChatId, imageId: 'cloud-image' }],
    },
    images: [
      {
        metadata: {
          id: 'cloud-image',
          chatId: cloudChatId,
          messageIndex: 0,
          attachmentId: 'cloud-photo',
          fileName: 'cloud.png',
          mimeType: 'image/png',
        },
        bytes: png,
      },
    ],
    omissions,
    warnings: omissions.length
      ? [
          {
            code: 'source_items_omitted',
            category: 'source_coverage',
            count: omissions.length,
          },
        ]
      : [],
  }
  const formatted = formatNativeBackupV2(input)
  return new Blob([
    zipSync({
      'manifest.json': formatted.manifestBytes,
      ...Object.fromEntries(
        formatted.files.map(({ path, bytes }) => [path, bytes]),
      ),
    }),
  ])
}

const deviceChat: LocalThread = {
  id: LOCAL_ID,
  title: 'Garden plans',
  titleState: 'manual',
  createdAt: '2026-04-01T09:00:00Z',
  updatedAt: '2026-04-01T09:05:00Z',
  model: 'test-model',
  presetId: 'preset-1',
  webSearchEnabled: false,
  codeExecutionAccessToken: 'c'.repeat(64),
  messages: [
    {
      id: 'u1',
      role: 'user',
      createdAt: '2026-04-01T09:00:01Z',
      content: 'Look at the beds',
      quote: 'the beds',
      attachments: [
        {
          id: 'photo',
          type: 'image',
          fileName: 'bed.png',
          mimeType: 'image/png',
          fileSize: png.length,
          thumbnailBase64: 'dGh1bWI=',
          description: 'A raised bed',
          base64: uint8ArrayToBase64(png),
        },
        {
          id: 'scan',
          type: 'document',
          fileName: 'scan.pdf',
          mimeType: 'application/pdf',
          fileSize: 2048,
          textContent: 'Tomatoes',
          pages: [
            {
              page: 1,
              text: 'Tomatoes',
              image: uint8ArrayToBase64(jpeg),
              is_scanned: true,
            },
            { page: 2, text: 'Basil', image: '', is_scanned: false },
          ],
        },
      ],
    },
    {
      id: 'a1',
      role: 'assistant',
      createdAt: '2026-04-01T09:00:05Z',
      content: 'Plant in May.',
      model: 'test-model',
      modelDisplayName: 'Test model',
      timeline: [
        { id: 'a1-t', type: 'thinking', content: 'Frost' },
        {
          id: 'call-1',
          type: 'tool_call',
          toolCallId: 'call-1',
          name: 'web_search',
          arguments: '{"query":"frost dates"}',
          complete: true,
          result: { query: 'frost dates', results: [] },
        },
        {
          id: 'call-2',
          type: 'tool_call',
          toolCallId: 'call-2',
          name: 'render_chart',
          arguments: '{"x":1}',
          complete: true,
          result: { ok: true },
          resolution: { text: 'Done' },
          resolvedAt: '2026-04-01T09:00:06Z',
        },
        { id: 'a1-c', type: 'content', content: 'Plant in May.' },
      ],
    },
  ],
}

const photoId = JSON.stringify(['attachment', LOCAL_ID, 0, 0, 'photo'])
const pageId = JSON.stringify(['page', LOCAL_ID, 0, 1, 'scan', 1])

// deviceChat in the backup's format, as the harness writes a cloud chat.
const backedUpChat = {
  id: LOCAL_ID,
  title: 'Garden plans',
  titleState: 'manual',
  createdAt: '2026-04-01T09:00:00.000Z',
  updatedAt: '2026-04-01T09:05:00.000Z',
  presetId: 'preset-1',
  model: 'test-model',
  webSearchEnabled: false,
  messages: [
    {
      role: 'user',
      content: 'Look at the beds',
      timestamp: '2026-04-01T09:00:01.000Z',
      quote: 'the beds',
      attachments: [
        { type: 'image', id: 'photo', imageId: photoId },
        {
          type: 'document',
          id: 'scan',
          fileName: 'scan.pdf',
          mimeType: 'application/pdf',
          textContent: 'Tomatoes',
          fileSize: 2048,
          pages: [
            { page: 1, text: 'Tomatoes', is_scanned: true, imageId: pageId },
            { page: 2, text: 'Basil', is_scanned: false },
          ],
        },
      ],
    },
    {
      role: 'assistant',
      content: 'Plant in May.',
      timestamp: '2026-04-01T09:00:05.000Z',
      modelDisplayName: 'Test model',
      thoughts: 'Frost',
      timeline: [
        { type: 'thinking', id: 'a1-t', content: 'Frost', isThinking: false },
        {
          type: 'code_exec',
          id: 'call-1',
          calls: [
            {
              id: 'call-1',
              toolName: 'web_search',
              arguments: { query: 'frost dates' },
              status: 'completed',
              output: '{"query":"frost dates","results":[]}',
            },
          ],
        },
        {
          type: 'tool_call',
          id: 'call-2',
          toolCallId: 'call-2',
          name: 'render_chart',
          arguments: '{"x":1}',
          resolution: { text: 'Done' },
          resolvedAt: Date.parse('2026-04-01T09:00:06Z'),
        },
        { type: 'content', id: 'a1-c', content: 'Plant in May.' },
      ],
    },
  ],
}

function signIn(archive: Blob) {
  localStorage.setItem(AUTH_ACTIVE_USER_ID, 'alice')
  client = {
    events: vi.fn(),
    post: vi.fn(),
    upload: vi.fn(),
    download: vi.fn(async (path: string) => {
      if (path !== '/v1/export') throw new Error(`Unexpected ${path}`)
      return archive
    }),
  }
  const api = new HarnessAPI(client as unknown as HarnessClient, 'alice')
  vi.spyOn(api, 'key').mockReturnValue(KEY)
  activateAPI(api)
  publish({ session: testSession, keyReady: true, profileReady: true })
}

// Runs the export as the backup panel does, keeping the saved archive.
async function exportBackup() {
  let saved: Blob | undefined
  const progress: NativeBackupExportProgress[] = []
  const result = await runNativeBackupExport(
    new AbortController().signal,
    (value) => progress.push(value),
    {
      collect: (signal) => collectNativeBackupV2(signal),
      format: formatNativeBackupV2,
      write: writeNativeBackupArchive,
      download: (archive) => {
        if (archive.kind === 'blob') saved = archive.blob
      },
    },
  )
  expect(progress).toEqual(['collecting', 'formatting', 'writing'])
  return { result, file: new File([saved!], 'tinfoil-backup.zip') }
}

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
})

afterEach(() => {
  chatEvents.clear()
  deletedChatsTracker.clear()
  vi.restoreAllMocks()
})

describe('creating a native backup', () => {
  it("adds this device's chats to the harness's backup of the cloud", async () => {
    signIn(cloudBackup())
    await localThreadStore('device').update(LOCAL_ID, () => deviceChat)

    const { result, file } = await exportBackup()

    expect(client.download).toHaveBeenCalledExactlyOnceWith(
      '/v1/export',
      { key: KEY, format: 'tinfoil-backup' },
      expect.any(AbortSignal),
    )
    expect(result).toEqual({
      complete: true,
      omitted: 0,
      adjustedRelationships: 0,
      localInventoryUnstable: false,
      warnings: 0,
    })
    const contents = await readNativeBackup(file)
    expect(contents.backup).toMatchObject({
      version: 2,
      backup_id: backupId,
      complete: true,
      counts: {
        projects: 1,
        project_documents: 0,
        cloud_chats: 1,
        local_chats: 1,
        relationships: 4,
        images: 3,
      },
      omissions: [],
      warnings: [],
    })
    expect(contents.localChats).toEqual([backedUpChat])
    expect(contents.cloudChats.map(({ id }) => id)).toEqual(['cloud-1'])
    expect(contents.relationships.chatImages).toEqual(
      expect.arrayContaining([
        { chatId: LOCAL_ID, imageId: photoId },
        { chatId: LOCAL_ID, imageId: pageId },
        { chatId: 'cloud-1', imageId: 'cloud-image' },
      ]),
    )
    expect(
      contents.images
        .filter(({ metadata }) => metadata.chatId === LOCAL_ID)
        .sort((a, b) => a.metadata.messageIndex - b.metadata.messageIndex),
    ).toEqual(
      expect.arrayContaining([
        {
          metadata: {
            id: photoId,
            chatId: LOCAL_ID,
            messageIndex: 0,
            attachmentId: 'photo',
            fileName: 'bed.png',
            mimeType: 'image/png',
            sizeBytes: png.length,
            description: 'A raised bed',
          },
          bytes: png,
        },
        {
          metadata: {
            id: pageId,
            chatId: LOCAL_ID,
            messageIndex: 0,
            attachmentId: 'scan',
            page: 1,
            fileName: 'scan-page-1.jpg',
            mimeType: 'image/jpeg',
            sizeBytes: jpeg.length,
          },
          bytes: jpeg,
        },
      ]),
    )

    // The restore splits the local chat and its images back out.
    const validated = await validateAndPackageNativeBackup(file)
    expect(validated.local.chats).toEqual([backedUpChat])
    expect(
      validated.local.images.map(({ metadata }) => metadata.id).sort(),
    ).toEqual([pageId, photoId].sort())
    expect(validated.cloud?.manifest.counts).toMatchObject({
      cloud_chats: 1,
      local_chats: 0,
      images: 1,
    })
  })

  it('leaves out an image it cannot back up and records the omission', async () => {
    const cloudOmission: NativeBackupOmission = {
      kind: 'attachment',
      source_id: 'lost-cloud-image',
      parent_source_id: 'cloud-1',
      category: 'unavailable',
      reason: 'attachment_not_found',
    }
    signIn(cloudBackup([cloudOmission]))
    await localThreadStore('device').update(LOCAL_ID, () => ({
      ...deviceChat,
      messages: [
        {
          id: 'u1',
          role: 'user',
          createdAt: '2026-04-01T09:00:01Z',
          content: 'Three files',
          attachments: [
            {
              id: 'not-an-image',
              type: 'image',
              fileName: 'notes.png',
              base64: btoa('plain text'),
            },
            {
              id: 'thumb-only',
              type: 'image',
              fileName: 'old.png',
              thumbnailBase64: 'dGh1bWI=',
            },
            {
              id: 'photo',
              type: 'image',
              fileName: 'bed.png',
              base64: uint8ArrayToBase64(png),
            },
          ],
        },
      ],
    }))

    const { result, file } = await exportBackup()

    expect(result).toMatchObject({ complete: false, omitted: 3 })
    const contents = await readNativeBackup(file)
    expect(contents.backup).toMatchObject({
      complete: false,
      omissions: [
        cloudOmission,
        {
          kind: 'attachment',
          source_id: JSON.stringify([
            'attachment',
            LOCAL_ID,
            0,
            0,
            'not-an-image',
          ]),
          parent_source_id: LOCAL_ID,
          category: 'invalid',
          reason: 'attachment_type_unsupported',
        },
        // An image kept only as a thumbnail has no bytes to back up.
        {
          kind: 'attachment',
          source_id: JSON.stringify([
            'attachment',
            LOCAL_ID,
            0,
            1,
            'thumb-only',
          ]),
          parent_source_id: LOCAL_ID,
          category: 'unavailable',
          reason: 'attachment_not_found',
        },
      ],
      warnings: [
        { code: 'source_items_omitted', category: 'source_coverage', count: 3 },
      ],
    })
    expect(contents.localChats[0].messages[0].attachments).toEqual([
      {
        type: 'image',
        id: 'photo',
        imageId: JSON.stringify(['attachment', LOCAL_ID, 0, 2, 'photo']),
      },
    ])
  })

  it('backs up a chat the cloud also holds only once', async () => {
    signIn(cloudBackup([], LOCAL_ID))
    await localThreadStore('device').update(LOCAL_ID, () => deviceChat)

    const { result, file } = await exportBackup()

    expect(result).toMatchObject({ complete: false, omitted: 1 })
    const contents = await readNativeBackup(file)
    expect(contents.localChats).toEqual([])
    expect(contents.cloudChats.map(({ id }) => id)).toEqual([LOCAL_ID])
    expect(contents.backup).toMatchObject({
      omissions: [
        {
          kind: 'local_chat',
          source_id: LOCAL_ID,
          category: 'invalid',
          reason: 'duplicate_chat_id',
        },
      ],
    })
  })

  it('omits a local chat the backup format cannot hold', async () => {
    signIn(cloudBackup())
    await localThreadStore('device').update(LOCAL_ID, () => ({
      ...deviceChat,
      messages: [
        {
          ...deviceChat.messages[0],
          attachments: [
            {
              id: 'scan',
              type: 'document' as const,
              fileName: 'scan.pdf',
              pages: [{ page: 1.5, text: 'x', image: '', is_scanned: false }],
            },
          ],
        },
      ],
    }))
    await localThreadStore('device').update('other', () => ({
      ...deviceChat,
      id: 'other',
      messages: [deviceChat.messages[1]],
    }))

    const { result, file } = await exportBackup()

    expect(result).toMatchObject({ complete: false, omitted: 1 })
    const contents = await readNativeBackup(file)
    expect(contents.localChats.map(({ id }) => id)).toEqual(['other'])
    expect(contents.backup).toMatchObject({
      omissions: [
        {
          kind: 'local_chat',
          source_id: LOCAL_ID,
          category: 'invalid',
          reason: 'record_invalid',
        },
      ],
    })
  })

  it('marks local chats that keep changing as a partial snapshot', async () => {
    let reads = 0
    const collected = await collectNativeBackupV2(
      new AbortController().signal,
      {
        downloadCloudBackup: async () => cloudBackup(),
        readBackup: (file, signal) => readNativeBackup(file, { signal }),
        localThreads: async () => [
          { ...deviceChat, title: `Garden plans ${reads++}` },
        ],
      },
    )

    expect(reads).toBe(6)
    expect(collected.localChats.map(({ title }) => title)).toEqual([
      'Garden plans 4',
    ])
    expect(collected.omissions).toEqual([
      {
        kind: 'local_inventory',
        source_id: 'eligible_local_chats',
        category: 'unstable',
        reason: 'inventory_did_not_converge',
      },
    ])
    expect(collected.warnings).toEqual([
      {
        code: 'local_inventory_unstable',
        category: 'source_coverage',
        count: 1,
      },
    ])
    expect(() => formatNativeBackupV2(collected)).not.toThrow()
  })
})
