import type { Attachment, Chat, Message } from '@/components/chat/types'
import { FORK_TITLE_SUFFIX } from '@/constants/chat'
import { buildForkedChat } from '@/services/storage/chat-fork'
import { describe, expect, it } from 'vitest'

const createChat = (overrides: Partial<Chat> = {}): Chat => ({
  id: 'chat-1',
  title: 'Chat',
  messages: [],
  createdAt: new Date(),
  ...overrides,
})

describe('buildForkedChat', () => {
  const messages: Message[] = [
    {
      role: 'user',
      content: 'Here is a photo',
      turnId: 't1',
      timestamp: new Date('2026-01-01T00:00:00Z'),
      attachments: [
        {
          id: 'att-image',
          type: 'image',
          fileName: 'a.png',
          mimeType: 'image/png',
          base64: 'IMAGEBYTES',
          encryptionKey: 'server-key',
          storagePayloadId: 'chat-source:att-image',
        } as Attachment,
        {
          id: 'att-doc',
          type: 'document',
          fileName: 'notes.txt',
          textContent: 'hello',
        },
      ],
    },
    {
      role: 'assistant',
      content: 'Nice photo',
      turnId: 't1',
      timestamp: new Date('2026-01-01T00:00:01Z'),
      thoughts: 'looking',
    },
    {
      role: 'user',
      content: 'Second question',
      turnId: 't2',
      timestamp: new Date('2026-01-01T00:00:02Z'),
    },
  ]

  const source = createChat({
    id: 'chat-source',
    title: 'Trip planning',
    titleState: 'generated',
    messages,
    createdAt: new Date('2025-12-31T00:00:00Z'),
    updatedAt: '2026-01-02T00:00:00.000Z',
    isLocalOnly: true,
    projectId: 'project-1',
    presetId: 'preset-1',
    model: 'gpt-oss-120b',
    webSearchEnabled: false,
    syncedAt: 123,
    locallyModified: true,
    pendingRecoveries: [{ turnId: 't1' } as never],
    codeExecutionAccessToken: 'secret',
    messageCount: 3,
  })

  it('keeps the leading messages and conversation settings under a new identity', () => {
    const fork = buildForkedChat(source, 2, 'chat-fork')

    expect(fork.id).toBe('chat-fork')
    expect(fork.title).toBe(`Trip planning${FORK_TITLE_SUFFIX}`)
    expect(fork.titleState).toBe('manual')
    expect(fork.messages.map((m) => m.content)).toEqual([
      'Here is a photo',
      'Nice photo',
    ])
    expect(fork.messages[1].thoughts).toBe('looking')
    expect(fork).toMatchObject({
      isLocalOnly: true,
      projectId: 'project-1',
      presetId: 'preset-1',
      model: 'gpt-oss-120b',
      webSearchEnabled: false,
      isBlankChat: false,
    })
    expect(fork.createdAt.getTime()).toBeGreaterThan(source.createdAt.getTime())
    for (const field of [
      'updatedAt',
      'syncedAt',
      'locallyModified',
      'pendingRecoveries',
      'codeExecutionAccessToken',
      'messageCount',
    ]) {
      expect(fork).not.toHaveProperty(field)
    }
  })

  it('gives attachments fresh ids and detaches them from source storage', () => {
    const fork = buildForkedChat(source, 1, 'chat-fork')
    const [image, document] = fork.messages[0].attachments!

    expect(image.id).not.toBe('att-image')
    expect(image).toMatchObject({
      type: 'image',
      fileName: 'a.png',
      base64: 'IMAGEBYTES',
    })
    expect(image).not.toHaveProperty('encryptionKey')
    expect(image).not.toHaveProperty('storagePayloadId')
    expect(document.id).not.toBe('att-doc')
    expect(document.textContent).toBe('hello')
    expect(source.messages[0].attachments![0].id).toBe('att-image')
  })

  it('rejects a fork point outside the conversation', () => {
    expect(() => buildForkedChat(source, 0, 'chat-fork')).toThrow(RangeError)
    expect(() => buildForkedChat(source, 4, 'chat-fork')).toThrow(RangeError)
  })
})
