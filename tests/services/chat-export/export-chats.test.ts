import { buildChatExport } from '@/services/chat-export/export-archive'
import { collectChatExport } from '@/services/chat-export/export-chats'
import {
  localThreadStore,
  type LocalThread,
} from '@/services/harness/local-threads'
import { HarnessError } from '@/services/harness/sse'
import type { ThreadSummary } from '@/services/harness/types'
import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it, vi } from 'vitest'
import { client, KEY, signIn } from '../../harness-fixture'
import { resetChatStoresAroundEachTest } from '../harness/thread-fixture'

vi.mock('@/utils/error-handling', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarning: vi.fn(),
}))

const IMAGE = new Uint8Array([137, 80, 78, 71, 1, 2, 3])
const IMAGE_BASE64 = 'iVBORwECAw=='
const LOCAL_ID = '8233746419000_1c4e7a52-9a2b-4f7e-8d1a-5b6c7d8e9f00'

const deviceChat: LocalThread = {
  id: LOCAL_ID,
  title: 'Garden plans',
  titleState: 'manual',
  createdAt: '2026-04-01T09:00:00Z',
  updatedAt: '2026-04-01T09:05:00Z',
  messages: [
    {
      id: 'u1',
      role: 'user',
      createdAt: '2026-04-01T09:00:01Z',
      content: 'Look at these',
      attachments: [
        {
          id: 'photo-1',
          type: 'image',
          fileName: 'bed.png',
          mimeType: 'image/png',
          fileSize: 7,
          thumbnailBase64: 'dGh1bWI=',
          base64: IMAGE_BASE64,
        },
        {
          id: 'scan-1',
          type: 'document',
          fileName: 'scan.pdf',
          mimeType: 'application/pdf',
          pages: [
            { page: 1, text: 'Tomatoes', image: 'cGFnZQ==', is_scanned: true },
            { page: 2, text: 'Basil', image: 'cGFnZQ==', is_scanned: true },
          ],
        },
      ],
    },
    {
      id: 'a1',
      role: 'assistant',
      createdAt: '2026-04-01T09:00:05Z',
      content: 'Plant them in May.',
      timeline: [
        { id: 'a1-t', type: 'thinking', content: 'Frost ' },
        { id: 'a1-c', type: 'content', content: 'Plant them ' },
        { id: 'a1-t2', type: 'thinking', content: 'dates' },
        { id: 'a1-c2', type: 'content', content: 'in May.' },
      ],
    },
  ],
}

// The conversation the export writes for deviceChat, in main's format.
const deviceConversation = {
  uuid: LOCAL_ID,
  name: 'Garden plans',
  created_at: '2026-04-01T09:00:00.000Z',
  updated_at: '2026-04-01T09:05:00.000Z',
  chat_messages: [
    {
      uuid: `${LOCAL_ID}_msg_0`,
      text: 'Look at these',
      sender: 'human',
      created_at: '2026-04-01T09:00:01.000Z',
      attachments: [
        {
          id: 'photo-1',
          type: 'image',
          fileName: 'bed.png',
          mimeType: 'image/png',
          fileSize: 7,
          exportPath: 'attachments/photo-1/bed.png',
        },
        {
          id: 'scan-1',
          type: 'document',
          fileName: 'scan.pdf',
          mimeType: 'application/pdf',
          textContent: 'Tomatoes\n\n---\n\nBasil',
        },
      ],
    },
    {
      uuid: `${LOCAL_ID}_msg_1`,
      text: 'Plant them in May.',
      sender: 'assistant',
      created_at: '2026-04-01T09:00:05.000Z',
      content: [{ type: 'thinking', thinking: 'Frost dates' }],
    },
  ],
}

function summary(
  id: string,
  title: string,
  projectId: string | null = null,
): ThreadSummary {
  return {
    id,
    title,
    titleState: 'generated',
    createdAt: '2026-05-01T10:00:00Z',
    updatedAt: '2026-05-02T10:00:00Z',
    model: 'test-model',
    projectId,
    pinned: false,
    webSearchEnabled: true,
    messageCount: 2,
    activeRun: null,
    contextUsage: null,
  }
}

async function exported(source: Awaited<ReturnType<typeof collectChatExport>>) {
  const archive = await buildChatExport(
    source.chats,
    source.fetchAttachmentBytes,
  )
  if (typeof archive.data === 'string')
    return {
      conversations: JSON.parse(archive.data),
      entries: {} as Record<string, Uint8Array>,
      archive,
    }
  const entries = unzipSync(archive.data)
  return {
    conversations: JSON.parse(strFromU8(entries['conversations.json'])),
    manifest: JSON.parse(strFromU8(entries['manifest.json'])),
    entries,
    archive,
  }
}

resetChatStoresAroundEachTest()

describe('collecting chats for an export', () => {
  it("writes this device's chats in the previous client's export format", async () => {
    const api = signIn()
    await localThreadStore('device').update(LOCAL_ID, () => deviceChat)

    const source = await collectChatExport(api, {
      cloud: false,
      signal: new AbortController().signal,
    })
    const { conversations, manifest, entries, archive } = await exported(source)

    expect(source.chats.map((chat) => [chat.id, chat.isLocalOnly])).toEqual([
      [LOCAL_ID, true],
    ])
    expect(archive.filename).toBe('tinfoil-chats.zip')
    expect(conversations).toEqual([deviceConversation])
    expect(entries['attachments/photo-1/bed.png']).toEqual(IMAGE)
    expect(manifest).toMatchObject({
      chat_count: 1,
      attachment_count: 1,
      warnings: [],
    })
    expect(client.post).not.toHaveBeenCalled()
    expect(client.download).not.toHaveBeenCalled()
  })

  it("exports a signed-out visitor's chats from this tab", async () => {
    const api = signIn({ userId: null })
    await localThreadStore('tab').update(LOCAL_ID, () => ({
      ...deviceChat,
      messages: [deviceChat.messages[1]],
    }))
    await localThreadStore('device').update('other', () => ({
      ...deviceChat,
      id: 'other',
    }))

    const { conversations, archive } = await exported(
      await collectChatExport(api, {
        cloud: false,
        signal: new AbortController().signal,
      }),
    )

    expect(archive.filename).toBe('conversations.json')
    expect(conversations).toEqual([
      {
        ...deviceConversation,
        chat_messages: [
          { ...deviceConversation.chat_messages[1], uuid: `${LOCAL_ID}_msg_0` },
        ],
      },
    ])
  })

  it('adds the stored chats with cloud sync, read through their transcripts', async () => {
    const api = signIn({ cloud: true })
    await localThreadStore('device').update(LOCAL_ID, () => deviceChat)
    const pages: Record<string, unknown> = {
      first: {
        threads: [summary('cloud-1', 'Trip', 'project-1')],
        nextCursor: 'next',
      },
      next: { threads: [summary('cloud-2', 'Recipes')], nextCursor: null },
    }
    client.post.mockImplementation(async (path: string, input) => {
      const request = input as { cursor?: string; threadId?: string }
      if (path === '/v1/threads/list') return pages[request.cursor ?? 'first']
      if (path === '/v1/threads/transcript')
        return {
          thread: {
            id: request.threadId,
            title: request.threadId === 'cloud-1' ? 'Trip' : 'Recipes',
            createdAt: '2026-05-01T10:00:00Z',
            updatedAt: '2026-05-02T10:00:00Z',
            messages: [
              {
                id: 'q',
                role: 'user',
                createdAt: '2026-05-01T10:00:01Z',
                content: `About ${request.threadId}`,
                attachments:
                  request.threadId === 'cloud-2'
                    ? [
                        {
                          id: 'c'.repeat(36),
                          type: 'image',
                          fileName: 'cake.png',
                          mimeType: 'image/png',
                          base64: IMAGE_BASE64,
                        },
                      ]
                    : [],
              },
              {
                id: 'r',
                role: 'assistant',
                createdAt: '2026-05-01T10:00:02Z',
                content: 'Sure.',
                thoughts: 'stored',
                timeline: [{ id: 'r-c', type: 'content', content: 'Sure.' }],
              },
            ],
          },
        }
      throw new Error(`Unexpected ${path}`)
    })

    const source = await collectChatExport(api, {
      cloud: true,
      signal: new AbortController().signal,
    })
    const { conversations, entries } = await exported(source)

    expect(
      client.post.mock.calls.map(([path, input]) => [path, input]),
    ).toEqual([
      ['/v1/threads/list', { key: KEY, cursor: undefined, limit: 100 }],
      ['/v1/threads/list', { key: KEY, cursor: 'next', limit: 100 }],
      ['/v1/threads/transcript', { key: KEY, threadId: 'cloud-1' }],
      ['/v1/threads/transcript', { key: KEY, threadId: 'cloud-2' }],
    ])
    expect(client.download).not.toHaveBeenCalled()
    expect(
      source.chats.map((chat) => [chat.id, chat.isLocalOnly, chat.projectId]),
    ).toEqual([
      [LOCAL_ID, true, undefined],
      ['cloud-1', false, 'project-1'],
      ['cloud-2', false, undefined],
    ])
    expect(conversations.slice(1)).toEqual([
      {
        uuid: 'cloud-1',
        name: 'Trip',
        created_at: '2026-05-01T10:00:00.000Z',
        updated_at: '2026-05-02T10:00:00.000Z',
        projectId: 'project-1',
        chat_messages: [
          {
            uuid: 'cloud-1_msg_0',
            text: 'About cloud-1',
            sender: 'human',
            created_at: '2026-05-01T10:00:01.000Z',
          },
          {
            uuid: 'cloud-1_msg_1',
            text: 'Sure.',
            sender: 'assistant',
            created_at: '2026-05-01T10:00:02.000Z',
          },
        ],
      },
      expect.objectContaining({ uuid: 'cloud-2' }),
    ])
    expect(conversations[2].chat_messages[0].attachments).toEqual([
      {
        id: 'c'.repeat(36),
        type: 'image',
        fileName: 'cake.png',
        mimeType: 'image/png',
        fileSize: IMAGE.length,
        exportPath: `attachments/${'c'.repeat(36)}/cake.png`,
      },
    ])
    expect(entries[`attachments/${'c'.repeat(36)}/cake.png`]).toEqual(IMAGE)
    expect(entries['attachments/photo-1/bed.png']).toEqual(IMAGE)
  })

  it('reads a chat whose transcript is refused through its messages and attachments', async () => {
    const api = signIn({ cloud: true })
    const refused = new HarnessError(
      { code: 'ATTACHMENTS_UNAVAILABLE', message: '1 attachments' },
      409,
    )
    const view = (id: string, kind: string, fileName: string) => ({
      id,
      kind,
      fileName,
      mimeType: kind === 'image' ? 'image/png' : 'text/plain',
      size: 3,
      thumbnail: kind === 'image' ? 'dGh1bWI=' : null,
      pages: null,
      status: 'ready',
    })
    client.post.mockImplementation(async (path: string, input) => {
      const request = input as { before?: string }
      if (path === '/v1/threads/list')
        return { threads: [summary('cloud-1', 'Trip')], nextCursor: null }
      if (path === '/v1/threads/transcript') throw refused
      if (path === '/v1/threads/get')
        return request.before
          ? {
              ...summary('cloud-1', 'Trip'),
              hasOlder: false,
              messages: [
                {
                  id: 'q1',
                  role: 'user',
                  createdAt: '2026-05-01T10:00:01Z',
                  content: 'Older',
                  attachments: [view('kept', 'image', 'kept.png')],
                },
              ],
            }
          : {
              ...summary('cloud-1', 'Trip'),
              hasOlder: true,
              messages: [
                {
                  id: 'q2',
                  role: 'user',
                  createdAt: '2026-05-01T10:00:03Z',
                  content: 'Newer',
                  attachments: [
                    view('lost', 'image', 'lost.png'),
                    view('notes', 'document', 'notes.txt'),
                  ],
                },
                {
                  id: 'r2',
                  role: 'assistant',
                  createdAt: '2026-05-01T10:00:04Z',
                  timeline: [
                    { id: 'r2-t', type: 'thinking', content: 'Hmm' },
                    { id: 'r2-c', type: 'content', content: 'Done' },
                  ],
                },
              ],
            }
      throw new Error(`Unexpected ${path}`)
    })
    client.download.mockImplementation(async (path: string, input) => {
      const { id } = input as { id: string }
      if (path !== '/v1/attachments/get') throw new Error(`Unexpected ${path}`)
      if (id === 'kept') return new Blob([IMAGE])
      if (id === 'notes') return new Blob(['Remember the passports'])
      throw new HarnessError({ code: 'THREAD_NOT_FOUND', message: 'Gone' }, 404)
    })

    const { conversations, manifest, entries } = await exported(
      await collectChatExport(api, {
        cloud: true,
        signal: new AbortController().signal,
      }),
    )

    expect(
      client.post.mock.calls
        .filter(([path]) => path === '/v1/threads/get')
        .map(([, input]) => input),
    ).toEqual([
      { key: KEY, id: 'cloud-1', limit: 200 },
      { key: KEY, id: 'cloud-1', before: 'q2', limit: 200 },
    ])
    expect(
      client.download.mock.calls.map(([path, input]) => [path, input]),
    ).toEqual([
      ['/v1/attachments/get', { key: KEY, id: 'kept', threadId: 'cloud-1' }],
      ['/v1/attachments/get', { key: KEY, id: 'lost', threadId: 'cloud-1' }],
      ['/v1/attachments/get', { key: KEY, id: 'notes', threadId: 'cloud-1' }],
    ])
    expect(conversations).toEqual([
      {
        uuid: 'cloud-1',
        name: 'Trip',
        created_at: '2026-05-01T10:00:00.000Z',
        updated_at: '2026-05-02T10:00:00.000Z',
        chat_messages: [
          {
            uuid: 'cloud-1_msg_0',
            text: 'Older',
            sender: 'human',
            created_at: '2026-05-01T10:00:01.000Z',
            attachments: [
              {
                id: 'kept',
                type: 'image',
                fileName: 'kept.png',
                mimeType: 'image/png',
                fileSize: IMAGE.length,
                exportPath: 'attachments/kept/kept.png',
              },
            ],
          },
          {
            uuid: 'cloud-1_msg_1',
            text: 'Newer',
            sender: 'human',
            created_at: '2026-05-01T10:00:03.000Z',
            attachments: [
              {
                id: 'lost',
                type: 'image',
                fileName: 'lost.png',
                mimeType: 'image/png',
                fileSize: 3,
              },
              {
                id: 'notes',
                type: 'document',
                fileName: 'notes.txt',
                mimeType: 'text/plain',
                fileSize: 3,
                textContent: 'Remember the passports',
              },
            ],
          },
          {
            uuid: 'cloud-1_msg_2',
            text: 'Done',
            sender: 'assistant',
            created_at: '2026-05-01T10:00:04.000Z',
            content: [{ type: 'thinking', thinking: 'Hmm' }],
          },
        ],
      },
    ])
    expect(entries['attachments/kept/kept.png']).toEqual(IMAGE)
    expect(manifest.warnings).toEqual(['Could not fetch attachment lost'])
  })

  it('fails when a stored chat cannot be read at all', async () => {
    const api = signIn({ cloud: true })
    const failure = new HarnessError(
      { code: 'UPSTREAM_REFUSED', message: 'Sync is unavailable' },
      503,
    )
    client.post.mockImplementation(async (path: string) => {
      if (path === '/v1/threads/list')
        return { threads: [summary('cloud-1', 'Trip')], nextCursor: null }
      if (path === '/v1/threads/transcript') throw failure
      throw new Error(`Unexpected ${path}`)
    })

    await expect(
      collectChatExport(api, {
        cloud: true,
        signal: new AbortController().signal,
      }),
    ).rejects.toBe(failure)
  })
})
