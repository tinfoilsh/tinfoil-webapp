import {
  NATIVE_BACKUP_LIMITS,
  assertNativeBackupSizeLimits,
  formatNativeBackupV1,
  formatNativeBackupV2,
  parseNativeBackupManifest,
  validateAndPackageNativeBackup,
  type NativeBackupFormatInput,
  type NativeBackupManifestV1,
} from '@/services/native-backup'
import { zipSync } from 'fflate'
import goldenManifest from '../../fixtures/native-backup-manifest-v1.json'

const timestamp = '2026-08-20T12:00:00.000Z'

type MutableInput = {
  [
    K in keyof NativeBackupFormatInput
  ]: NativeBackupFormatInput[K] extends readonly (infer T)[]
    ? T[]
    : NativeBackupFormatInput[K]
}

function archive(formatted: ReturnType<typeof formatNativeBackupV1>): File {
  return new File(
    [
      zipSync(
        Object.fromEntries([
          ['manifest.json', formatted.manifestBytes],
          ...formatted.files.map(({ path, bytes }) => [path, bytes]),
        ]),
      ),
    ],
    'backup.zip',
    { type: 'application/zip' },
  )
}

function input(): MutableInput {
  return {
    backupId: '123e4567-e89b-42d3-a456-426614174000',
    createdAt: timestamp,
    projects: [
      {
        id: 'p',
        name: 'P',
        description: '',
        systemInstructions: '',
        memory: [],
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    projectDocuments: [
      {
        id: 'd',
        projectId: 'p',
        filename: 'paper.pdf',
        contentType: 'application/pdf',
        sizeBytes: 10,
        extractedText: 'text',
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    cloudChats: [
      {
        id: 'c',
        title: 'Cloud',
        messages: [
          {
            role: 'user',
            content: 'hello',
            attachments: [{ id: 'a', type: 'image', imageId: 'i' }],
            timestamp,
          },
        ],
        createdAt: timestamp,
        updatedAt: timestamp,
        projectId: 'p',
      },
    ],
    localChats: [
      {
        id: 'l',
        title: 'Local',
        messages: [],
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    relationships: {
      projectChats: [{ projectId: 'p', chatId: 'c' }],
      projectDocuments: [{ projectId: 'p', documentId: 'd' }],
      chatImages: [{ chatId: 'c', imageId: 'i' }],
    },
    images: [
      {
        metadata: {
          id: 'i',
          chatId: 'c',
          messageIndex: 0,
          attachmentId: 'a',
          fileName: 'pixel.png',
          mimeType: 'image/png',
        },
        bytes: new Uint8Array([0, 1, 2, 3]),
      },
    ],
  }
}

describe('native backup v1 manifest', () => {
  it('matches the semantic golden manifest with deterministic hashes and counts', () => {
    const first = formatNativeBackupV1(input())
    const second = formatNativeBackupV1(input())

    expect(JSON.parse(new TextDecoder().decode(first.manifestBytes))).toEqual(
      goldenManifest,
    )
    expect(first.files.map(({ path }) => path)).toEqual(
      goldenManifest.files.map(({ path }) => path),
    )
    expect(second.manifestBytes).toEqual(first.manifestBytes)
    expect(parseNativeBackupManifest(first.manifestBytes)).toEqual(
      goldenManifest,
    )
    expectTypeOf<NativeBackupManifestV1['counts']>().toMatchTypeOf<{
      projects: number
      project_documents: number
      cloud_chats: number
      local_chats: number
      relationships: number
      images: number
      files: number
    }>()
  })

  it('serializes relationships independently of input order', () => {
    const ordered = input()
    ordered.cloudChats.push({
      id: 'c2',
      title: 'Second cloud chat',
      messages: [],
      createdAt: timestamp,
      updatedAt: timestamp,
      projectId: 'p',
    })
    ordered.relationships.projectChats.push({ projectId: 'p', chatId: 'c2' })
    const reversed = structuredClone(ordered)
    reversed.relationships.projectChats.reverse()

    expect(formatNativeBackupV1(reversed).manifestBytes).toEqual(
      formatNativeBackupV1(ordered).manifestBytes,
    )
  })

  it('uses runtime-independent string ordering', () => {
    const value = input()
    for (const id of ['ä', 'a', 'Z']) {
      value.projects.push({ ...value.projects[0], id })
      value.cloudChats.push({ ...value.cloudChats[0], id, messages: [] })
      value.relationships.projectChats.push({ projectId: 'p', chatId: id })
    }
    const formatted = formatNativeBackupV1(value)
    expect(
      formatted.files
        .filter(({ kind }) => kind === 'projects')
        .map(({ path }) => path),
    ).toEqual([
      'projects/id-5a.json',
      'projects/id-61.json',
      'projects/id-70.json',
      'projects/id-c3a4.json',
    ])
    const relationships = formatted.files.find(
      ({ kind }) => kind === 'relationships',
    )!
    expect(
      JSON.parse(new TextDecoder().decode(relationships.bytes)).projectChats,
    ).toEqual([
      { projectId: 'p', chatId: 'Z' },
      { projectId: 'p', chatId: 'a' },
      { projectId: 'p', chatId: 'c' },
      { projectId: 'p', chatId: 'ä' },
    ])
  })

  it('supports the same document id in different projects', () => {
    const value = input()
    value.projects.push({ ...value.projects[0], id: 'p2' })
    value.projectDocuments.push({
      ...value.projectDocuments[0],
      projectId: 'p2',
    })
    value.relationships.projectDocuments.push({
      projectId: 'p2',
      documentId: 'd',
    })

    const formatted = formatNativeBackupV1(value)

    expect(
      formatted.files
        .filter(({ kind }) => kind === 'project_documents')
        .map(({ path, bytes }) => ({
          path,
          payload: JSON.parse(new TextDecoder().decode(bytes)),
        })),
    ).toEqual([
      {
        path: 'project_documents/id-70/id-64.json',
        payload: value.projectDocuments[0],
      },
      {
        path: 'project_documents/id-7032/id-64.json',
        payload: value.projectDocuments[1],
      },
    ])
  })

  it('counts legacy attachments when portable attachments are absent', () => {
    const value = input()
    value.cloudChats[0].messages[0].attachments = []
    value.cloudChats[0].messages[0].imageData = []
    value.cloudChats[0].messages[0].documents = Array.from(
      { length: NATIVE_BACKUP_LIMITS.attachments + 1 },
      (_, index) => ({ name: `document-${index}` }),
    )
    value.images = []
    value.relationships.chatImages = []

    expect(() => formatNativeBackupV1(value)).toThrow(
      'attachment limit exceeded',
    )
  })

  it('distinguishes relationship IDs containing delimiters', () => {
    const malformed = input()
    malformed.projects = [
      { ...malformed.projects[0], id: 'a\0b' },
      { ...malformed.projects[0], id: 'a' },
    ]
    malformed.projectDocuments = [
      { ...malformed.projectDocuments[0], id: 'c', projectId: 'a\0b' },
      { ...malformed.projectDocuments[0], id: 'b\0c', projectId: 'a' },
    ]
    malformed.cloudChats = []
    malformed.localChats = []
    malformed.images = []
    malformed.relationships = {
      projectChats: [],
      projectDocuments: [{ projectId: 'a\0b', documentId: 'c' }],
      chatImages: [],
    }

    expect(() => formatNativeBackupV1(malformed)).toThrow(
      'project document relationships do not match entities',
    )
  })

  it('formats complete relationship sets near the archive entry limit', () => {
    const nearLimit = input()
    const count = 24_000
    nearLimit.projects = Array.from({ length: count }, (_, index) => ({
      id: `p-${index}`,
      name: `Project ${index}`,
      description: '',
      systemInstructions: '',
      memory: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    }))
    nearLimit.projectDocuments = nearLimit.projects.map((project, index) => ({
      id: `d-${index}`,
      projectId: project.id,
      filename: `${index}.txt`,
      contentType: 'text/plain',
      sizeBytes: 1,
      extractedText: 'x',
      createdAt: timestamp,
      updatedAt: timestamp,
    }))
    nearLimit.cloudChats[0].projectId = nearLimit.projects[0].id
    nearLimit.relationships.projectChats[0].projectId = nearLimit.projects[0].id
    nearLimit.relationships.projectDocuments = nearLimit.projectDocuments.map(
      ({ id, projectId }) => ({ projectId, documentId: id }),
    )

    const formatted = formatNativeBackupV1(nearLimit)
    const manifest = parseNativeBackupManifest(formatted.manifestBytes)
    expect(manifest.counts.files).toBe(48_005)
    expect(manifest.counts.relationships).toBe(24_002)
  }, 30_000)

  it('requires matching image metadata, bytes, and message references', () => {
    const missingBytes = { ...input(), images: [] }
    expect(() => formatNativeBackupV1(missingBytes)).toThrow(
      'chat image relationship references unknown entity',
    )

    const wrongLocation = input()
    wrongLocation.images[0].metadata.messageIndex = 1
    expect(() => formatNativeBackupV1(wrongLocation)).toThrow(
      'image descriptor does not match its message reference',
    )
  })

  it('enforces parser-aligned image and archive safety limits', () => {
    expect(() =>
      assertNativeBackupSizeLimits(1, [
        {
          path: 'images/id-image.bin',
          sizeBytes: NATIVE_BACKUP_LIMITS.imageBytes + 1,
        },
      ]),
    ).toThrow('image size limit exceeded')
    expect(() =>
      assertNativeBackupSizeLimits(1, [
        {
          path: 'projects/id-project.json',
          sizeBytes: NATIVE_BACKUP_LIMITS.aggregateJsonBytes,
        },
      ]),
    ).toThrow('aggregate JSON size limit exceeded')

    const imageSizes = Array.from({ length: 16 }, (_, index) => ({
      path: `images/id-${index}.bin`,
      sizeBytes: NATIVE_BACKUP_LIMITS.imageBytes,
    }))
    expect(() => assertNativeBackupSizeLimits(1, imageSizes)).toThrow(
      'archive size limit exceeded',
    )
  })

  it('rejects same-size image tampering through live ZIP restoration', async () => {
    const value = input()
    value.images[0].bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1])
    const formatted = formatNativeBackupV1(value)
    const image = formatted.files.find(({ path }) => path.endsWith('.bin'))!
    image.bytes[image.bytes.length - 1] ^= 1

    await expect(
      validateAndPackageNativeBackup(archive(formatted)),
    ).rejects.toThrow('hash mismatch')
  })

  it.each([
    ['projects/../project.json', 'Unsafe filename'],
    ['projects/not-canonical.json', 'invalid, unknown, or duplicate'],
  ])('rejects unsafe or noncanonical path %s', async (path, reason) => {
    const formatted = formatNativeBackupV1(input())
    const manifest = JSON.parse(
      new TextDecoder().decode(formatted.manifestBytes),
    )
    const project = formatted.files.find(({ kind }) => kind === 'projects')!
    project.path = path
    manifest.files.find(
      ({ kind }: { kind: string }) => kind === 'projects',
    ).path = project.path

    await expect(
      validateAndPackageNativeBackup(
        archive({
          manifestBytes: new TextEncoder().encode(JSON.stringify(manifest)),
          files: formatted.files,
        }),
      ),
    ).rejects.toThrow(reason)
  })

  it('detects content, hash, size, count, and completeness tampering', async () => {
    const formatted = formatNativeBackupV1(input())
    const tamperedFiles = formatted.files.map((file) => ({
      ...file,
      bytes: new Uint8Array(file.bytes),
    }))
    tamperedFiles[0].bytes[0] ^= 1
    await expect(
      validateAndPackageNativeBackup(
        archive({ ...formatted, files: tamperedFiles }),
      ),
    ).rejects.toThrow('hash mismatch')

    type MutableManifest = {
      counts: { images: number; relationships?: number }
      complete: boolean
      files: Array<{ sha256: string; size_bytes: number }>
    }
    const mutations: Array<[(manifest: MutableManifest) => void, string]> = [
      [
        (manifest) => {
          manifest.files[0].sha256 = '0'.repeat(64)
        },
        'hash mismatch',
      ],
      [
        (manifest) => {
          manifest.files[0].size_bytes++
        },
        'size mismatch',
      ],
      [
        (manifest) => {
          manifest.counts.images++
        },
        'count mismatch',
      ],
      [
        (manifest) => {
          delete manifest.counts.relationships
        },
        'relationships',
      ],
      [
        (manifest) => {
          manifest.complete = false
        },
        'complete',
      ],
      [
        (manifest) => {
          manifest.files.pop()
        },
        'file list mismatch',
      ],
    ]
    for (const [mutation, reason] of mutations) {
      const manifest = JSON.parse(
        new TextDecoder().decode(formatted.manifestBytes),
      ) as MutableManifest
      mutation(manifest)
      await expect(
        validateAndPackageNativeBackup(
          archive({
            manifestBytes: new TextEncoder().encode(JSON.stringify(manifest)),
            files: formatted.files,
          }),
        ),
      ).rejects.toThrow(reason)
    }
  })
})

describe('native backup v2 manifest', () => {
  it('truthfully records complete and partial source coverage', () => {
    const complete = formatNativeBackupV2({
      ...input(),
      omissions: [],
      warnings: [],
    })
    expect(parseNativeBackupManifest(complete.manifestBytes)).toMatchObject({
      version: 2,
      complete: true,
      omissions: [],
      warnings: [],
    })

    const partial = formatNativeBackupV2({
      ...input(),
      omissions: [
        {
          kind: 'cloud_chat',
          source_id: 'unreadable-chat',
          category: 'invalid',
          reason: 'chat_payload_invalid',
        },
      ],
      warnings: [
        {
          code: 'source_items_omitted',
          category: 'source_coverage',
          count: 1,
        },
      ],
    })
    expect(parseNativeBackupManifest(partial.manifestBytes)).toMatchObject({
      version: 2,
      complete: false,
    })
  })

  it('rejects contradictory partial metadata', async () => {
    const formatted = formatNativeBackupV2({
      ...input(),
      omissions: [],
      warnings: [],
    })
    const manifest = JSON.parse(
      new TextDecoder().decode(formatted.manifestBytes),
    )
    manifest.complete = false

    await expect(
      validateAndPackageNativeBackup(
        archive({
          manifestBytes: new TextEncoder().encode(JSON.stringify(manifest)),
          files: formatted.files,
        }),
      ),
    ).rejects.toThrow('completeness')
  })

  it('rejects duplicate omissions and warnings not exactly derived from them', () => {
    const omission = {
      kind: 'cloud_chat' as const,
      source_id: 'chat',
      category: 'invalid' as const,
      reason: 'chat_payload_invalid',
    }
    expect(() =>
      formatNativeBackupV2({
        ...input(),
        omissions: [omission, { ...omission, reason: 'different_reason' }],
        warnings: [
          {
            code: 'source_items_omitted',
            category: 'source_coverage',
            count: 2,
          },
        ],
      }),
    ).toThrow('duplicate or contradictory')

    expect(() =>
      formatNativeBackupV2({
        ...input(),
        omissions: [omission],
        warnings: [
          {
            code: 'source_items_omitted',
            category: 'source_coverage',
            count: 2,
          },
        ],
      }),
    ).toThrow('warnings do not match')

    expect(() =>
      formatNativeBackupV2({
        ...input(),
        omissions: [omission],
        warnings: [
          {
            code: 'source_items_omitted',
            category: 'source_coverage',
            count: 1,
          },
          {
            code: 'source_items_omitted',
            category: 'source_coverage',
            count: 1,
          },
        ],
      }),
    ).toThrow('warnings do not match')
  })

  it.each([undefined, null])(
    'derives relationship adjustments for detached projectId %s',
    (projectId) => {
      const value = input()
      value.cloudChats[0].projectId = projectId
      value.relationships.projectChats = []
      const formatted = formatNativeBackupV2({
        ...value,
        omissions: [
          {
            kind: 'relationship',
            source_id: 'c',
            parent_source_id: 'missing-project',
            category: 'unavailable',
            reason: 'project_reference_unavailable',
          },
        ],
        warnings: [
          {
            code: 'chats_detached_from_omitted_projects',
            category: 'relationship_adjustment',
            count: 1,
          },
        ],
      })

      expect(parseNativeBackupManifest(formatted.manifestBytes)).toMatchObject({
        complete: false,
        warnings: [
          {
            code: 'chats_detached_from_omitted_projects',
            category: 'relationship_adjustment',
            count: 1,
          },
        ],
      })
    },
  )

  it('rejects omissions contradicted by included entities or relationships', async () => {
    const entityOmission = {
      kind: 'project' as const,
      source_id: 'p',
      category: 'invalid' as const,
      reason: 'record_invalid',
    }
    expect(() =>
      formatNativeBackupV2({
        ...input(),
        omissions: [entityOmission],
        warnings: [
          {
            code: 'source_items_omitted',
            category: 'source_coverage',
            count: 1,
          },
        ],
      }),
    ).toThrow('project omission conflicts')

    expect(() =>
      formatNativeBackupV2({
        ...input(),
        omissions: [
          {
            kind: 'attachment',
            source_id: 'i',
            parent_source_id: 'c',
            category: 'unavailable',
            reason: 'attachment_not_found',
          },
        ],
        warnings: [
          {
            code: 'source_items_omitted',
            category: 'source_coverage',
            count: 1,
          },
        ],
      }),
    ).toThrow('attachment omission conflicts')

    expect(() =>
      formatNativeBackupV2({
        ...input(),
        omissions: [
          {
            kind: 'relationship',
            source_id: 'c',
            parent_source_id: 'p',
            category: 'unavailable',
            reason: 'project_reference_unavailable',
          },
        ],
        warnings: [
          {
            code: 'chats_detached_from_omitted_projects',
            category: 'relationship_adjustment',
            count: 1,
          },
        ],
      }),
    ).toThrow('relationship adjustment conflicts')

    const formatted = formatNativeBackupV2({
      ...input(),
      omissions: [],
      warnings: [],
    })
    const manifest = JSON.parse(
      new TextDecoder().decode(formatted.manifestBytes),
    )
    manifest.complete = false
    manifest.omissions = [entityOmission]
    manifest.warnings = [
      {
        code: 'source_items_omitted',
        category: 'source_coverage',
        count: 1,
      },
    ]
    await expect(
      validateAndPackageNativeBackup(
        archive({
          manifestBytes: new TextEncoder().encode(JSON.stringify(manifest)),
          files: formatted.files,
        }),
      ),
    ).rejects.toThrow('project omission conflicts')
  })
})
