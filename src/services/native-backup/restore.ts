import { uint8ArrayToBase64 } from '@/utils/binary-codec'
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
import {
  NATIVE_BACKUP_ENTITY_KINDS,
  NATIVE_BACKUP_LIMITS,
  NATIVE_BACKUP_VERSION_V2,
} from './constants'
import {
  assertNativeBackupOmissionsConsistent,
  assertSemanticContent,
  parseNativeBackupManifest,
  type NativeBackupManifest,
} from './format'
import { detectNativeBackupImageMimeType } from './image-mime'
import {
  NativeBackupChatSchema,
  NativeBackupImageSchema,
  NativeBackupProjectDocumentSchema,
  NativeBackupProjectSchema,
  NativeBackupRelationshipsSchema,
  type NativeBackupChat,
  type NativeBackupImage,
  type NativeBackupProject,
  type NativeBackupProjectDocument,
  type NativeBackupRelationships,
} from './schemas'
const MANIFEST_PATH = 'manifest.json'
const MAX_MANIFEST_BYTES = 32 * 1024 * 1024
const MAX_ENTRY_BYTES = 256 * 1024 * 1024
const MAX_UNCOMPRESSED_BYTES = 1024 * 1024 * 1024
const MAX_CLOUD_ENTITY_BYTES = 256 * 1024 * 1024
const BLOB_OUTPUT_BYTES = 128 * 1024 * 1024
const FILE_OUTPUT_BYTES = 512 * 1024 * 1024
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })
// prettier-ignore
export type NativeRestoreEntry = { path: string; directory: boolean; encrypted: boolean; compressedSize: number; uncompressedSize: number; read(signal?: AbortSignal): Promise<{ bytes: Uint8Array; release(): void }> }
// prettier-ignore
export type NativeRestoreArchive = { entries: NativeRestoreEntry[]; close(): Promise<void> }
// prettier-ignore
export type NativeRestoreDependencies = { openArchive(file: File): Promise<NativeRestoreArchive> }
// prettier-ignore
export type NativeCloudImportManifestV1 = { format: 'tinfoil-native-cloud-import'; version: 1; source_backup_id: string; counts: { projects: number; documents: number; chats: number; blobs: number }; entities: Array<{ kind: 'project' | 'document' | 'chat'; source_id: string; project_source_id?: string; path: string; sha256: string; size_bytes: number }>; blobs: Array<{ path: string; sha256: string; size_bytes: number }> }
// prettier-ignore
export type NativeCloudUpload = { kind: 'blob'; blob: Blob; filename: string } | { kind: 'file'; handle: FileSystemFileHandle; filename: string; cleanup(): Promise<void> }
// prettier-ignore
export type NativeBackupImageSource = { metadata: NativeBackupImage; source: { file: File; path: string; sizeBytes: number; sha256: string } }
// prettier-ignore
export type ValidatedNativeRestore = { backup: NativeBackupManifest; local: { chats: NativeBackupChat[]; images: NativeBackupImageSource[] }; cloud: { manifest: NativeCloudImportManifestV1; upload: NativeCloudUpload } | null }
// prettier-ignore
type ParsedBackup = { backup: NativeBackupManifest; projects: NativeBackupProject[]; documents: NativeBackupProjectDocument[]; cloudChats: NativeBackupChat[]; localChats: NativeBackupChat[]; relationships: NativeBackupRelationships; images: Array<{ metadata: NativeBackupImage; entry: NativeRestoreEntry; sha256: string }> }
function fail(message: string): never {
  throw new Error(`Invalid native backup restore: ${message}`)
}
const hash = (bytes: Uint8Array) => bytesToHex(sha256(bytes))
const jsonBytes = (value: unknown) => encoder.encode(JSON.stringify(value))
const idComponent = (id: string) => `id-${bytesToHex(encoder.encode(id))}`
function parse(bytes: Uint8Array, path: string): unknown {
  try {
    return JSON.parse(decoder.decode(bytes))
  } catch {
    return fail(`${path} is not valid UTF-8 JSON`)
  }
}
// prettier-ignore
async function openZip(file: File): Promise<NativeRestoreArchive> {
  const reader = new ZipReader(new BlobReader(file), { strictness: 'strict', useWebWorkers: false })
  try {
    const entries = await reader.getEntries()
    return {
      entries: entries.map((entry) => ({
        path: entry.filename, directory: entry.directory, encrypted: entry.encrypted,
        compressedSize: entry.compressedSize, uncompressedSize: entry.uncompressedSize,
        read: async (signal) => {
          if (entry.directory) fail('directory entries are not allowed')
          const bytes = await entry.getData(new Uint8ArrayWriter(), {
            signal, useWebWorkers: false,
            onprogress: (size) => { if (size > entry.uncompressedSize) fail(`inflated entry: ${entry.filename}`) },
          })
          return { bytes, release: () => undefined }
        },
      })),
      close: () => reader.close(),
    }
  } catch (error) { await reader.close(); throw error }
}
const defaults: NativeRestoreDependencies = { openArchive: openZip }
function knownPath(path: string): boolean {
  // prettier-ignore
  return (
    path === MANIFEST_PATH || path === 'relationships.json' || /^(projects|cloud_chats|local_chats)\/id-[0-9a-f]+\.json$/.test(path) || /^project_documents\/id-[0-9a-f]+\/id-[0-9a-f]+\.json$/.test(path) || /^images\/id-[0-9a-f]+\.(json|bin)$/.test(path)
  )
}
function checkEntries(entries: NativeRestoreEntry[]) {
  if (entries.length > NATIVE_BACKUP_LIMITS.entries)
    fail('entry limit exceeded')
  const byPath = new Map<string, NativeRestoreEntry>()
  let compressed = 0
  let uncompressed = 0
  for (const entry of entries) {
    if (
      entry.directory ||
      entry.encrypted ||
      !knownPath(entry.path) ||
      byPath.has(entry.path)
    )
      fail('archive contains an invalid, unknown, or duplicate entry')
    // prettier-ignore
    const limit =
      entry.path === MANIFEST_PATH ? MAX_MANIFEST_BYTES : entry.path.endsWith('.bin') ? NATIVE_BACKUP_LIMITS.imageBytes : MAX_ENTRY_BYTES
    if (entry.uncompressedSize > limit)
      fail(`entry is too large: ${entry.path}`)
    compressed += entry.compressedSize
    uncompressed += entry.uncompressedSize
    if (compressed > NATIVE_BACKUP_LIMITS.archiveBytes)
      fail('compressed size limit exceeded')
    if (uncompressed > MAX_UNCOMPRESSED_BYTES)
      fail('uncompressed size limit exceeded')
    byPath.set(entry.path, entry)
  }
  return byPath
}
// prettier-ignore
async function readEntry<T>(entry: NativeRestoreEntry, expected: { size_bytes: number; sha256: string }, signal: AbortSignal | undefined, consume: (bytes: Uint8Array) => T | Promise<T>): Promise<T> {
  signal?.throwIfAborted()
  const retained = await entry.read(signal)
  try {
    if (retained.bytes.length !== entry.uncompressedSize || retained.bytes.length !== expected.size_bytes) fail(`size mismatch for ${entry.path}`)
    if (hash(retained.bytes) !== expected.sha256) fail(`hash mismatch for ${entry.path}`)
    return await consume(retained.bytes)
  } finally {
    retained.release()
  }
}
async function parseArchive(
  byPath: Map<string, NativeRestoreEntry>,
  signal?: AbortSignal,
): Promise<ParsedBackup> {
  const manifestEntry = byPath.get(MANIFEST_PATH) ?? fail('manifest is missing')
  const manifestRead = await manifestEntry.read(signal)
  let backup: NativeBackupManifest
  try {
    if (manifestRead.bytes.length !== manifestEntry.uncompressedSize)
      fail('manifest size mismatch')
    backup = parseNativeBackupManifest(manifestRead.bytes)
  } finally {
    manifestRead.release()
  }
  const listed = new Map(backup.files.map((file) => [file.path, file]))
  if (listed.size !== backup.files.length || listed.size + 1 !== byPath.size)
    fail('file list mismatch')
  let jsonSize = manifestEntry.uncompressedSize
  for (const file of backup.files) {
    const entry = byPath.get(file.path) ?? fail(`missing entry ${file.path}`)
    if (entry.uncompressedSize !== file.size_bytes)
      fail(`size mismatch for ${file.path}`)
    if (file.path !== MANIFEST_PATH && !knownPath(file.path))
      fail(`invalid path ${file.path}`)
    if (!file.path.endsWith('.bin')) jsonSize += file.size_bytes
  }
  if (jsonSize > NATIVE_BACKUP_LIMITS.aggregateJsonBytes)
    fail('aggregate JSON size limit exceeded')
  for (const path of byPath.keys())
    if (path !== MANIFEST_PATH && !listed.has(path))
      fail(`unlisted entry ${path}`)
  const projects: NativeBackupProject[] = []
  const documents: NativeBackupProjectDocument[] = []
  const cloudChats: NativeBackupChat[] = []
  const localChats: NativeBackupChat[] = []
  const imageMetadata: Array<{ metadata: NativeBackupImage; sha256: string }> =
    []
  let relationships: NativeBackupRelationships | undefined
  for (const file of backup.files) {
    if (file.path.endsWith('.bin')) {
      if (file.kind !== 'images') fail(`invalid kind for ${file.path}`)
      continue
    }
    const entry = byPath.get(file.path)!
    await readEntry(entry, file, signal, (bytes) => {
      const value = parse(bytes, file.path)
      if (file.kind === 'projects') {
        const project = NativeBackupProjectSchema.parse(value)
        if (file.path !== `projects/${idComponent(project.id)}.json`)
          fail('project path mismatch')
        projects.push(project)
      } else if (file.kind === 'project_documents') {
        const document = NativeBackupProjectDocumentSchema.parse(value)
        if (
          file.path !==
          `project_documents/${idComponent(document.projectId)}/${idComponent(document.id)}.json`
        )
          fail('document path mismatch')
        documents.push(document)
      } else if (file.kind === 'cloud_chats' || file.kind === 'local_chats') {
        const chat = NativeBackupChatSchema.parse(value)
        if (file.path !== `${file.kind}/${idComponent(chat.id)}.json`)
          fail('chat path mismatch')
        ;(file.kind === 'cloud_chats' ? cloudChats : localChats).push(chat)
      } else if (file.kind === 'relationships') {
        if (relationships || file.path !== 'relationships.json')
          fail('relationships path mismatch')
        relationships = NativeBackupRelationshipsSchema.parse(value)
      } else if (file.kind === 'images') {
        const metadata = NativeBackupImageSchema.parse(value)
        if (file.path !== `images/${idComponent(metadata.id)}.json`)
          fail('image path mismatch')
        const binary =
          listed.get(`images/${idComponent(metadata.id)}.bin`) ??
          fail('image bytes are missing')
        imageMetadata.push({ metadata, sha256: binary.sha256 })
      } else fail(`invalid kind for ${file.path}`)
    })
  }
  const relationValue = relationships ?? fail('relationships are missing')
  const images = imageMetadata.map(({ metadata, sha256 }) => {
    const path = `images/${idComponent(metadata.id)}.bin`
    const entry = byPath.get(path) ?? fail('image bytes are missing')
    if (
      metadata.sizeBytes !== undefined &&
      metadata.sizeBytes !== entry.uncompressedSize
    )
      fail('image size mismatch')
    return { metadata, entry, sha256 }
  })
  if (
    backup.files.filter(
      ({ kind, path }) => kind === 'images' && path.endsWith('.bin'),
    ).length !== images.length
  )
    fail('image metadata is missing')
  const allChats = [...cloudChats, ...localChats]
  assertSemanticContent(
    projects,
    documents,
    allChats,
    relationValue,
    images.map(({ metadata }) => metadata),
  )
  if (backup.version === NATIVE_BACKUP_VERSION_V2)
    assertNativeBackupOmissionsConsistent(
      backup.omissions,
      projects,
      documents,
      cloudChats,
      localChats,
      relationValue,
      images.map(({ metadata }) => metadata),
    )
  // prettier-ignore
  const counts = {
    projects: projects.length, project_documents: documents.length, cloud_chats: cloudChats.length, local_chats: localChats.length, relationships: Object.values(relationValue).reduce((sum, values) => sum + values.length, 0), images: images.length, files: backup.files.length,
  }
  for (const key of [...NATIVE_BACKUP_ENTITY_KINDS, 'files'] as const)
    if (backup.counts[key] !== counts[key]) fail(`count mismatch for ${key}`)
  if (
    projects.length + documents.length + allChats.length >
    NATIVE_BACKUP_LIMITS.entities
  )
    fail('entity limit exceeded')
  // prettier-ignore
  return { backup, projects, documents, cloudChats, localChats, relationships: relationValue, images }
}
// prettier-ignore
type CloudSink = { add(path: string, bytes: Uint8Array): Promise<void>; finish(): Promise<NativeCloudUpload>; abort(reason?: unknown): Promise<void> }
async function createCloudSink(
  backupId: string,
  signal?: AbortSignal,
): Promise<CloudSink> {
  // prettier-ignore
  const storage = navigator.storage as StorageManager & { getDirectory?: () => Promise<FileSystemDirectoryHandle> }
  const outputName = `native-import-${backupId}-${crypto.randomUUID()}.zip`
  let root: FileSystemDirectoryHandle | null = null
  let handle: FileSystemFileHandle | null = null
  let target: WritableStreamDefaultWriter<Uint8Array> | null = null
  let committed = false
  try {
    root = storage?.getDirectory ? await storage.getDirectory() : null
    handle = root
      ? await root.getFileHandle(outputName, { create: true })
      : null
    const blobWriter = handle ? null : new BlobWriter('application/zip')
    const writable = handle
      ? await handle.createWritable()
      : blobWriter!.writable
    target = writable.getWriter()
    const limit = handle ? FILE_OUTPUT_BYTES : BLOB_OUTPUT_BYTES
    let size = 0
    const bounded = new WritableStream<Uint8Array>({
      async write(chunk) {
        if (size + chunk.length > limit) fail('cloud ZIP output limit exceeded')
        size += chunk.length
        await target!.write(chunk)
      },
      abort: (reason) => target!.abort(reason),
    })
    const zip = new ZipWriter(bounded, {
      bufferedWrite: false,
      preventClose: true,
      signal,
      useWebWorkers: false,
    })
    const abort = async (reason?: unknown) => {
      if (committed) return
      await target!.abort(reason).catch(() => undefined)
      if (root) await root.removeEntry(outputName).catch(() => undefined)
    }
    return {
      add: async (path, bytes) => {
        signal?.throwIfAborted()
        await zip.add(path, new Uint8ArrayReader(bytes))
      },
      finish: async () => {
        await zip.close(undefined, { preventClose: true })
        signal?.throwIfAborted()
        await target!.close()
        committed = true
        // prettier-ignore
        if (handle) return { kind: 'file', handle, filename: 'tinfoil-cloud-import.zip', cleanup: () => root!.removeEntry(outputName) }
        // prettier-ignore
        return { kind: 'blob', blob: await blobWriter!.getData(), filename: 'tinfoil-cloud-import.zip' }
      },
      abort,
    }
  } catch (error) {
    if (target) await target.abort(error).catch(() => undefined)
    if (root) await root.removeEntry(outputName).catch(() => undefined)
    throw error
  }
}
export async function validateAndPackageNativeBackup(
  file: File,
  options: {
    signal?: AbortSignal
    dependencies?: NativeRestoreDependencies
  } = {},
): Promise<ValidatedNativeRestore> {
  if (file.size > NATIVE_BACKUP_LIMITS.archiveBytes)
    fail('archive is too large')
  options.signal?.throwIfAborted()
  const archive = await (options.dependencies ?? defaults).openArchive(file)
  let sink: CloudSink | null = null
  try {
    const value = await parseArchive(
      checkEntries(archive.entries),
      options.signal,
    )
    const localIds = new Set(value.localChats.map(({ id }) => id))
    const hasCloud =
      value.projects.length + value.documents.length + value.cloudChats.length >
      0
    if (hasCloud)
      sink = await createCloudSink(value.backup.backup_id, options.signal)
    const localImages: NativeBackupImageSource[] = []
    const blobs: NativeCloudImportManifestV1['blobs'] = []
    // prettier-ignore
    const readImage = async <T>(image: ParsedBackup['images'][number], consume: (bytes: Uint8Array) => T | Promise<T>) => readEntry(image.entry, { size_bytes: image.entry.uncompressedSize, sha256: image.sha256 }, options.signal, async (bytes) => {
      const mime = detectNativeBackupImageMimeType(bytes)
      if (!mime || mime !== image.metadata.mimeType.split(';', 1)[0].trim() || !image.metadata.fileName.trim()) fail(`image is malformed: ${image.metadata.id}`)
      return consume(bytes)
    })
    for (const image of value.images.filter(({ metadata }) =>
      localIds.has(metadata.chatId),
    )) {
      await readImage(image, (bytes) => {
        // prettier-ignore
        localImages.push({ metadata: image.metadata, source: { file, path: image.entry.path, sizeBytes: bytes.length, sha256: image.sha256 } })
      })
    }
    let cloud: ValidatedNativeRestore['cloud'] = null
    if (sink) {
      const entities: NativeCloudImportManifestV1['entities'] = []
      let entityBytes = 0
      const add = async (
        kind: 'project' | 'document' | 'chat',
        sourceId: string,
        payload: unknown,
        projectSourceId?: string,
      ) => {
        const path = `entities/${kind}/${entities.length}.json`
        const bytes = jsonBytes(payload)
        entityBytes += bytes.length
        if (
          bytes.length > MAX_CLOUD_ENTITY_BYTES ||
          entityBytes > MAX_CLOUD_ENTITY_BYTES
        )
          fail('cloud entity JSON limit exceeded')
        // prettier-ignore
        entities.push({ kind, source_id: sourceId, ...(projectSourceId ? { project_source_id: projectSourceId } : {}), path, sha256: hash(bytes), size_bytes: bytes.length })
        await sink!.add(path, bytes)
      }
      for (const project of value.projects) {
        if (!project.name.trim()) fail('project name is empty')
        const {
          id,
          createdAt: _createdAt,
          updatedAt: _updatedAt,
          ...payload
        } = project
        await add('project', id, payload)
      }
      for (const document of value.documents) {
        if (!document.filename.trim() || !document.contentType.trim())
          fail('document field is empty')
        // prettier-ignore
        await add('document', document.id, { filename: document.filename, contentType: document.contentType, sourceSizeBytes: document.sizeBytes, sizeBytes: document.sizeBytes, content: document.extractedText }, document.projectId)
      }
      for (const chat of value.cloudChats) {
        // prettier-ignore
        const cloudImages = new Map<string, { metadata: NativeBackupImage; sizeBytes: number; path?: string; base64?: string }>()
        for (const image of value.images.filter(
          ({ metadata }) => metadata.chatId === chat.id,
        ))
          await readImage(image, async (bytes) => {
            const direct =
              image.metadata.page === undefined &&
              image.metadata.legacyIndex === undefined
            const path = direct ? `blobs/${blobs.length}` : undefined
            if (path) {
              blobs.push({
                path,
                sha256: image.sha256,
                size_bytes: bytes.length,
              })
              await sink!.add(path, bytes)
            }
            // prettier-ignore
            cloudImages.set(image.metadata.id, { metadata: image.metadata, sizeBytes: bytes.length, path, ...(!path ? { base64: uint8ArrayToBase64(bytes) } : {}) })
          })
        // prettier-ignore
        const messages = chat.messages.map((message) => ({
          ...message,
          imageData: message.imageData?.map(({ imageId, mimeType }) => ({ base64: cloudImages.get(imageId)?.base64 ?? fail(`missing image ${imageId}`), mimeType })),
          attachments: message.attachments?.map((attachment) => {
            if (attachment.type === 'image') {
              const image = cloudImages.get(attachment.imageId) ?? fail(`missing image ${attachment.imageId}`)
              return { id: attachment.id, type: 'image', fileName: image.metadata.fileName, mimeType: image.metadata.mimeType, fileSize: image.sizeBytes, ...(image.metadata.description ? { description: image.metadata.description } : {}), archivePath: image.path }
            }
            if (!attachment.fileName.trim())
              fail('document attachment filename is empty')
            return { ...attachment, pages: attachment.pages?.map(({ imageId, ...page }) => imageId ? { ...page, image: cloudImages.get(imageId)?.base64 ?? fail(`missing image ${imageId}`) } : page) }
          }),
        }))
        const { id, projectId, messages: _messages, ...payload } = chat
        await add(
          'chat',
          id,
          { ...payload, messages, isLocalOnly: false },
          projectId ?? undefined,
        )
      }
      // prettier-ignore
      const manifest: NativeCloudImportManifestV1 = {
        format: 'tinfoil-native-cloud-import', version: 1, source_backup_id: value.backup.backup_id, counts: { projects: value.projects.length, documents: value.documents.length, chats: value.cloudChats.length, blobs: blobs.length }, entities, blobs,
      }
      await sink.add(MANIFEST_PATH, jsonBytes(manifest))
      const upload = await sink.finish()
      cloud = { manifest, upload }
    }
    // prettier-ignore
    return { backup: value.backup, local: { chats: value.localChats, images: localImages }, cloud }
  } catch (error) {
    await sink?.abort(error)
    options.signal?.throwIfAborted()
    throw error
  } finally {
    await archive.close()
  }
}
// prettier-ignore
export async function forEachNativeBackupLocalImage(images: NativeBackupImageSource[], consume: (image: { metadata: NativeBackupImage; bytes: Uint8Array }) => void | Promise<void>, options: { signal?: AbortSignal; dependencies?: NativeRestoreDependencies } = {}): Promise<void> {
  if (!images.length) return
  const file = images[0].source.file
  if (file.size > NATIVE_BACKUP_LIMITS.archiveBytes) fail('archive is too large')
  options.signal?.throwIfAborted()
  const archive = await (options.dependencies ?? defaults).openArchive(file)
  try {
    const entries = checkEntries(archive.entries)
    for (const image of images) {
      const source = image.source
      if (source.file !== file || source.sizeBytes > NATIVE_BACKUP_LIMITS.imageBytes || source.path !== `images/${idComponent(image.metadata.id)}.bin`) fail('invalid local image source')
      const entry = entries.get(source.path) ?? fail('local image entry is missing')
      await readEntry(entry, { size_bytes: source.sizeBytes, sha256: source.sha256 }, options.signal, async (bytes) => {
        if (detectNativeBackupImageMimeType(bytes) !== image.metadata.mimeType.split(';', 1)[0].trim()) fail(`image is malformed: ${image.metadata.id}`)
        await consume({ metadata: image.metadata, bytes })
        options.signal?.throwIfAborted()
      })
    }
  } finally { await archive.close() }
}
