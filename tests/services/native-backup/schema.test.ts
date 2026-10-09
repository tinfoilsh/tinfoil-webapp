import {
  NativeBackupChatSchema,
  classifyNativeBackupChat,
  sanitizeNativeBackupChat,
  sanitizeNativeBackupImage,
  sanitizeNativeBackupProject,
  sanitizeNativeBackupProjectDocument,
  sanitizeNativeBackupRelationships,
} from '@/services/native-backup'
import fixture from '../../fixtures/native-backup-schema-v1.json'

function sanitizedFixture() {
  const candidates: unknown[] = []
  const chat = sanitizeNativeBackupChat(fixture.chat, (candidate) => {
    candidates.push(candidate)
    return `image-${candidates.length}`
  })
  return {
    project: sanitizeNativeBackupProject(fixture.project),
    document: sanitizeNativeBackupProjectDocument(fixture.document),
    chat,
    relationships: sanitizeNativeBackupRelationships(fixture.relationships),
    image: sanitizeNativeBackupImage(fixture.image),
    candidates,
  }
}

describe('native backup v1 schema', () => {
  it('preserves semantic fields while stripping secrets and transient state', () => {
    const output = sanitizedFixture()

    expect(output.project).toMatchObject({
      color: 'teal',
      memory: [{ confidence: 0.9 }],
    })
    expect(output.document.extractedText).toBe('Extracted paper text')
    expect(output.chat).toMatchObject({
      presetId: 'preset-1',
      messages: [
        {
          thoughts: 'Compare sources',
          isError: true,
          webSearchBeforeThinking: true,
          quote: 'What supports this?',
          annotations: [{ url_citation: { title: 'Source' } }],
          attachments: [
            { type: 'image', imageId: 'image-1' },
            { type: 'document', pages: [{ imageId: 'image-2' }] },
          ],
          imageData: [{ imageId: 'image-3', mimeType: 'image/webp' }],
        },
      ],
    })
    expect(output.relationships.projectChats).toEqual([
      { projectId: 'project-1', chatId: 'chat-1' },
    ])
    expect(output.image).toMatchObject({
      fileName: 'chart.png',
      sizeBytes: 1234,
    })
    expect(output.candidates).toHaveLength(3)
    const serialized = JSON.stringify(output)
    for (const secret of fixture.forbiddenValues)
      expect(serialized).not.toContain(secret)
  })

  it('carries trace timing stamps through sanitize and the strict schema', () => {
    const chat = sanitizedFixture().chat
    expect(chat.messages[0].timeline?.[0]).toEqual({
      type: 'thinking',
      id: 'thinking-1',
      content: 'Inspect evidence',
      isThinking: false,
      duration: 1.5,
      startedAt: 1770000000000,
      endedAt: 1770000001500,
    })
    expect(() => NativeBackupChatSchema.parse(chat)).not.toThrow()
  })

  it('preserves arbitrary JSON only in tool arguments and resolution data', () => {
    const message = sanitizedFixture().chat.messages[0]

    expect(message.timeline?.[1]).toMatchObject({
      resolution: { data: { nested: { custom_key: [1, true, null] } } },
    })
    expect(message.codeExecCalls?.[0].arguments).toEqual({
      code: 'print(1)',
      options: { precision: 2 },
    })
    expect(JSON.stringify(message)).not.toContain('resolution-token')
  })

  it('rejects malformed nested records and unknown portable fields', () => {
    const malformed = structuredClone(fixture.chat)
    malformed.messages[0].annotations[0].url_citation.url =
      42 as unknown as string
    expect(() => sanitizeNativeBackupChat(malformed, () => 'image')).toThrow()
    expect(() =>
      NativeBackupChatSchema.parse({
        ...sanitizedFixture().chat,
        accessToken: 'secret',
      }),
    ).toThrow()
    expect(() =>
      sanitizeNativeBackupRelationships({
        ...fixture.relationships,
        chatImages: {},
      }),
    ).toThrow('collections must be arrays')
    expect(() =>
      sanitizeNativeBackupChat(
        { ...fixture.chat, createdAt: null },
        () => 'image',
      ),
    ).toThrow('Invalid backup timestamp')
    expect(() =>
      NativeBackupChatSchema.parse({
        ...sanitizedFixture().chat,
        messages: [
          {
            ...sanitizedFixture().chat.messages[0],
            timeline: [
              {
                type: 'tool_call',
                id: 'call',
                toolCallId: 'call',
                name: 'tool',
                arguments: '{}',
                resolvedAt: Number.POSITIVE_INFINITY,
              },
            ],
          },
        ],
      }),
    ).toThrow()
  })

  it('preserves nullable projects and distinct image occurrences', () => {
    const candidates: Array<{ sourceKey: string }> = []
    const chat = sanitizeNativeBackupChat(
      {
        ...fixture.chat,
        projectId: null,
        messages: [
          {
            ...fixture.chat.messages[0],
            attachments: [
              {
                id: 'shared:id',
                type: 'image',
                fileName: 'first.png',
                mimeType: 'image/png',
                fileSize: 123,
              },
              {
                id: 'shared:id',
                type: 'image',
                fileName: 'second.png',
                mimeType: 'image/png',
              },
            ],
            imageData: [],
          },
        ],
      },
      (candidate) => {
        candidates.push(candidate)
        return `image-${candidates.length}`
      },
    )

    expect(chat.projectId).toBeNull()
    expect(candidates[0].sourceKey).not.toBe(candidates[1].sourceKey)
  })

  it('accepts only supported image types', () => {
    expect(() =>
      sanitizeNativeBackupImage({ ...fixture.image, mimeType: 'image/avif' }),
    ).toThrow()
  })

  it('classifies only eligible signed-in local chats', () => {
    expect(classifyNativeBackupChat(fixture.chat, 'cloud')).toBe('cloud')
    expect(classifyNativeBackupChat(fixture.chat, 'signed_in')).toBe('local')
    expect(classifyNativeBackupChat(fixture.chat, 'anonymous')).toBeNull()
    expect(
      classifyNativeBackupChat(
        { ...fixture.chat, isTemporary: true },
        'signed_in',
      ),
    ).toBeNull()
    expect(
      classifyNativeBackupChat(
        { ...fixture.chat, isBlankChat: true },
        'signed_in',
      ),
    ).toBeNull()
  })
})
