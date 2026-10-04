import { hydrateDocumentAttachments } from '@/services/cloud/document-hydration'
import {
  decodeDocumentPayload,
  encodeDocumentPayload,
} from '@/services/cloud/document-payload'
import { ChatQueryBuilder } from '@/services/inference/chat-query-builder'
import {
  NATIVE_BACKUP_LIMITS,
  forEachNativeBackupLocalImage,
  formatNativeBackupV1,
  formatNativeBackupV2,
  validateAndPackageNativeBackup,
  type NativeBackupFileEntry,
  type NativeBackupFormatInput,
  type NativeRestoreArchive,
} from '@/services/native-backup'
import { base64ToUint8Array } from '@/utils/binary-codec'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import {
  BlobReader,
  BlobWriter,
  Uint8ArrayReader,
  Uint8ArrayWriter,
  ZipReader,
  ZipWriter,
} from '@zip.js/zip.js'
import contract from '../../fixtures/native-cloud-import-v1.json'

const timestamp = '2026-08-20T12:00:00.000Z'
const png = base64ToUint8Array(contract.blobs[0].base64)

function backupInput(): NativeBackupFormatInput {
  return {
    backupId: contract.source_backup_id,
    createdAt: timestamp,
    projects: [
      {
        id: 'project-1',
        name: 'Research',
        description: 'Description',
        systemInstructions: 'Be exact',
        color: '#123456',
        memory: [],
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    projectDocuments: [
      {
        id: 'document-1',
        projectId: 'project-1',
        filename: 'paper.pdf',
        contentType: 'application/pdf',
        sizeBytes: 9000,
        extractedText: 'Extracted text',
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    cloudChats: [
      {
        id: 'cloud-1',
        title: 'Cloud chat',
        titleState: 'manual',
        messages: [
          {
            role: 'user',
            content: 'hello',
            timestamp,
            attachments: [
              { id: 'cloud-image', type: 'image', imageId: 'cloud-image' },
            ],
          },
        ],
        createdAt: timestamp,
        updatedAt: timestamp,
        projectId: 'project-1',
        model: 'gpt-oss-120b',
      },
    ],
    localChats: [
      {
        id: 'local-1',
        title: 'Local chat',
        messages: [
          {
            role: 'user',
            content: 'local',
            timestamp,
            attachments: [
              { id: 'local-image', type: 'image', imageId: 'local-image' },
            ],
          },
        ],
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    relationships: {
      projectChats: [{ projectId: 'project-1', chatId: 'cloud-1' }],
      projectDocuments: [{ projectId: 'project-1', documentId: 'document-1' }],
      chatImages: [
        { chatId: 'cloud-1', imageId: 'cloud-image' },
        { chatId: 'local-1', imageId: 'local-image' },
      ],
    },
    images: [
      {
        metadata: {
          id: 'cloud-image',
          chatId: 'cloud-1',
          messageIndex: 0,
          attachmentId: 'cloud-image',
          fileName: 'photo.png',
          mimeType: 'image/png',
        },
        bytes: png,
      },
      {
        metadata: {
          id: 'local-image',
          chatId: 'local-1',
          messageIndex: 0,
          attachmentId: 'local-image',
          fileName: 'local.png',
          mimeType: 'image/png',
        },
        bytes: png,
      },
    ],
  }
}

async function zip(
  manifestBytes: Uint8Array,
  files: readonly NativeBackupFileEntry[],
  extra: Array<[string, Uint8Array]> = [],
) {
  const output = new BlobWriter('application/zip')
  const writer = new ZipWriter(output, { useWebWorkers: false })
  for (const [path, bytes] of [
    ['manifest.json', manifestBytes] as const,
    ...files.map(({ path, bytes }) => [path, bytes] as const),
    ...extra,
  ])
    await writer.add(path, new Uint8ArrayReader(bytes))
  await writer.close()
  return new File([await output.getData()], 'backup.zip', {
    type: 'application/zip',
  })
}

async function unzip(blob: Blob) {
  const reader = new ZipReader(new BlobReader(blob), { useWebWorkers: false })
  const files = new Map<string, Uint8Array>()
  try {
    for (const entry of await reader.getEntries()) {
      if (!entry.directory)
        files.set(
          entry.filename,
          await entry.getData(new Uint8ArrayWriter(), { useWebWorkers: false }),
        )
    }
  } finally {
    await reader.close()
  }
  return files
}

describe('native backup restore validation and cloud packaging', () => {
  it.each([
    { page: 0, is_scanned: true },
    { page: 1, is_scanned: false },
    { page: 0, is_scanned: false },
  ])(
    'preserves restored document page %j through hydration and inference',
    async ({ page, is_scanned }) => {
      const input = backupInput()
      input.cloudChats[0].messages[0].attachments!.push({
        id: 'document-attachment',
        type: 'document',
        fileName: 'restored.pdf',
        pages: [
          {
            page,
            text: 'restored page content',
            is_scanned,
            ...(is_scanned ? { imageId: 'page-image' } : {}),
          },
        ],
      })
      if (is_scanned) {
        input.images.push({
          metadata: {
            id: 'page-image',
            chatId: 'cloud-1',
            messageIndex: 0,
            attachmentId: 'document-attachment',
            page,
            fileName: 'page.png',
            mimeType: 'image/png',
          },
          bytes: png,
        })
        input.relationships.chatImages.push({
          chatId: 'cloud-1',
          imageId: 'page-image',
        })
      }
      const formatted = formatNativeBackupV1(input)
      const result = await validateAndPackageNativeBackup(
        await zip(formatted.manifestBytes, formatted.files),
      )
      const files = await unzip((result.cloud!.upload as { blob: Blob }).blob)
      const chat = result.cloud!.manifest.entities.find(
        ({ kind }) => kind === 'chat',
      )!
      const restored = JSON.parse(
        new TextDecoder().decode(files.get(chat.path)),
      )
      const attachment = restored.messages[0].attachments.find(
        (value: { id: string }) => value.id === 'document-attachment',
      )
      if (!is_scanned) expect(attachment.pages[0]).not.toHaveProperty('image')

      const messages = await hydrateDocumentAttachments([
        {
          role: 'user',
          content: 'summarize',
          timestamp: new Date(timestamp),
          attachments: [attachment],
        },
      ])
      const expectedPage = {
        page,
        text: 'restored page content',
        is_scanned,
        image: is_scanned ? contract.blobs[0].base64 : '',
      }
      expect(messages[0].attachments![0].pages).toEqual([expectedPage])
      expect(
        decodeDocumentPayload(
          attachment.id,
          encodeDocumentPayload(messages[0].attachments![0]),
        ),
      ).toEqual({ pages: [expectedPage] })
      const query = ChatQueryBuilder.buildMessages({
        model: {
          modelName: 'gpt-oss-120b',
          name: 'Test',
          nameShort: 'Test',
          description: '',
          image: '',
          type: 'chat',
          multimodal: true,
        },
        systemPrompt: '',
        messages,
      })
      expect(query[0].content).toContainEqual({
        type: 'text',
        text: `Page ${page}${is_scanned ? ' (scanned)' : ''}:\nrestored page content`,
      })
      if (is_scanned)
        expect(query[0].content).toContainEqual({
          type: 'image_url',
          image_url: {
            url: `data:image/png;base64,${contract.blobs[0].base64}`,
          },
        })
    },
  )

  it('partitions local records and matches the deployed semantic contract', async () => {
    const formatted = formatNativeBackupV1(backupInput())
    const result = await validateAndPackageNativeBackup(
      await zip(formatted.manifestBytes, formatted.files),
    )

    expect(result.local.chats.map(({ id }) => id)).toEqual(['local-1'])
    expect(result.local.images.map(({ metadata }) => metadata.id)).toEqual([
      'local-image',
    ])
    expect(result.cloud?.manifest.counts).toEqual({
      projects: 1,
      documents: 1,
      chats: 1,
      blobs: 1,
    })
    expect(result.cloud?.upload.kind).toBe('blob')

    const files = await unzip((result.cloud!.upload as { blob: Blob }).blob)
    const semantic = {
      source_backup_id: result.cloud!.manifest.source_backup_id,
      entities: result.cloud!.manifest.entities.map((entity) => ({
        kind: entity.kind,
        source_id: entity.source_id,
        ...(entity.project_source_id
          ? { project_source_id: entity.project_source_id }
          : {}),
        payload: JSON.parse(new TextDecoder().decode(files.get(entity.path))),
      })),
      blobs: result.cloud!.manifest.blobs.map((blob) => ({
        path: blob.path,
        base64: btoa(String.fromCharCode(...files.get(blob.path)!)),
      })),
    }
    expect(semantic).toEqual(contract)
    expect(JSON.stringify(semantic)).not.toMatch(
      /encryptionKey|codeExecutionAccessToken|syncUserId|local-1/,
    )
  })

  it('accepts a partial V2 archive while preserving its source warnings', async () => {
    const formatted = formatNativeBackupV2({
      ...backupInput(),
      omissions: [
        {
          kind: 'attachment',
          source_id: 'missing-source-image',
          parent_source_id: 'cloud-1',
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
    })

    const result = await validateAndPackageNativeBackup(
      await zip(formatted.manifestBytes, formatted.files),
    )

    expect(result.backup).toMatchObject({
      version: 2,
      complete: false,
      omissions: [
        {
          kind: 'attachment',
          source_id: 'missing-source-image',
          parent_source_id: 'cloud-1',
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
    })
  })

  it('rejects incomplete, tampered, unknown, and malformed archives', async () => {
    const formatted = formatNativeBackupV1(backupInput())
    const manifest = JSON.parse(
      new TextDecoder().decode(formatted.manifestBytes),
    )
    manifest.complete = false
    await expect(
      validateAndPackageNativeBackup(
        await zip(
          new TextEncoder().encode(JSON.stringify(manifest)),
          formatted.files,
        ),
      ),
    ).rejects.toThrow()

    const wrongKind = JSON.parse(
      new TextDecoder().decode(formatted.manifestBytes),
    )
    wrongKind.files.find(({ path }: { path: string }) =>
      path.endsWith('.bin'),
    ).kind = 'projects'
    await expect(
      validateAndPackageNativeBackup(
        await zip(
          new TextEncoder().encode(JSON.stringify(wrongKind)),
          formatted.files,
        ),
      ),
    ).rejects.toThrow('invalid kind')

    const tampered = formatted.files.map((file, index) =>
      index ? file : { ...file, bytes: new Uint8Array([1]) },
    )
    await expect(
      validateAndPackageNativeBackup(
        await zip(formatted.manifestBytes, tampered),
      ),
    ).rejects.toThrow('size mismatch')

    await expect(
      validateAndPackageNativeBackup(
        await zip(formatted.manifestBytes, formatted.files, [
          ['tmp/partial', new Uint8Array()],
        ]),
      ),
    ).rejects.toThrow('invalid, unknown, or duplicate')

    const malformedInput = backupInput()
    malformedInput.images[0].bytes = new Uint8Array([255, 0, 0, 0])
    const malformed = formatNativeBackupV1(malformedInput)
    await expect(
      validateAndPackageNativeBackup(
        await zip(malformed.manifestBytes, malformed.files),
      ),
    ).rejects.toThrow('image is malformed')
  })

  it('uses verified image bytes when optional size metadata is absent', async () => {
    const formatted = formatNativeBackupV1(backupInput())
    const metadataFile = formatted.files.find(
      ({ path }) => path.endsWith('.json') && path.startsWith('images/'),
    )!
    const metadata = JSON.parse(new TextDecoder().decode(metadataFile.bytes))
    delete metadata.sizeBytes
    metadataFile.bytes = new TextEncoder().encode(JSON.stringify(metadata))
    const manifest = JSON.parse(
      new TextDecoder().decode(formatted.manifestBytes),
    )
    const listed = manifest.files.find(
      ({ path }: { path: string }) => path === metadataFile.path,
    )
    listed.size_bytes = metadataFile.bytes.length
    listed.sha256 = bytesToHex(sha256(metadataFile.bytes))

    const result = await validateAndPackageNativeBackup(
      await zip(
        new TextEncoder().encode(JSON.stringify(manifest)),
        formatted.files,
      ),
    )
    const files = await unzip((result.cloud!.upload as { blob: Blob }).blob)
    const chat = result.cloud!.manifest.entities.find(
      ({ kind }) => kind === 'chat',
    )!
    const payload = JSON.parse(new TextDecoder().decode(files.get(chat.path)))

    expect(payload.messages[0].attachments[0].fileSize).toBe(png.length)
  })

  it('checks outer and per-entry limits without calling File.arrayBuffer', async () => {
    const arrayBuffer = vi.fn()
    const oversized = {
      size: NATIVE_BACKUP_LIMITS.archiveBytes + 1,
      arrayBuffer,
    } as unknown as File
    await expect(validateAndPackageNativeBackup(oversized)).rejects.toThrow(
      'archive is too large',
    )
    expect(arrayBuffer).not.toHaveBeenCalled()

    const formatted = formatNativeBackupV1(backupInput())
    const large = new Uint8Array(NATIVE_BACKUP_LIMITS.imageBytes + 1)
    await expect(
      validateAndPackageNativeBackup(
        await zip(
          formatted.manifestBytes,
          formatted.files.filter(
            ({ path }) => path !== 'images/id-636c6f75642d696d616765.bin',
          ),
          [['images/id-636c6f75642d696d616765.bin', large]],
        ),
      ),
    ).rejects.toThrow('entry is too large')
  })

  it('releases each image before reading the next and returns source descriptors', async () => {
    const input = backupInput()
    input.localChats[0].messages[0].attachments!.push({
      id: 'local-image-2',
      type: 'image',
      imageId: 'local-image-2',
    })
    input.relationships.chatImages.push({
      chatId: 'local-1',
      imageId: 'local-image-2',
    })
    input.images.push({
      metadata: {
        id: 'local-image-2',
        chatId: 'local-1',
        messageIndex: 0,
        attachmentId: 'local-image-2',
        fileName: 'local-2.png',
        mimeType: 'image/png',
      },
      bytes: png,
    })
    const formatted = formatNativeBackupV1(input)
    const source = new File([], 'backup.zip')
    let heldImageBytes = 0
    let peakImageBytes = 0
    const imageReads: string[] = []
    const values = [
      { path: 'manifest.json', bytes: formatted.manifestBytes },
      ...formatted.files,
    ]
    const archive: NativeRestoreArchive = {
      entries: values.map(({ path, bytes }) => ({
        path,
        directory: false,
        encrypted: false,
        compressedSize: bytes.length,
        uncompressedSize: bytes.length,
        read: async () => {
          const image = path.endsWith('.bin')
          if (image) {
            imageReads.push(path)
            heldImageBytes += bytes.length
            peakImageBytes = Math.max(peakImageBytes, heldImageBytes)
          }
          return {
            bytes,
            release: () => {
              if (image) heldImageBytes -= bytes.length
            },
          }
        },
      })),
      close: async () => undefined,
    }

    const result = await validateAndPackageNativeBackup(source, {
      dependencies: { openArchive: async () => archive },
    })

    expect(peakImageBytes).toBe(png.length)
    expect(heldImageBytes).toBe(0)
    expect(result.local.images[0].source).toMatchObject({
      file: source,
      path: expect.stringMatching(/\.bin$/),
      sizeBytes: png.length,
    })
    expect(result.local.images[0]).not.toHaveProperty('bytes')

    heldImageBytes = 0
    peakImageBytes = 0
    imageReads.length = 0
    const sequence: string[] = []
    await forEachNativeBackupLocalImage(
      result.local.images,
      async ({ metadata, bytes }) => {
        expect(heldImageBytes).toBe(bytes.length)
        sequence.push(metadata.id)
        await Promise.resolve()
      },
      { dependencies: { openArchive: async () => archive } },
    )
    expect(sequence).toEqual(['local-image', 'local-image-2'])
    expect(imageReads).toHaveLength(2)
    expect(peakImageBytes).toBe(png.length)
    expect(heldImageBytes).toBe(0)

    imageReads.length = 0
    const controller = new AbortController()
    await expect(
      forEachNativeBackupLocalImage(
        result.local.images,
        () => controller.abort(),
        {
          signal: controller.signal,
          dependencies: { openArchive: async () => archive },
        },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(imageReads).toHaveLength(1)
    expect(heldImageBytes).toBe(0)
  })

  it('removes OPFS output when setup or pre-commit cancellation fails', async () => {
    const formatted = formatNativeBackupV1(backupInput())
    const file = await zip(formatted.manifestBytes, formatted.files)
    const original = Object.getOwnPropertyDescriptor(navigator, 'storage')
    const removeEntry = vi.fn(async () => undefined)
    const root = {
      removeEntry,
      getFileHandle: vi.fn(async () => ({
        createWritable: vi.fn(async () => {
          throw new Error('setup failed')
        }),
      })),
    }
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: { getDirectory: async () => root },
    })
    try {
      await expect(validateAndPackageNativeBackup(file)).rejects.toThrow(
        'setup failed',
      )
      expect(removeEntry).toHaveBeenCalledTimes(1)

      removeEntry.mockClear()
      const controller = new AbortController()
      root.getFileHandle.mockResolvedValue({
        createWritable: vi.fn(
          async () =>
            new WritableStream<Uint8Array>({
              write() {
                controller.abort()
              },
            }),
        ),
      })
      await expect(
        validateAndPackageNativeBackup(file, { signal: controller.signal }),
      ).rejects.toMatchObject({ name: 'AbortError' })
      expect(removeEntry).toHaveBeenCalledTimes(1)
    } finally {
      if (original) Object.defineProperty(navigator, 'storage', original)
      else Reflect.deleteProperty(navigator, 'storage')
    }
  })

  it('returns committed OPFS output when cancellation occurs during commit', async () => {
    const formatted = formatNativeBackupV1(backupInput())
    const file = await zip(formatted.manifestBytes, formatted.files)
    const original = Object.getOwnPropertyDescriptor(navigator, 'storage')
    const controller = new AbortController()
    const removeEntry = vi.fn(async () => undefined)
    const handle = {
      createWritable: vi.fn(
        async () =>
          new WritableStream<Uint8Array>({
            close() {
              controller.abort()
            },
          }),
      ),
    }
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: {
        getDirectory: async () => ({
          getFileHandle: async () => handle,
          removeEntry,
        }),
      },
    })
    try {
      const result = await validateAndPackageNativeBackup(file, {
        signal: controller.signal,
      })
      expect(controller.signal.aborted).toBe(true)
      expect(result.cloud?.upload).toMatchObject({ kind: 'file', handle })
      expect(removeEntry).not.toHaveBeenCalled()
      if (result.cloud?.upload.kind === 'file')
        await result.cloud.upload.cleanup()
      expect(removeEntry).toHaveBeenCalledTimes(1)
    } finally {
      if (original) Object.defineProperty(navigator, 'storage', original)
      else Reflect.deleteProperty(navigator, 'storage')
    }
  })
})
