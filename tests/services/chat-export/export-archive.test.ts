import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'

import type { Chat } from '@/components/chat/types'
import {
  buildChatExport,
  sanitizeFilename,
} from '@/services/chat-export/export-archive'

function chat(overrides: Partial<Chat>): Chat {
  return {
    id: 'chat-1',
    title: 'Test',
    messages: [],
    createdAt: new Date('2023-11-14T22:13:20.000Z'),
    ...overrides,
  }
}

describe('buildChatExport', () => {
  it('returns plain conversations.json when there are no binary attachments', async () => {
    const chats = [
      chat({
        updatedAt: '2023-11-15T22:13:20.000Z',
        messages: [
          {
            role: 'user',
            content: 'hello',
            timestamp: new Date('2023-11-14T22:13:21.000Z'),
          },
        ],
      }),
    ]

    const result = await buildChatExport(chats, async () => null)

    expect(result.isZip).toBe(false)
    expect(result.filename).toBe('conversations.json')
    const parsed = JSON.parse(result.data as string)
    expect(parsed[0].uuid).toBe('chat-1')
    expect(parsed[0].updated_at).toBe('2023-11-15T22:13:20.000Z')
    expect(parsed[0].chat_messages[0].sender).toBe('human')
  })

  it('keeps document text inline without forcing a zip', async () => {
    const chats = [
      chat({
        messages: [
          {
            role: 'user',
            content: 'read this',
            timestamp: new Date('2023-11-14T22:13:21.000Z'),
            attachments: [
              {
                id: 'doc-1',
                type: 'document',
                fileName: 'spec.txt',
                textContent: 'the contents',
              },
            ],
          },
        ],
      }),
    ]

    const result = await buildChatExport(chats, async () => null)

    expect(result.isZip).toBe(false)
    const parsed = JSON.parse(result.data as string)
    const att = parsed[0].chat_messages[0].attachments[0]
    expect(att.type).toBe('document')
    expect(att.textContent).toBe('the contents')
  })

  it('exports page-backed documents with inline text', async () => {
    const chats = [
      chat({
        messages: [
          {
            role: 'user',
            content: 'read this',
            timestamp: new Date('2023-11-14T22:13:21.000Z'),
            attachments: [
              {
                id: 'doc-1',
                type: 'document',
                fileName: 'scan.pdf',
                pages: [
                  {
                    page: 1,
                    text: 'first page',
                    image: 'page-one',
                    is_scanned: true,
                  },
                  {
                    page: 2,
                    text: 'second page',
                    image: 'page-two',
                    is_scanned: true,
                  },
                ],
              },
            ],
          },
        ],
      }),
    ]

    const result = await buildChatExport(chats, async () => null)
    const parsed = JSON.parse(result.data as string)
    const att = parsed[0].chat_messages[0].attachments[0]

    expect(att.textContent).toBe('first page\n\n---\n\nsecond page')
  })

  it('produces a zip with attachments, manifest, and no key leakage', async () => {
    const imageBytes = new Uint8Array([1, 2, 3, 4, 5])
    const chats = [
      chat({
        messages: [
          {
            role: 'user',
            content: 'see pic',
            timestamp: new Date('2023-11-14T22:13:21.000Z'),
            attachments: [
              {
                id: 'img-1',
                type: 'image',
                fileName: 'pic.png',
                mimeType: 'image/png',
                encryptionKey: 'SECRET_KEY_MATERIAL',
                base64: 'AAAA',
              },
            ],
          },
        ],
      }),
    ]

    const result = await buildChatExport(chats, async () => imageBytes)

    expect(result.isZip).toBe(true)
    expect(result.filename).toBe('tinfoil-chats.zip')

    const entries = unzipSync(result.data as Uint8Array)
    expect(Object.keys(entries)).toContain('conversations.json')
    expect(Object.keys(entries)).toContain('manifest.json')
    expect(Object.keys(entries)).toContain('attachments/img-1/pic.png')
    expect(entries['attachments/img-1/pic.png']).toEqual(imageBytes)

    const conversationsText = strFromU8(entries['conversations.json'])
    expect(conversationsText).not.toContain('SECRET_KEY_MATERIAL')
    expect(conversationsText).not.toContain('encryptionKey')
    expect(conversationsText).not.toContain('"base64"')

    const conversations = JSON.parse(conversationsText)
    const att = conversations[0].chat_messages[0].attachments[0]
    expect(att.exportPath).toBe('attachments/img-1/pic.png')
    expect(att.type).toBe('image')

    const manifest = JSON.parse(strFromU8(entries['manifest.json']))
    expect(manifest.attachment_count).toBe(1)
    expect(manifest.attachments[0].exportPath).toBe('attachments/img-1/pic.png')
    expect(manifest.attachments[0].fileSize).toBe(5)
  })

  it('records a warning and continues when an attachment cannot be fetched', async () => {
    const chats = [
      chat({
        messages: [
          {
            role: 'user',
            content: 'see pic',
            timestamp: new Date('2023-11-14T22:13:21.000Z'),
            attachments: [{ id: 'img-1', type: 'image', fileName: 'pic.png' }],
          },
        ],
      }),
    ]

    const result = await buildChatExport(chats, async () => null)

    expect(result.isZip).toBe(true)
    expect(result.warnings.length).toBe(1)
    const entries = unzipSync(result.data as Uint8Array)
    expect(Object.keys(entries)).not.toContain('attachments/img-1/pic.png')
    const conversations = JSON.parse(strFromU8(entries['conversations.json']))
    const att = conversations[0].chat_messages[0].attachments[0]
    expect(att.exportPath).toBeUndefined()
  })

  it('sanitizes attachment IDs before using them in zip paths', async () => {
    const imageBytes = new Uint8Array([1, 2, 3])
    const chats = [
      chat({
        messages: [
          {
            role: 'user',
            content: 'see pic',
            timestamp: new Date('2023-11-14T22:13:21.000Z'),
            attachments: [
              {
                id: '../evil/id',
                type: 'image',
                fileName: '',
              },
            ],
          },
        ],
      }),
    ]

    const result = await buildChatExport(chats, async () => imageBytes)
    const entries = unzipSync(result.data as Uint8Array)

    expect(Object.keys(entries)).toContain('attachments/id/id.bin')
    expect(Object.keys(entries)).not.toContain('attachments/../evil/id/id.bin')

    const conversations = JSON.parse(strFromU8(entries['conversations.json']))
    const att = conversations[0].chat_messages[0].attachments[0]
    expect(att.id).toBe('../evil/id')
    expect(att.exportPath).toBe('attachments/id/id.bin')

    const manifest = JSON.parse(strFromU8(entries['manifest.json']))
    expect(manifest.attachments[0].exportPath).toBe('attachments/id/id.bin')
  })

  it('keeps colliding sanitized attachment paths distinct', async () => {
    const firstBytes = new Uint8Array([1, 2, 3])
    const secondBytes = new Uint8Array([4, 5, 6])
    const chats = [
      chat({
        messages: [
          {
            role: 'user',
            content: 'see pics',
            timestamp: new Date('2023-11-14T22:13:21.000Z'),
            attachments: [
              {
                id: '../same/id',
                type: 'image',
                fileName: 'pic.png',
              },
              {
                id: 'id',
                type: 'image',
                fileName: 'pic.png',
              },
            ],
          },
        ],
      }),
    ]

    const result = await buildChatExport(chats, async (att) =>
      att.id === '../same/id' ? firstBytes : secondBytes,
    )
    const entries = unzipSync(result.data as Uint8Array)

    expect(entries['attachments/id/pic.png']).toEqual(firstBytes)
    expect(entries['attachments/id/pic-2.png']).toEqual(secondBytes)

    const conversations = JSON.parse(strFromU8(entries['conversations.json']))
    expect(conversations[0].chat_messages[0].attachments[0].exportPath).toBe(
      'attachments/id/pic.png',
    )
    expect(conversations[0].chat_messages[0].attachments[1].exportPath).toBe(
      'attachments/id/pic-2.png',
    )
  })

  it('reads the text of a document the chat carries without its content', async () => {
    const synced = chat({
      id: 'synced-chat',
      messages: [
        {
          role: 'user',
          content: 'summarize',
          timestamp: new Date('2023-11-14T22:13:21.000Z'),
          attachments: [
            { id: 'doc-1', type: 'document', fileName: 'notes.md' },
            {
              id: 'doc-2',
              type: 'document',
              fileName: 'inline.txt',
              textContent: 'already here',
            },
          ],
        },
      ],
    })
    const fetched: [string, string][] = []

    const result = await buildChatExport([synced], async (att, owner) => {
      fetched.push([att.id, owner.id])
      return new TextEncoder().encode('fetched text')
    })

    expect(fetched).toEqual([['doc-1', 'synced-chat']])
    expect(result.isZip).toBe(false)
    expect(result.warnings).toEqual([])
    const parsed = JSON.parse(result.data as string)
    expect(parsed[0].chat_messages[0].attachments).toEqual([
      {
        id: 'doc-1',
        type: 'document',
        fileName: 'notes.md',
        textContent: 'fetched text',
      },
      {
        id: 'doc-2',
        type: 'document',
        fileName: 'inline.txt',
        textContent: 'already here',
      },
    ])
  })

  it('keeps a document whose text cannot be read and records a warning', async () => {
    const chats = [
      chat({
        messages: [
          {
            role: 'user',
            content: 'see both',
            timestamp: new Date('2023-11-14T22:13:21.000Z'),
            attachments: [
              { id: 'img-1', type: 'image', fileName: 'pic.png' },
              { id: 'doc-gone', type: 'document', fileName: 'gone.pdf' },
              { id: 'doc-bad', type: 'document', fileName: 'bad.txt' },
            ],
          },
        ],
      }),
    ]

    const result = await buildChatExport(chats, async (att) =>
      att.id === 'img-1'
        ? new Uint8Array([1, 2])
        : att.id === 'doc-bad'
          ? new Uint8Array([0xff, 0xfe])
          : null,
    )

    expect(result.warnings).toEqual([
      'Could not fetch document doc-gone',
      'Could not read document doc-bad',
    ])
    const entries = unzipSync(result.data as Uint8Array)
    const manifest = JSON.parse(strFromU8(entries['manifest.json']))
    expect(manifest.warnings).toEqual(result.warnings)
    const conversations = JSON.parse(strFromU8(entries['conversations.json']))
    expect(conversations[0].chat_messages[0].attachments.slice(1)).toEqual([
      { id: 'doc-gone', type: 'document', fileName: 'gone.pdf' },
      { id: 'doc-bad', type: 'document', fileName: 'bad.txt' },
    ])
  })
})

describe('sanitizeFilename', () => {
  it('strips path separators and control characters', () => {
    expect(sanitizeFilename('../../etc/passwd', 'fallback')).toBe('passwd')
    expect(sanitizeFilename('a/b/c.png', 'fallback')).toBe('c.png')
    expect(sanitizeFilename('', 'fallback.bin')).toBe('fallback.bin')
    expect(sanitizeFilename('', '../fallback.bin')).toBe('fallback.bin')
    expect(sanitizeFilename('folder\\photo.png', 'fallback')).toBe('photo.png')
    expect(sanitizeFilename('a\u0000b\u007f.png', 'fallback')).toBe('ab.png')
    expect(sanitizeFilename('...photo.png', 'fallback')).toBe('photo.png')
    expect(sanitizeFilename('...', '..\\safe.png')).toBe('safe.png')
    expect(sanitizeFilename('...', '\u0000')).toBe('file')
  })
})
