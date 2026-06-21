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
})

describe('sanitizeFilename', () => {
  it('strips path separators and control characters', () => {
    expect(sanitizeFilename('../../etc/passwd', 'fallback')).toBe('passwd')
    expect(sanitizeFilename('a/b/c.png', 'fallback')).toBe('c.png')
    expect(sanitizeFilename('', 'fallback.bin')).toBe('fallback.bin')
    expect(sanitizeFilename('', '../fallback.bin')).toBe('fallback.bin')
  })
})
