import { NATIVE_BACKUP_LIMITS } from '@/services/native-backup/constants'
import {
  formatNativeBackupV1,
  formatNativeBackupV2,
  type NativeBackupFileEntry,
  type NativeBackupFormatInput,
} from '@/services/native-backup/format'
import {
  forEachNativeBackupLocalImage,
  readNativeBackup,
  validateAndPackageNativeBackup,
  type NativeRestoreArchive,
} from '@/services/native-backup/restore'
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

const timestamp = '2026-08-20T12:00:00.000Z'
const backupId = '123e4567-e89b-42d3-a456-426614174000'
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13])
const decode = (bytes: Uint8Array | undefined) =>
  JSON.parse(new TextDecoder().decode(bytes))

type MutableInput = {
  [
    K in keyof NativeBackupFormatInput
  ]: NativeBackupFormatInput[K] extends readonly (infer T)[]
    ? T[]
    : NativeBackupFormatInput[K]
}

function backupInput(): MutableInput {
  return {
    backupId,
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
  it('keeps a scanned page and its image in the cloud part', async () => {
    const input = backupInput()
    input.cloudChats[0].messages[0].attachments!.push({
      id: 'document-attachment',
      type: 'document',
      fileName: 'restored.pdf',
      pages: [
        {
          page: 1,
          text: 'restored page content',
          is_scanned: true,
          imageId: 'page-image',
        },
      ],
    })
    input.images.push({
      metadata: {
        id: 'page-image',
        chatId: 'cloud-1',
        messageIndex: 0,
        attachmentId: 'document-attachment',
        page: 1,
        fileName: 'page.png',
        mimeType: 'image/png',
      },
      bytes: png,
    })
    input.relationships.chatImages.push({
      chatId: 'cloud-1',
      imageId: 'page-image',
    })
    const formatted = formatNativeBackupV1(input)
    const sourceFiles = new Map(
      formatted.files.map(({ path, bytes }) => [path, bytes]),
    )

    const result = await validateAndPackageNativeBackup(
      await zip(formatted.manifestBytes, formatted.files),
    )
    const files = await unzip((result.cloud!.upload as { blob: Blob }).blob)

    const chatPath = 'cloud_chats/id-636c6f75642d31.json'
    expect(files.get(chatPath)).toEqual(sourceFiles.get(chatPath))
    expect(
      decode(files.get(chatPath)).messages[0].attachments[1].pages,
    ).toEqual([
      {
        page: 1,
        text: 'restored page content',
        is_scanned: true,
        imageId: 'page-image',
      },
    ])
    const pageImage = 'images/id-706167652d696d616765'
    expect(files.get(`${pageImage}.bin`)).toEqual(png)
    expect(files.get(`${pageImage}.json`)).toEqual(
      sourceFiles.get(`${pageImage}.json`),
    )
    expect(decode(files.get('relationships.json')).chatImages).toEqual([
      { chatId: 'cloud-1', imageId: 'cloud-image' },
      { chatId: 'cloud-1', imageId: 'page-image' },
    ])
  })

  it('partitions local records and packages the cloud part as a backup of its own', async () => {
    const formatted = formatNativeBackupV1(backupInput())
    const sourceFiles = new Map(
      formatted.files.map(({ path, bytes }) => [path, bytes]),
    )
    const result = await validateAndPackageNativeBackup(
      await zip(formatted.manifestBytes, formatted.files),
    )

    expect(result.local.chats.map(({ id }) => id)).toEqual(['local-1'])
    expect(result.local.images.map(({ metadata }) => metadata.id)).toEqual([
      'local-image',
    ])
    expect(result.cloud?.upload).toMatchObject({
      kind: 'blob',
      filename: 'tinfoil-backup.zip',
    })
    const files = await unzip((result.cloud!.upload as { blob: Blob }).blob)
    const relationships = files.get('relationships.json')!
    expect(decode(relationships)).toEqual({
      projectChats: [{ projectId: 'project-1', chatId: 'cloud-1' }],
      projectDocuments: [{ projectId: 'project-1', documentId: 'document-1' }],
      chatImages: [{ chatId: 'cloud-1', imageId: 'cloud-image' }],
    })
    const kept = [
      'cloud_chats/id-636c6f75642d31.json',
      'images/id-636c6f75642d696d616765.bin',
      'images/id-636c6f75642d696d616765.json',
      'project_documents/id-70726f6a6563742d31/id-646f63756d656e742d31.json',
      'projects/id-70726f6a6563742d31.json',
    ]
    expect([...files.keys()].sort()).toEqual(
      [...kept, 'manifest.json', 'relationships.json'].sort(),
    )
    for (const path of kept)
      expect(files.get(path)).toEqual(sourceFiles.get(path))
    expect(result.cloud!.manifest).toEqual({
      format: 'tinfoil-native-backup',
      version: 2,
      backup_id: backupId,
      created_at: timestamp,
      complete: true,
      counts: {
        projects: 1,
        project_documents: 1,
        cloud_chats: 1,
        local_chats: 0,
        relationships: 3,
        images: 1,
        files: 6,
      },
      notices: {
        contains_plaintext: true,
        documents_are_extracted_text_only: true,
      },
      files: expect.arrayContaining([
        {
          path: 'relationships.json',
          kind: 'relationships',
          sha256: bytesToHex(sha256(relationships)),
          size_bytes: relationships.length,
        },
      ]),
      omissions: [],
      warnings: [],
    })
    expect(decode(files.get('manifest.json'))).toEqual(result.cloud!.manifest)
    expect(new TextDecoder().decode(relationships)).not.toContain('local')

    // The cloud part is itself a valid backup, with no local chats.
    const again = await validateAndPackageNativeBackup(
      new File([(result.cloud!.upload as { blob: Blob }).blob], 'cloud.zip'),
    )
    expect(again.local).toEqual({ chats: [], images: [] })
    expect(again.backup).toEqual(result.cloud!.manifest)
  })

  it("leaves the local chats' omissions out of the cloud part", async () => {
    const input = backupInput()
    const formatted = formatNativeBackupV2({
      ...input,
      omissions: [
        {
          kind: 'attachment',
          source_id: 'missing-cloud-image',
          parent_source_id: 'cloud-1',
          category: 'unavailable',
          reason: 'attachment_not_found',
        },
        {
          kind: 'attachment',
          source_id: 'missing-local-image',
          parent_source_id: 'local-1',
          category: 'invalid',
          reason: 'attachment_type_unsupported',
        },
        {
          kind: 'local_chat',
          source_id: 'unreadable-local',
          category: 'invalid',
          reason: 'record_invalid',
        },
        {
          kind: 'local_inventory',
          source_id: 'eligible_local_chats',
          category: 'unstable',
          reason: 'inventory_did_not_converge',
        },
      ],
      warnings: [
        {
          code: 'source_items_omitted',
          category: 'source_coverage',
          count: 3,
        },
        {
          code: 'local_inventory_unstable',
          category: 'source_coverage',
          count: 1,
        },
      ],
    })

    const result = await validateAndPackageNativeBackup(
      await zip(formatted.manifestBytes, formatted.files),
    )

    expect(result.cloud!.manifest).toMatchObject({
      complete: false,
      omissions: [
        {
          kind: 'attachment',
          source_id: 'missing-cloud-image',
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
    expect(result.backup).toMatchObject({ omissions: { length: 4 } })
  })

  it('rejects mislabeled and malformed archive entries', async () => {
    const formatted = formatNativeBackupV1(backupInput())
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

    const malformedInput = backupInput()
    malformedInput.images[0].bytes = new Uint8Array([255, 0, 0, 0])
    const malformed = formatNativeBackupV1(malformedInput)
    await expect(
      validateAndPackageNativeBackup(
        await zip(malformed.manifestBytes, malformed.files),
      ),
    ).rejects.toThrow('image is malformed')
  })

  it('copies image metadata that leaves out its optional size', async () => {
    const formatted = formatNativeBackupV1(backupInput())
    const metadataFile = formatted.files.find(
      ({ path }) => path === 'images/id-636c6f75642d696d616765.json',
    )!
    const metadata = decode(metadataFile.bytes)
    delete metadata.sizeBytes
    metadataFile.bytes = new TextEncoder().encode(JSON.stringify(metadata))
    const manifest = decode(formatted.manifestBytes)
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

    expect(files.get(metadataFile.path)).toEqual(metadataFile.bytes)
    expect(result.cloud!.manifest.files).toContainEqual(listed)
    await expect(
      validateAndPackageNativeBackup(
        new File([(result.cloud!.upload as { blob: Blob }).blob], 'cloud.zip'),
      ),
    ).resolves.toMatchObject({ local: { chats: [] } })
  })

  it('reads a whole backup with its image bytes', async () => {
    const input = backupInput()
    const formatted = formatNativeBackupV1(input)

    const contents = await readNativeBackup(
      await zip(formatted.manifestBytes, formatted.files),
    )

    expect(contents.backup).toEqual(decode(formatted.manifestBytes))
    expect(contents.projects).toEqual(input.projects)
    expect(contents.documents).toEqual(input.projectDocuments)
    expect(contents.cloudChats).toEqual(input.cloudChats)
    expect(contents.localChats).toEqual(input.localChats)
    expect(contents.relationships).toEqual(input.relationships)
    expect(contents.images).toEqual(
      input.images.map(({ metadata, bytes }) => ({
        metadata: { ...metadata, sizeBytes: bytes.length },
        bytes,
      })),
    )

    // An archive reader may reuse an entry's buffer once it is released.
    const reused: NativeRestoreArchive = {
      entries: [
        { path: 'manifest.json', bytes: formatted.manifestBytes },
        ...formatted.files,
      ].map(({ path, bytes }) => ({
        path,
        directory: false,
        encrypted: false,
        compressedSize: bytes.length,
        uncompressedSize: bytes.length,
        read: async () => {
          const buffer = new Uint8Array(bytes)
          return { bytes: buffer, release: () => buffer.fill(0) }
        },
      })),
      close: async () => undefined,
    }
    const released = await readNativeBackup(new File([], 'backup.zip'), {
      dependencies: { openArchive: async () => reused },
    })
    expect(released.images.map(({ bytes }) => bytes)).toEqual([png, png])

    const tampered = formatted.files.map((file) =>
      file.path.endsWith('.bin')
        ? { ...file, bytes: new Uint8Array([...file.bytes.slice(0, -1), 1]) }
        : file,
    )
    await expect(
      readNativeBackup(await zip(formatted.manifestBytes, tampered)),
    ).rejects.toThrow('hash mismatch')
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
        createWritable: vi.fn(async (): Promise<WritableStream<Uint8Array>> => {
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
