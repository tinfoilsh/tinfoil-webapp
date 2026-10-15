import {
  BlobWriter,
  Uint8ArrayReader,
  ZipWriter,
  type ZipWriterConstructorOptions,
} from '@zip.js/zip.js'
import type { NativeBackupFileEntry } from './format'

const ZIP_MIME_TYPE = 'application/zip'
const MANIFEST_PATH = 'manifest.json'
const ZIP_YEAR = 1980

export interface NativeBackupWriterLimits {
  file: { compressedBytes: number; uncompressedBytes: number }
  blob: { compressedBytes: number; uncompressedBytes: number }
}

export const NATIVE_BACKUP_WRITER_LIMITS: NativeBackupWriterLimits = {
  file: {
    compressedBytes: 512 * 1024 * 1024,
    uncompressedBytes: 1024 * 1024 * 1024,
  },
  blob: {
    compressedBytes: 128 * 1024 * 1024,
    uncompressedBytes: 256 * 1024 * 1024,
  },
} as const

export interface NativeBackupArchiveInput {
  manifestBytes: Uint8Array
  files: readonly NativeBackupFileEntry[]
}

export type NativeBackupArchiveResult =
  | { kind: 'file'; filename: string }
  | { kind: 'blob'; filename: string; blob: Blob }

export class NativeBackupWriterError extends Error {
  constructor(
    public readonly code:
      | 'invalid_manifest'
      | 'unsafe_path'
      | 'duplicate_path'
      | 'uncompressed_limit'
      | 'compressed_limit',
    message: string,
  ) {
    super(`Native backup archive failed: ${message}`)
    this.name = 'NativeBackupWriterError'
  }
}

export interface NativeZipWriter {
  add(path: string, bytes: Uint8Array): Promise<void>
  close(): Promise<void>
}

export interface NativeZipWriterOptions {
  signal?: AbortSignal
  lastModDate: Date
  extendedTimestamp: false
}

export interface NativeBlobOutput {
  writable: WritableStream<Uint8Array>
  getData(): Promise<Blob>
}

export interface NativeBackupWriterDependencies {
  fileSystemAccessSupported(): boolean
  createFileWritable(filename: string): Promise<WritableStream<Uint8Array>>
  createBlobOutput(): NativeBlobOutput
  createZipWriter(
    writable: WritableStream<Uint8Array>,
    options: NativeZipWriterOptions,
  ): NativeZipWriter
  limits: NativeBackupWriterLimits
}

type SaveFilePicker = (options: {
  suggestedName: string
  types: Array<{
    description: string
    accept: Record<string, string[]>
  }>
}) => Promise<FileSystemFileHandle>

function saveFilePicker(): SaveFilePicker | undefined {
  return (
    globalThis as typeof globalThis & { showSaveFilePicker?: SaveFilePicker }
  ).showSaveFilePicker
}

export async function prepareNativeBackupArchiveDestination(): Promise<
  FileSystemFileHandle | undefined
> {
  const picker = saveFilePicker()
  if (!picker) return undefined
  return picker({
    suggestedName: 'tinfoil-backup.zip',
    types: [
      {
        description: 'ZIP archive',
        accept: { [ZIP_MIME_TYPE]: ['.zip'] },
      },
    ],
  })
}

const zipOptions: ZipWriterConstructorOptions = {
  bufferedWrite: false,
  encrypted: false,
  keepOrder: true,
  level: 6,
  preventClose: true,
  useCompressionStream: false,
  useWebWorkers: false,
}

const defaultDependencies: NativeBackupWriterDependencies = {
  fileSystemAccessSupported: () => Boolean(saveFilePicker()),
  createFileWritable: async (filename) => {
    const picker = saveFilePicker()
    if (!picker) throw new Error('File System Access API is unavailable')
    const handle = await picker({
      suggestedName: filename,
      types: [
        {
          description: 'ZIP archive',
          accept: { [ZIP_MIME_TYPE]: ['.zip'] },
        },
      ],
    })
    return (await handle.createWritable()) as WritableStream<Uint8Array>
  },
  createBlobOutput: () => {
    const writer = new BlobWriter(ZIP_MIME_TYPE)
    return {
      writable: writer.writable as WritableStream<Uint8Array>,
      getData: () => writer.getData(),
    }
  },
  createZipWriter: (writable, options) => {
    const writer = new ZipWriter(writable, { ...zipOptions, ...options })
    return {
      add: async (path, bytes) => {
        await writer.add(path, new Uint8ArrayReader(bytes))
      },
      close: async () => {
        await writer.close(undefined, { preventClose: true })
      },
    }
  },
  limits: NATIVE_BACKUP_WRITER_LIMITS,
}

function filenameFromManifest(manifestBytes: Uint8Array): string {
  let createdAt: unknown
  try {
    const manifest = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes),
    )
    createdAt =
      manifest && typeof manifest === 'object'
        ? (manifest as Record<string, unknown>).created_at
        : undefined
  } catch {
    createdAt = undefined
  }
  const match =
    typeof createdAt === 'string'
      ? /^(\d{4}-\d{2}-\d{2})T/.exec(createdAt)
      : null
  const year = Number(match?.[1].slice(0, 4))
  const month = Number(match?.[1].slice(5, 7))
  const day = Number(match?.[1].slice(8, 10))
  const date = new Date(Date.UTC(year, month - 1, day))
  if (
    !match ||
    !Number.isFinite(Date.parse(createdAt as string)) ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    throw new NativeBackupWriterError(
      'invalid_manifest',
      'manifest created_at is missing or invalid',
    )
  return `tinfoil-backup-${match[1]}.zip`
}

function safePath(path: string): boolean {
  if (!path || path.length > 4096 || /[\\\0\u0000-\u001f]/.test(path))
    return false
  if (path !== path.trim()) return false
  if (path.startsWith('/') || path.endsWith('/') || /^[A-Za-z]:/.test(path))
    return false
  return path
    .split('/')
    .every(
      (part) =>
        part.length > 0 &&
        part === part.trim() &&
        part !== '.' &&
        part !== '..',
    )
}

function orderedEntries(input: NativeBackupArchiveInput) {
  const paths = new Set([MANIFEST_PATH])
  for (const file of input.files) {
    if (!safePath(file.path) || file.path === MANIFEST_PATH)
      throw new NativeBackupWriterError(
        'unsafe_path',
        `unsafe path ${JSON.stringify(file.path)}`,
      )
    if (paths.has(file.path))
      throw new NativeBackupWriterError(
        'duplicate_path',
        `duplicate path ${JSON.stringify(file.path)}`,
      )
    paths.add(file.path)
  }
  const files = [...input.files].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  )
  return [{ path: MANIFEST_PATH, bytes: input.manifestBytes }, ...files]
}

function boundedWritable(
  writable: WritableStream<Uint8Array>,
  maxBytes: number,
) {
  const target = writable.getWriter()
  let settled = false
  const release = () => {
    if (!settled) {
      settled = true
      target.releaseLock()
    }
  }
  const abort = async (reason?: unknown) => {
    if (settled) return
    try {
      await target.abort(reason)
    } finally {
      release()
    }
  }
  const commit = async () => {
    if (settled) return
    try {
      await target.close()
    } catch (error) {
      await target.abort(error).catch(() => undefined)
      throw error
    } finally {
      release()
    }
  }
  let written = 0
  return {
    writable: new WritableStream<Uint8Array>({
      write: async (chunk) => {
        if (written + chunk.byteLength > maxBytes)
          throw new NativeBackupWriterError(
            'compressed_limit',
            `compressed archive exceeds ${maxBytes} bytes`,
          )
        written += chunk.byteLength
        await target.write(chunk)
      },
      close: () => undefined,
      abort,
    }),
    abort,
    commit,
  }
}

function zipTimestamp(): Date {
  return new Date(ZIP_YEAR, 0, 1, 0, 0, 0, 0)
}

async function commitOutput(
  output: ReturnType<typeof boundedWritable>,
  signal?: AbortSignal,
  checkAfterCommit = true,
) {
  signal?.throwIfAborted()
  await output.commit()
  if (checkAfterCommit) signal?.throwIfAborted()
}

export async function writeNativeBackupArchive(
  input: NativeBackupArchiveInput,
  options: {
    signal?: AbortSignal
    destination?: FileSystemFileHandle
  } = {},
  dependencies: NativeBackupWriterDependencies = defaultDependencies,
): Promise<NativeBackupArchiveResult> {
  options.signal?.throwIfAborted()
  const filename = filenameFromManifest(input.manifestBytes)
  const entries = orderedEntries(input)
  const kind =
    options.destination || dependencies.fileSystemAccessSupported()
      ? 'file'
      : 'blob'
  const limits = dependencies.limits[kind]
  const uncompressedBytes = entries.reduce(
    (total, entry) => total + entry.bytes.byteLength,
    0,
  )
  if (uncompressedBytes > limits.uncompressedBytes)
    throw new NativeBackupWriterError(
      'uncompressed_limit',
      `uncompressed archive exceeds ${limits.uncompressedBytes} bytes`,
    )

  const blobOutput = kind === 'blob' ? dependencies.createBlobOutput() : null
  const output = blobOutput
    ? blobOutput.writable
    : options.destination
      ? ((await options.destination.createWritable()) as WritableStream<Uint8Array>)
      : await dependencies.createFileWritable(filename)
  const bounded = boundedWritable(output, limits.compressedBytes)
  try {
    const zip = dependencies.createZipWriter(bounded.writable, {
      signal: options.signal,
      lastModDate: zipTimestamp(),
      extendedTimestamp: false,
    })
    for (const entry of entries) {
      options.signal?.throwIfAborted()
      await zip.add(entry.path, entry.bytes)
    }
    await zip.close()
    options.signal?.throwIfAborted()
    await commitOutput(bounded, options.signal, kind === 'blob')
    if (blobOutput)
      return { kind: 'blob', filename, blob: await blobOutput.getData() }
    return { kind: 'file', filename }
  } catch (error) {
    await bounded.abort(error).catch(() => undefined)
    throw error
  }
}
