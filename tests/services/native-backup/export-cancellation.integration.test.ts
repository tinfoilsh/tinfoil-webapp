import {
  runNativeBackupExport,
  type NativeBackupExportDependencies,
} from '@/services/native-backup/export'
import {
  writeNativeBackupArchive,
  type NativeBackupWriterDependencies,
} from '@/services/native-backup/write'
import { expect, it, vi } from 'vitest'

const collectNativeBackupV2 = vi.hoisted(() => vi.fn())

vi.mock('@/services/native-backup/collect', async (importOriginal) => ({
  ...(await importOriginal()),
  collectNativeBackupV2,
}))

it('propagates cancellation into the default collector', async () => {
  const controller = new AbortController()
  collectNativeBackupV2.mockImplementation(
    (_dependencies: unknown, signal: AbortSignal) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        }),
      ),
  )

  const result = runNativeBackupExport(controller.signal, vi.fn())
  await vi.waitFor(() => expect(collectNativeBackupV2).toHaveBeenCalled())
  controller.abort()

  await expect(result).rejects.toMatchObject({ name: 'AbortError' })
  expect(collectNativeBackupV2).toHaveBeenCalledWith(
    undefined,
    controller.signal,
  )
})

it('reports success when cancellation occurs during file close', async () => {
  const controller = new AbortController()
  const output = new WritableStream<Uint8Array>({
    close: () => controller.abort(),
  })
  const writerDependencies: NativeBackupWriterDependencies = {
    fileSystemAccessSupported: () => true,
    createFileWritable: async () => output,
    createBlobOutput: () => {
      throw new Error('Blob output must not be used')
    },
    createZipWriter: (writable) => {
      const writer = writable.getWriter()
      return {
        add: async (_path, bytes) => writer.write(bytes),
        close: async () => writer.close(),
      }
    },
    limits: {
      file: { compressedBytes: 1024, uncompressedBytes: 1024 },
      blob: { compressedBytes: 1024, uncompressedBytes: 1024 },
    },
  }
  const download = vi.fn()
  const dependencies = {
    collect: async () => ({
      backupId: '123e4567-e89b-42d3-a456-426614174000',
      createdAt: '2026-08-20T12:00:00.000Z',
      projects: [],
      projectDocuments: [],
      cloudChats: [],
      localChats: [],
      images: [],
      relationships: { projectChats: [], projectDocuments: [], chatImages: [] },
      omissions: [],
      warnings: [],
    }),
    format: () => ({
      manifestBytes: new TextEncoder().encode(
        '{"created_at":"2026-08-20T12:00:00.000Z"}',
      ),
      files: [],
    }),
    write: (input, options) =>
      writeNativeBackupArchive(input, options, writerDependencies),
    download,
  } satisfies NativeBackupExportDependencies

  await expect(
    runNativeBackupExport(controller.signal, vi.fn(), dependencies),
  ).resolves.toEqual({
    complete: true,
    omitted: 0,
    adjustedRelationships: 0,
    localInventoryUnstable: false,
    warnings: 0,
  })
  expect(controller.signal.aborted).toBe(true)
  expect(download).toHaveBeenCalledWith({
    kind: 'file',
    filename: 'tinfoil-backup-2026-08-20.zip',
  })
})
