import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'

import { parseLocalTinfoilExport } from '@/services/chat-import/local-tinfoil-import'

const options = {
  generateChatId: () => 'imported-chat',
  isCloudSyncEnabled: false,
}

function conversation(attachments?: unknown[]) {
  return [
    {
      uuid: 'original-chat',
      name: 'Portable chat',
      created_at: '2025-01-01T10:00:00.000Z',
      updated_at: '2025-01-01T11:00:00.000Z',
      chat_messages: [
        {
          uuid: 'message-1',
          text: 'Hello from another device',
          sender: 'human',
          created_at: '2025-01-01T10:00:00.000Z',
          attachments,
        },
      ],
    },
  ]
}

describe('parseLocalTinfoilExport', () => {
  it('imports conversations.json as local-only chats', async () => {
    const file = new File(
      [JSON.stringify(conversation())],
      'conversations.json',
    )

    const chats = await parseLocalTinfoilExport(file, options)

    expect(chats).toHaveLength(1)
    expect(chats[0]).toMatchObject({
      id: 'imported-chat',
      title: 'Portable chat',
      isLocalOnly: true,
      updatedAt: '2025-01-01T11:00:00.000Z',
    })
    expect(chats[0].messages[0]).toMatchObject({
      role: 'user',
      content: 'Hello from another device',
    })
  })

  it('marks chats as syncable when cloud sync is enabled', async () => {
    const file = new File(
      [JSON.stringify(conversation())],
      'conversations.json',
    )

    const chats = await parseLocalTinfoilExport(file, {
      ...options,
      isCloudSyncEnabled: true,
    })

    expect(chats).toHaveLength(1)
    expect(chats[0].isLocalOnly).toBe(false)
  })

  it('drops project associations that local import cannot restore', async () => {
    const data = conversation()
    ;(data[0] as Record<string, unknown>).projectId = 'project-123'
    const file = new File([JSON.stringify(data)], 'conversations.json')

    const chats = await parseLocalTinfoilExport(file, options)

    expect(chats).toHaveLength(1)
    expect(chats[0].projectId).toBeUndefined()
  })

  it('keeps attachment-only messages with empty text', async () => {
    const data = conversation([
      {
        id: 'doc-1',
        type: 'document',
        fileName: 'notes.md',
        textContent: 'Attached notes',
      },
    ])
    data[0].chat_messages[0].text = ''
    const file = new File([JSON.stringify(data)], 'conversations.json')

    const chats = await parseLocalTinfoilExport(file, options)

    expect(chats).toHaveLength(1)
    expect(chats[0].messages).toHaveLength(1)
    expect(chats[0].messages[0].content).toBe('')
    expect(chats[0].messages[0].attachments).toMatchObject([
      { id: 'doc-1', type: 'document', fileName: 'notes.md' },
    ])
  })

  it('restores attachment bytes from a Tinfoil ZIP export', async () => {
    const imageBytes = new Uint8Array([1, 2, 3, 4])
    const archive = zipSync({
      'conversations.json': strToU8(
        JSON.stringify(
          conversation([
            {
              id: 'image-1',
              type: 'image',
              fileName: 'photo.png',
              mimeType: 'image/png',
              exportPath: 'attachments/image-1/photo.png',
            },
          ]),
        ),
      ),
      'attachments/image-1/photo.png': imageBytes,
    })
    const file = new File([archive], 'tinfoil-chats.zip', {
      type: 'application/zip',
    })

    const chats = await parseLocalTinfoilExport(file, options)

    expect(chats[0].messages[0].attachments).toEqual([
      {
        id: 'image-1',
        type: 'image',
        fileName: 'photo.png',
        mimeType: 'image/png',
        fileSize: 4,
        textContent: undefined,
        base64: 'AQIDBA==',
      },
    ])
  })

  it('rejects ZIP exports with missing attachment entries', async () => {
    const archive = zipSync({
      'conversations.json': strToU8(
        JSON.stringify(
          conversation([
            {
              id: 'image-1',
              type: 'image',
              fileName: 'photo.png',
              exportPath: 'attachments/image-1/photo.png',
            },
          ]),
        ),
      ),
    })
    const file = new File([archive], 'tinfoil-chats.zip', {
      type: 'application/zip',
    })

    await expect(parseLocalTinfoilExport(file, options)).rejects.toThrow(
      'The export is missing attachments/image-1/photo.png',
    )
  })
})
