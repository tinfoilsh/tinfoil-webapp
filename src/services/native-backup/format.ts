import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { z } from 'zod'
import {
  NATIVE_BACKUP_ENTITY_KINDS,
  NATIVE_BACKUP_FORMAT,
  NATIVE_BACKUP_LIMITS,
  NATIVE_BACKUP_VERSION,
  NATIVE_BACKUP_VERSION_V2,
  type NativeBackupEntityKind,
} from './constants'
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
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })
const countSchema = z.number().int().nonnegative()
const strict = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict()

export interface NativeBackupFileEntry {
  path: string
  kind: NativeBackupEntityKind
  bytes: Uint8Array
}

export interface NativeBackupImageInput {
  metadata: NativeBackupImage
  bytes: Uint8Array
}

export interface NativeBackupFormatInput {
  backupId: string
  createdAt: string
  projects: readonly NativeBackupProject[]
  projectDocuments: readonly NativeBackupProjectDocument[]
  cloudChats: readonly NativeBackupChat[]
  localChats: readonly NativeBackupChat[]
  relationships: NativeBackupRelationships
  images: readonly NativeBackupImageInput[]
}

export const NATIVE_BACKUP_OMISSION_KINDS = [
  'project',
  'project_document',
  'cloud_chat',
  'local_chat',
  'attachment',
  'relationship',
  'local_inventory',
] as const
export const NATIVE_BACKUP_FAILURE_CATEGORIES = [
  'deleted',
  'unavailable',
  'invalid',
  'unstable',
] as const
export type NativeBackupOmission = {
  kind: (typeof NATIVE_BACKUP_OMISSION_KINDS)[number]
  source_id: string
  parent_source_id?: string
  category: (typeof NATIVE_BACKUP_FAILURE_CATEGORIES)[number]
  reason: string
}
export type NativeBackupWarning =
  | {
      code: 'source_items_omitted'
      category: 'source_coverage'
      count: number
    }
  | {
      code: 'chats_detached_from_omitted_projects'
      category: 'relationship_adjustment'
      count: number
    }
  | {
      code: 'local_inventory_unstable'
      category: 'source_coverage'
      count: number
    }
export interface NativeBackupV2Input extends NativeBackupFormatInput {
  omissions: readonly NativeBackupOmission[]
  warnings: readonly NativeBackupWarning[]
}

export interface NativeBackupManifestV1 {
  format: typeof NATIVE_BACKUP_FORMAT
  version: typeof NATIVE_BACKUP_VERSION
  backup_id: string
  created_at: string
  complete: true
  counts: Record<NativeBackupEntityKind, number> & { files: number }
  notices: { contains_plaintext: true; documents_are_extracted_text_only: true }
  files: Array<{
    path: string
    kind: NativeBackupEntityKind
    sha256: string
    size_bytes: number
  }>
}

export interface NativeBackupManifestV2 extends Omit<
  NativeBackupManifestV1,
  'version' | 'complete'
> {
  version: typeof NATIVE_BACKUP_VERSION_V2
  complete: boolean
  omissions: NativeBackupOmission[]
  warnings: NativeBackupWarning[]
}

export type NativeBackupManifest =
  NativeBackupManifestV1 | NativeBackupManifestV2

export type NativeBackupV1Input = NativeBackupFormatInput

const manifestSchema = strict({
  format: z.literal(NATIVE_BACKUP_FORMAT),
  version: z.literal(NATIVE_BACKUP_VERSION),
  backup_id: z.string().uuid(),
  created_at: z.string().datetime({ offset: true }),
  complete: z.literal(true),
  counts: strict({
    projects: countSchema,
    project_documents: countSchema,
    cloud_chats: countSchema,
    local_chats: countSchema,
    relationships: countSchema,
    images: countSchema,
    files: countSchema,
  }),
  notices: strict({
    contains_plaintext: z.literal(true),
    documents_are_extracted_text_only: z.literal(true),
  }),
  files: z.array(
    strict({
      path: z.string(),
      kind: z.enum(NATIVE_BACKUP_ENTITY_KINDS),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
      size_bytes: countSchema,
    }),
  ),
})

const omissionSchema = strict({
  kind: z.enum(NATIVE_BACKUP_OMISSION_KINDS),
  source_id: z.string().min(1).max(2048),
  parent_source_id: z.string().min(1).max(2048).optional(),
  category: z.enum(NATIVE_BACKUP_FAILURE_CATEGORIES),
  reason: z.string().min(1).max(128),
})
const warningSchema = z.discriminatedUnion('code', [
  strict({
    code: z.literal('source_items_omitted'),
    category: z.literal('source_coverage'),
    count: countSchema,
  }),
  strict({
    code: z.literal('chats_detached_from_omitted_projects'),
    category: z.literal('relationship_adjustment'),
    count: countSchema,
  }),
  strict({
    code: z.literal('local_inventory_unstable'),
    category: z.literal('source_coverage'),
    count: countSchema,
  }),
])
const manifestV2Schema: z.ZodType<NativeBackupManifestV2> = manifestSchema
  .omit({ version: true, complete: true })
  .extend({
    version: z.literal(NATIVE_BACKUP_VERSION_V2),
    complete: z.boolean(),
    omissions: z.array(omissionSchema),
    warnings: z.array(warningSchema),
  })
  .strict()

export const parseNativeBackupManifestV1 = (bytes: Uint8Array) =>
  manifestSchema.parse(parseJson(bytes, MANIFEST_PATH))

export const parseNativeBackupManifest = (bytes: Uint8Array) => {
  const value = parseJson(bytes, MANIFEST_PATH)
  const manifest = z.union([manifestSchema, manifestV2Schema]).parse(value)
  if (manifest.version === NATIVE_BACKUP_VERSION_V2)
    assertNativeBackupV2Metadata(manifest)
  return manifest
}

function fail(message: string): never {
  throw new Error(`Invalid native backup: ${message}`)
}

const jsonBytes = (value: unknown) => encoder.encode(JSON.stringify(value))

function parseJson(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(decoder.decode(bytes))
  } catch {
    return fail(`${label} is not valid UTF-8 JSON`)
  }
}

const idComponent = (id: string) => `id-${bytesToHex(encoder.encode(id))}`
const hash = (bytes: Uint8Array) => bytesToHex(sha256(bytes))
const relationshipCount = (value: NativeBackupRelationships) =>
  value.projectChats.length +
  value.projectDocuments.length +
  value.chatImages.length

const omissionIdentity = (omission: NativeBackupOmission) =>
  JSON.stringify([
    omission.kind,
    omission.source_id,
    omission.parent_source_id ?? null,
  ])

export function deriveNativeBackupWarnings(
  omissions: readonly NativeBackupOmission[],
): NativeBackupWarning[] {
  const omittedItems = omissions.filter(
    ({ kind }) => kind !== 'relationship' && kind !== 'local_inventory',
  ).length
  const relationshipAdjustments = omissions.filter(
    ({ kind }) => kind === 'relationship',
  ).length
  const unstableLocalInventories = omissions.filter(
    ({ kind }) => kind === 'local_inventory',
  ).length
  return [
    ...(omittedItems
      ? [
          {
            code: 'source_items_omitted' as const,
            category: 'source_coverage' as const,
            count: omittedItems,
          },
        ]
      : []),
    ...(relationshipAdjustments
      ? [
          {
            code: 'chats_detached_from_omitted_projects' as const,
            category: 'relationship_adjustment' as const,
            count: relationshipAdjustments,
          },
        ]
      : []),
    ...(unstableLocalInventories
      ? [
          {
            code: 'local_inventory_unstable' as const,
            category: 'source_coverage' as const,
            count: unstableLocalInventories,
          },
        ]
      : []),
  ]
}

function assertNativeBackupV2Metadata(manifest: NativeBackupManifestV2) {
  if (manifest.omissions.length > NATIVE_BACKUP_LIMITS.omissions)
    fail('V2 omission limit exceeded')
  if (manifest.complete !== (manifest.omissions.length === 0))
    fail('V2 completeness does not match omissions')
  const identities = new Set<string>()
  for (const omission of manifest.omissions) {
    const identity = omissionIdentity(omission)
    if (identities.has(identity)) fail('duplicate or contradictory V2 omission')
    identities.add(identity)
    if (
      omission.kind === 'relationship' &&
      (!omission.parent_source_id ||
        omission.category !== 'unavailable' ||
        omission.reason !== 'project_reference_unavailable')
    )
      fail('invalid V2 relationship adjustment')
    if (omission.kind === 'project_document' && !omission.parent_source_id)
      fail('invalid V2 project document omission')
    if (omission.kind === 'attachment' && !omission.parent_source_id)
      fail('invalid V2 attachment omission')
    if (
      (omission.kind === 'project' ||
        omission.kind === 'cloud_chat' ||
        omission.kind === 'local_chat') &&
      omission.parent_source_id
    )
      fail('invalid V2 entity omission')
    if (
      omission.kind === 'local_inventory' &&
      (omission.source_id !== 'eligible_local_chats' ||
        omission.parent_source_id ||
        omission.category !== 'unstable' ||
        omission.reason !== 'inventory_did_not_converge')
    )
      fail('invalid V2 local inventory omission')
  }
  const expected = deriveNativeBackupWarnings(manifest.omissions)
  if (JSON.stringify(manifest.warnings) !== JSON.stringify(expected))
    fail('V2 warnings do not match omissions')
}

export function assertNativeBackupOmissionsConsistent(
  omissions: readonly NativeBackupOmission[],
  projects: readonly NativeBackupProject[],
  documents: readonly NativeBackupProjectDocument[],
  cloudChats: readonly NativeBackupChat[],
  localChats: readonly NativeBackupChat[],
  relationships: NativeBackupRelationships,
  images: readonly NativeBackupImage[],
) {
  const projectIds = new Set(projects.map(({ id }) => id))
  const documentIds = new Set(
    documents.map(({ projectId, id }) => relationKey(projectId, id)),
  )
  const cloudChatIds = new Set(cloudChats.map(({ id }) => id))
  const localChatIds = new Set(localChats.map(({ id }) => id))
  const chats = [...cloudChats, ...localChats]
  const chatById = new Map(chats.map((chat) => [chat.id, chat]))
  const imageIds = new Set(images.map(({ id }) => id))
  const referencedImageIds = new Set(
    chats.flatMap(({ messages }) =>
      messages.flatMap((message) => [
        ...(message.attachments ?? []).flatMap((attachment) =>
          attachment.type === 'image'
            ? [attachment.imageId]
            : (attachment.pages ?? []).flatMap(({ imageId }) =>
                imageId ? [imageId] : [],
              ),
        ),
        ...(message.imageData ?? []).map(({ imageId }) => imageId),
      ]),
    ),
  )
  const projectChatRelations = new Set(
    relationships.projectChats.map(({ projectId, chatId }) =>
      relationKey(projectId, chatId),
    ),
  )
  for (const omission of omissions) {
    if (omission.kind === 'project' && projectIds.has(omission.source_id))
      fail('project omission conflicts with included entity')
    if (
      omission.kind === 'project_document' &&
      omission.parent_source_id &&
      documentIds.has(
        relationKey(omission.parent_source_id, omission.source_id),
      )
    )
      fail('project document omission conflicts with included entity')
    if (omission.kind === 'cloud_chat' && cloudChatIds.has(omission.source_id))
      fail('cloud chat omission conflicts with included entity')
    if (omission.kind === 'local_chat' && localChatIds.has(omission.source_id))
      fail('local chat omission conflicts with included entity')
    if (
      omission.kind === 'attachment' &&
      (!omission.parent_source_id || !chatById.has(omission.parent_source_id))
    )
      fail('attachment omission does not identify an included chat')
    if (
      omission.kind === 'attachment' &&
      (imageIds.has(omission.source_id) ||
        referencedImageIds.has(omission.source_id))
    )
      fail('attachment omission conflicts with included image reference')
    if (omission.kind === 'relationship') {
      const chat = chatById.get(omission.source_id)
      if (
        !chat ||
        (chat.projectId !== undefined && chat.projectId !== null) ||
        projectIds.has(omission.parent_source_id!) ||
        projectChatRelations.has(
          relationKey(omission.parent_source_id!, omission.source_id),
        )
      )
        fail('relationship adjustment conflicts with included relation')
    }
  }
}

function zipUpperBound(path: string, size: number): number {
  const pathBytes = encoder.encode(path).length
  return size + Math.ceil(size / 16_383) * 5 + 104 + pathBytes * 2
}

export function assertNativeBackupSizeLimits(
  manifestSizeBytes: number,
  files: readonly { path: string; sizeBytes: number }[],
) {
  if (files.length + 1 > NATIVE_BACKUP_LIMITS.entries)
    fail('archive entry limit exceeded')
  let aggregateJsonBytes = manifestSizeBytes
  let archiveBytes = 22 + zipUpperBound(MANIFEST_PATH, manifestSizeBytes)
  for (const file of files) {
    archiveBytes += zipUpperBound(file.path, file.sizeBytes)
    if (file.path.endsWith('.bin')) {
      if (file.sizeBytes > NATIVE_BACKUP_LIMITS.imageBytes)
        fail('image size limit exceeded')
    } else {
      aggregateJsonBytes += file.sizeBytes
    }
  }
  if (aggregateJsonBytes > NATIVE_BACKUP_LIMITS.aggregateJsonBytes)
    fail('aggregate JSON size limit exceeded')
  if (archiveBytes > NATIVE_BACKUP_LIMITS.archiveBytes)
    fail('archive size limit exceeded')
}

function sortedUnique<T extends { id: string }>(
  items: readonly T[],
  name: string,
  key: (item: T) => string = (item) => idComponent(item.id),
) {
  const sorted = [...items].sort((a, b) =>
    key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0,
  )
  for (let index = 1; index < sorted.length; index++)
    if (key(sorted[index - 1]) === key(sorted[index]))
      fail(`duplicate ${name} id`)
  return sorted
}

function addJson(
  files: NativeBackupFileEntry[],
  path: string,
  kind: NativeBackupEntityKind,
  value: unknown,
) {
  files.push({ path, kind, bytes: jsonBytes(value) })
}

const relationKey = (left: string, right: string) =>
  JSON.stringify([left, right])

function sortedRelationships(
  relationships: NativeBackupRelationships,
): NativeBackupRelationships {
  const byKey =
    <T>(key: (value: T) => string) =>
    (left: T, right: T) =>
      key(left) < key(right) ? -1 : key(left) > key(right) ? 1 : 0
  return {
    projectChats: [...relationships.projectChats].sort(
      byKey(({ projectId, chatId }) => relationKey(projectId, chatId)),
    ),
    projectDocuments: [...relationships.projectDocuments].sort(
      byKey(({ projectId, documentId }) => relationKey(projectId, documentId)),
    ),
    chatImages: [...relationships.chatImages].sort(
      byKey(({ chatId, imageId }) => relationKey(chatId, imageId)),
    ),
  }
}

export function formatNativeBackupV1(input: NativeBackupFormatInput): {
  manifestBytes: Uint8Array
  files: NativeBackupFileEntry[]
} {
  z.string().uuid().parse(input.backupId)
  z.string().datetime({ offset: true }).parse(input.createdAt)
  const projects = sortedUnique(
    input.projects.map((value) => NativeBackupProjectSchema.parse(value)),
    'project',
  )
  const documents = sortedUnique(
    input.projectDocuments.map((value) =>
      NativeBackupProjectDocumentSchema.parse(value),
    ),
    'project document',
    ({ projectId, id }) => `${idComponent(projectId)}/${idComponent(id)}`,
  )
  const cloudChats = sortedUnique(
    input.cloudChats.map((value) => NativeBackupChatSchema.parse(value)),
    'cloud chat',
  )
  const localChats = sortedUnique(
    input.localChats.map((value) => NativeBackupChatSchema.parse(value)),
    'local chat',
  )
  const chatIds = new Set(cloudChats.map(({ id }) => id))
  for (const { id } of localChats) {
    if (chatIds.has(id))
      fail('chat ids must be unique across cloud and local chats')
    chatIds.add(id)
  }
  const images = sortedUnique(
    input.images.map(({ metadata, bytes }) => ({
      ...NativeBackupImageSchema.parse(metadata),
      sizeBytes: bytes.length,
      bytes,
    })),
    'image',
  )
  const relationships = sortedRelationships(
    NativeBackupRelationshipsSchema.parse(input.relationships),
  )
  const files: NativeBackupFileEntry[] = []
  for (const value of projects)
    addJson(files, `projects/${idComponent(value.id)}.json`, 'projects', value)
  for (const value of documents)
    addJson(
      files,
      `project_documents/${idComponent(value.projectId)}/${idComponent(value.id)}.json`,
      'project_documents',
      value,
    )
  for (const value of cloudChats)
    addJson(
      files,
      `cloud_chats/${idComponent(value.id)}.json`,
      'cloud_chats',
      value,
    )
  for (const value of localChats)
    addJson(
      files,
      `local_chats/${idComponent(value.id)}.json`,
      'local_chats',
      value,
    )
  addJson(files, 'relationships.json', 'relationships', relationships)
  for (const { bytes, ...metadata } of images) {
    const base = `images/${idComponent(metadata.id)}`
    addJson(files, `${base}.json`, 'images', metadata)
    files.push({ path: `${base}.bin`, kind: 'images', bytes })
  }
  files.sort((a, b) => (a.path < b.path ? -1 : 1))
  const counts = {
    projects: projects.length,
    project_documents: documents.length,
    cloud_chats: cloudChats.length,
    local_chats: localChats.length,
    relationships: relationshipCount(relationships),
    images: images.length,
    files: files.length,
  }
  const manifest: NativeBackupManifestV1 = {
    format: NATIVE_BACKUP_FORMAT,
    version: NATIVE_BACKUP_VERSION,
    backup_id: input.backupId,
    created_at: input.createdAt,
    complete: true,
    counts,
    notices: {
      contains_plaintext: true,
      documents_are_extracted_text_only: true,
    },
    files: files.map(({ path, kind, bytes }) => ({
      path,
      kind,
      sha256: hash(bytes),
      size_bytes: bytes.length,
    })),
  }
  const manifestBytes = jsonBytes(manifest)
  assertSemanticContent(
    projects,
    documents,
    [...cloudChats, ...localChats],
    relationships,
    images,
  )
  assertNativeBackupSizeLimits(
    manifestBytes.length,
    files.map(({ path, bytes }) => ({ path, sizeBytes: bytes.length })),
  )
  return { manifestBytes, files }
}

export function formatNativeBackupV2(input: NativeBackupV2Input): {
  manifestBytes: Uint8Array
  files: NativeBackupFileEntry[]
} {
  assertNativeBackupOmissionsConsistent(
    input.omissions,
    input.projects,
    input.projectDocuments,
    input.cloudChats,
    input.localChats,
    input.relationships,
    input.images.map(({ metadata }) => metadata),
  )
  const formatted = formatNativeBackupV1(input)
  const v1 = parseNativeBackupManifestV1(formatted.manifestBytes)
  const manifest: NativeBackupManifestV2 = manifestV2Schema.parse({
    ...v1,
    version: NATIVE_BACKUP_VERSION_V2,
    complete: input.omissions.length === 0,
    omissions: input.omissions,
    warnings: input.warnings,
  })
  assertNativeBackupV2Metadata(manifest)
  const manifestBytes = jsonBytes(manifest)
  assertNativeBackupSizeLimits(
    manifestBytes.length,
    formatted.files.map(({ path, bytes }) => ({
      path,
      sizeBytes: bytes.length,
    })),
  )
  return { manifestBytes, files: formatted.files }
}

function exactRelations(values: string[], wanted: Set<string>, name: string) {
  const actual = new Set(values)
  if (actual.size !== values.length) fail(`duplicate ${name} relationship`)
  if (actual.size !== wanted.size || values.some((value) => !wanted.has(value)))
    fail(`${name} relationships do not match entities`)
}

export function assertSemanticContent(
  projects: NativeBackupProject[],
  documents: NativeBackupProjectDocument[],
  chats: NativeBackupChat[],
  relationships: NativeBackupRelationships,
  images: NativeBackupImage[],
) {
  const projectIds = new Set(projects.map(({ id }) => id))
  const chatIds = new Set(chats.map(({ id }) => id))
  const documentIds = new Set(
    documents.map(({ projectId, id }) => relationKey(projectId, id)),
  )
  const imageIds = new Set(images.map(({ id }) => id))
  if (projectIds.size !== projects.length || chatIds.size !== chats.length)
    fail('duplicate entity id')
  if (documentIds.size !== documents.length || imageIds.size !== images.length)
    fail('duplicate entity id')
  const expectedDocuments = new Set(
    documents.map(({ projectId, id }) => {
      if (!projectIds.has(projectId))
        fail('document references unknown project')
      return relationKey(projectId, id)
    }),
  )
  const expectedChats = new Set(
    chats.flatMap(({ id, projectId }) => {
      if (!projectId) return []
      if (!projectIds.has(projectId)) fail('chat references unknown project')
      return [relationKey(projectId, id)]
    }),
  )
  exactRelations(
    relationships.projectDocuments.map(({ projectId, documentId }) => {
      if (
        !projectIds.has(projectId) ||
        !documentIds.has(relationKey(projectId, documentId))
      )
        fail('project document relationship references unknown entity')
      return relationKey(projectId, documentId)
    }),
    expectedDocuments,
    'project document',
  )
  exactRelations(
    relationships.projectChats.map(({ projectId, chatId }) => {
      if (!projectIds.has(projectId) || !chatIds.has(chatId))
        fail('project chat relationship references unknown entity')
      return relationKey(projectId, chatId)
    }),
    expectedChats,
    'project chat',
  )
  exactRelations(
    relationships.chatImages.map(({ chatId, imageId }) => {
      if (!chatIds.has(chatId) || !imageIds.has(imageId))
        fail('chat image relationship references unknown entity')
      return relationKey(chatId, imageId)
    }),
    new Set(images.map(({ chatId, id }) => relationKey(chatId, id))),
    'chat image',
  )
  let messages = 0
  let attachments = 0
  const referencedImages = new Set<string>()
  const imageById = new Map(images.map((image) => [image.id, image]))
  for (const chat of chats) {
    messages += chat.messages.length
    chat.messages.forEach((message, messageIndex) => {
      const referenceImage = (
        imageId: string,
        location: Pick<
          NativeBackupImage,
          'attachmentId' | 'page' | 'legacyIndex'
        >,
      ) => {
        const image = imageById.get(imageId)
        if (!image || referencedImages.has(imageId))
          fail('message has an invalid or duplicate image reference')
        if (
          image.chatId !== chat.id ||
          image.messageIndex !== messageIndex ||
          image.attachmentId !== location.attachmentId ||
          image.page !== location.page ||
          image.legacyIndex !== location.legacyIndex
        )
          fail('image descriptor does not match its message reference')
        referencedImages.add(imageId)
      }
      attachments += message.attachments?.length
        ? message.attachments.length
        : (message.imageData?.length ?? 0) + (message.documents?.length ?? 0)
      for (const attachment of message.attachments ?? []) {
        if (attachment.type === 'image')
          referenceImage(attachment.imageId, { attachmentId: attachment.id })
        for (const page of attachment.type === 'document'
          ? (attachment.pages ?? [])
          : [])
          if (page.imageId)
            referenceImage(page.imageId, {
              attachmentId: attachment.id,
              page: page.page,
            })
      }
      for (const [legacyIndex, image] of (message.imageData ?? []).entries())
        referenceImage(image.imageId, { legacyIndex })
    })
  }
  if (referencedImages.size !== images.length)
    fail('image is not referenced by a message')
  if (messages > NATIVE_BACKUP_LIMITS.messages) fail('message limit exceeded')
  if (attachments > NATIVE_BACKUP_LIMITS.attachments)
    fail('attachment limit exceeded')
}
