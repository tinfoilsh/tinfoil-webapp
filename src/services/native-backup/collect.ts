import type { Attachment } from '@/components/chat/types'
import { AUTH_ACTIVE_USER_ID } from '@/constants/storage-keys'
import {
  AuthTokenRefreshError,
  AuthTokenUnavailableError,
  authTokenManager,
} from '@/services/auth'
import {
  unwrapBackupPullResult,
  type BackupPullResult,
} from '@/services/cloud/backup-read-error'
import { requirePrimaryKeyB64 } from '@/services/cloud/cek-encoding'
import {
  CloudBackupReadError,
  cloudStorage,
} from '@/services/cloud/cloud-storage'
import {
  decodeDocumentPayload,
  isOffloadedDocument,
} from '@/services/cloud/document-payload'
import { projectStorage } from '@/services/cloud/project-storage'
import {
  indexedDBStorage,
  type StoredChat,
} from '@/services/storage/indexed-db'
import { SyncEnclaveError } from '@/services/sync-enclave'
import {
  backupInventory,
  type BackupInventoryItem,
  type BackupInventoryResponse,
} from '@/services/sync-enclave/sync-api'
import type { Project, ProjectDocument } from '@/types/project'
import { base64ToUint8Array } from '@/utils/binary-codec'
import { z } from 'zod'
import { NATIVE_BACKUP_LIMITS } from './constants'
import {
  deriveNativeBackupWarnings,
  type NativeBackupOmission,
  type NativeBackupV1Input,
  type NativeBackupV2Input,
} from './format'
import { detectNativeBackupImageMimeType } from './image-mime'
import {
  NativeBackupDataValidationError,
  classifyNativeBackupChat,
  sanitizeNativeBackupChat,
  sanitizeNativeBackupImage,
  sanitizeNativeBackupProject,
  sanitizeNativeBackupProjectDocument,
  sanitizeNativeBackupRelationships,
  type NativeBackupImageCandidate,
} from './sanitize'
const STABLE_READ_ATTEMPTS = 3
const ATTACHMENT_DOWNLOAD_CONCURRENCY = 4
// One enclave pull carries this many records. Bounds response size
// while collapsing per-record round trips on large accounts.
export const CLOUD_PULL_BATCH_SIZE = 20
const encoder = new TextEncoder()
type CloudInventoryItem = BackupInventoryItem
type DocumentItem = BackupInventoryItem & { project_id: string }
export type BackupReadRequest = { id: string; expectedEtag: string }
export type BackupDocumentReadRequest = BackupReadRequest & {
  projectId: string
}
export interface NativeBackupCollectionDependencies {
  isAuthenticated(): Promise<boolean>
  activeUserId(): string | null
  requireUnlockedCek(): void
  getCloudInventory(signal?: AbortSignal): Promise<BackupInventoryResponse>
  getCloudChats(
    requests: readonly BackupReadRequest[],
  ): Promise<BackupPullResult<StoredChat | null>[]>
  getCloudImage(value: Attachment): Promise<Uint8Array | null>
  getProjects(
    requests: readonly BackupReadRequest[],
  ): Promise<BackupPullResult<Project | null>[]>
  getDocuments(
    requests: readonly BackupDocumentReadRequest[],
  ): Promise<BackupPullResult<ProjectDocument | null>[]>
  getLocalChats(): Promise<StoredChat[]>
  getLocalChat(id: string): Promise<StoredChat | null>
}
export class NativeBackupCollectionError extends Error {
  constructor(
    public readonly kind: string,
    public readonly recordId: string,
    detail: string,
    public readonly category:
      | 'deleted'
      | 'unavailable'
      | 'invalid'
      | 'unstable'
      | 'systemic' = 'systemic',
    public readonly reason = 'collection_failed',
    public readonly omittable = false,
  ) {
    super(`Native backup collection failed for ${kind} ${recordId}: ${detail}`)
    this.name = 'NativeBackupCollectionError'
  }
}
function activeUserId() {
  try {
    return localStorage.getItem(AUTH_ACTIVE_USER_ID)
  } catch {
    return null
  }
}
const defaults: NativeBackupCollectionDependencies = {
  isAuthenticated: () => authTokenManager.isAuthenticated(),
  activeUserId,
  requireUnlockedCek: () => void requirePrimaryKeyB64(),
  getCloudInventory: backupInventory,
  getCloudChats: (requests) => cloudStorage.downloadChatsForBackup(requests),
  getCloudImage: (value) => cloudStorage.loadChatImageForBackup(value),
  getProjects: (requests) => projectStorage.getProjectsForBackup(requests),
  getDocuments: (requests) => projectStorage.getDocumentsForBackup(requests),
  getLocalChats: () => indexedDBStorage.getAllChats(),
  getLocalChat: (id) => indexedDBStorage.getChat(id),
}
function fail(kind: string, id: string, detail: string): never {
  throw new NativeBackupCollectionError(kind, id, detail)
}
function failItem(
  kind: string,
  id: string,
  detail: string,
  category: NativeBackupOmission['category'],
  reason: string,
): never {
  throw new NativeBackupCollectionError(
    kind,
    id,
    detail,
    category,
    reason,
    true,
  )
}
function isOmittableCollectionError(
  error: unknown,
): error is NativeBackupCollectionError & {
  category: NativeBackupOmission['category']
} {
  return (
    error instanceof NativeBackupCollectionError &&
    error.omittable &&
    error.category !== 'systemic'
  )
}
async function wait<T>(s: AbortSignal | undefined, read: () => Promise<T>) {
  s?.throwIfAborted()
  const value = await read()
  s?.throwIfAborted()
  return value
}
const detail = (error: unknown) =>
  error instanceof Error ? error.message : String(error)
const jsonSize = (value: unknown) =>
  encoder.encode(JSON.stringify(value)).length
function valid<T>(kind: string, id: string, parse: () => T): T {
  try {
    return parse()
  } catch (error) {
    if (error instanceof NativeBackupCollectionError) throw error
    if (
      !(error instanceof NativeBackupDataValidationError) &&
      !(error instanceof z.ZodError)
    )
      throw error
    return failItem(
      kind,
      id,
      `record is invalid: ${detail(error)}`,
      'invalid',
      'record_invalid',
    )
  }
}
function throwIfAuthenticationError(error: unknown) {
  if (
    error instanceof AuthTokenUnavailableError ||
    error instanceof AuthTokenRefreshError ||
    (error instanceof SyncEnclaveError && error.status === 401)
  )
    throw error
}
type CloudInventory = {
  chats: CloudInventoryItem[]
  projects: CloudInventoryItem[]
  documents: DocumentItem[]
  discovered: number
}
function groupCloudInventory(
  response: BackupInventoryResponse,
): CloudInventory {
  const chats: CloudInventoryItem[] = []
  const projects: CloudInventoryItem[] = []
  const documents: DocumentItem[] = []
  for (const item of response.items) {
    if (item.scope === 'chat') chats.push(item)
    else if (item.scope === 'project') projects.push(item)
    else documents.push(item as DocumentItem)
  }
  return { chats, projects, documents, discovered: response.total_items }
}
/**
 * Walk inventory items in fixed-size batches, one enclave round trip
 * per batch. Each item is handed a `read` thunk that consumes the
 * prefetched batch slot on its first call and falls back to a
 * single-record batch on retries, so `readRecord`'s per-record retry
 * semantics are unchanged.
 */
async function collectInBatches<I, R>(
  items: readonly I[],
  fetchBatch: (batch: readonly I[]) => Promise<BackupPullResult<R>[]>,
  handle: (item: I, read: () => Promise<R>) => Promise<void>,
  signal?: AbortSignal,
) {
  for (let start = 0; start < items.length; start += CLOUD_PULL_BATCH_SIZE) {
    const batch = items.slice(start, start + CLOUD_PULL_BATCH_SIZE)
    const results = await wait(signal, () => fetchBatch(batch))
    for (const [index, item] of batch.entries()) {
      let prefetched: BackupPullResult<R> | undefined = results[index]
      const read = async () => {
        if (prefetched) {
          const result = prefetched
          prefetched = undefined
          return unwrapBackupPullResult(result)
        }
        return unwrapBackupPullResult((await fetchBatch([item]))[0])
      }
      await handle(item, read)
    }
  }
}
async function mapLimitInOrder<T, R>(
  values: readonly T[],
  concurrency: number,
  fn: (value: T) => Promise<R>,
  consume: (result: R) => void,
  signal?: AbortSignal,
): Promise<R[]> {
  const output = new Array<R>(values.length)
  let nextIndex = 0
  let stopped = false
  let firstError: unknown
  const stop = (error: unknown) => {
    if (stopped) return
    stopped = true
    firstError = error
  }
  const worker = async () => {
    while (!stopped) {
      const index = nextIndex++
      if (index >= values.length) return
      try {
        const result = await wait(signal, () => fn(values[index]))
        if (stopped) return
        consume(result)
        output[index] = result
      } catch (error) {
        stop(error)
        return
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, worker),
  )
  if (stopped) throw firstError
  return output
}
type Pending = [number, number, number, number, number]
const budgetLimits: Array<[string, number]> = [
  ['message', NATIVE_BACKUP_LIMITS.messages],
  ['attachment', NATIVE_BACKUP_LIMITS.attachments],
  ['aggregate JSON size', NATIVE_BACKUP_LIMITS.aggregateJsonBytes],
  ['archive size', NATIVE_BACKUP_LIMITS.archiveBytes],
  ['archive entry', NATIVE_BACKUP_LIMITS.entries],
]
class Budget {
  private used: Pending = [0, 0, 0, 0, 1]
  private entityCount = 0
  entities(count: number) {
    this.entityCount += count
    this.limit('entity', this.entityCount, NATIVE_BACKUP_LIMITS.entities)
  }
  chat(value: ReturnType<typeof sanitizeNativeBackupChat>): Pending {
    const bytes = jsonSize(value)
    const count = value.messages.reduce(
      (sum, item) => sum + (item.attachments?.length ?? 0),
      0,
    )
    const pending: Pending = [value.messages.length, count, bytes, bytes, 1]
    this.check(pending)
    return pending
  }
  imageSize(bytes: Uint8Array) {
    this.limit('image size', bytes.length, NATIVE_BACKUP_LIMITS.imageBytes)
  }
  image(pending: Pending, metadata: unknown, bytes: Uint8Array) {
    this.imageSize(bytes)
    const json = jsonSize(metadata)
    pending[2] += json
    pending[3] += json + bytes.length
    pending[4] += 2
    this.check(pending)
  }
  json(value: unknown, entity = false) {
    const bytes = jsonSize(value)
    this.commit([0, 0, bytes, bytes, 1], entity)
  }
  metadata(value: unknown) {
    const bytes = jsonSize(value) + 1
    this.commit([0, 0, bytes, bytes, 0])
  }
  commit(value: Pending, entity = false) {
    if (entity) this.entities(1)
    this.check(value)
    value.forEach((amount, index) => (this.used[index] += amount))
  }
  private check(value: Pending) {
    budgetLimits.forEach(([label, limit], index) =>
      this.limit(label, this.used[index] + value[index], limit),
    )
  }
  private limit(label: string, value: number, maximum: number) {
    if (value > maximum) fail('limits', 'collection', `${label} limit exceeded`)
  }
}
async function readRecord<T>(
  kind: string,
  id: string,
  read: () => Promise<T | null>,
  signal?: AbortSignal,
  missing: {
    detail: string
    category: NativeBackupOmission['category']
    reason: string
  } = {
    detail: 'record is missing',
    category: 'deleted',
    reason: 'record_not_found',
  },
) {
  let lastError: NativeBackupCollectionError | undefined
  for (let attempt = 0; attempt < STABLE_READ_ATTEMPTS; attempt++) {
    try {
      const value = await wait(signal, read)
      return (
        value ??
        failItem(kind, id, missing.detail, missing.category, missing.reason)
      )
    } catch (error) {
      signal?.throwIfAborted()
      throwIfAuthenticationError(error)
      if (error instanceof CloudBackupReadError) {
        if (!error.omittable) throw error
        lastError = new NativeBackupCollectionError(
          kind,
          id,
          'record could not be read at the captured version',
          error.category === 'item_invalid'
            ? 'invalid'
            : error.category === 'snapshot_deleted'
              ? 'deleted'
              : error.category === 'snapshot_changed'
                ? 'unstable'
                : 'unavailable',
          error.reason,
          true,
        )
        if (
          error.category === 'snapshot_deleted' ||
          error.category === 'snapshot_changed'
        )
          throw lastError
      } else if (isOmittableCollectionError(error)) {
        lastError = error
      } else {
        throw error
      }
    }
  }
  throw lastError!
}
async function collectTimedInventoryItem<T, R>(
  kind: string,
  item: CloudInventoryItem,
  read: () => Promise<T | null>,
  sanitize: (value: unknown) => R,
  budget: Budget,
  signal?: AbortSignal,
) {
  const current = await readRecord(kind, item.id, read, signal)
  const value = valid(kind, item.id, () =>
    sanitize({
      ...current,
      createdAt: item.created_at,
      updatedAt: item.updated_at,
    }),
  )
  budget.json(value, true)
  return value
}
function portable(chat: StoredChat, images?: NativeBackupImageCandidate[]) {
  return sanitizeNativeBackupChat(chat, (candidate) => {
    images?.push(candidate)
    return candidate.sourceKey
  })
}
function imagePayload(chat: StoredChat, candidate: NativeBackupImageCandidate) {
  const message = chat.messages[candidate.messageIndex]
  const attachment =
    candidate.attachmentIndex === undefined
      ? undefined
      : message.attachments?.[candidate.attachmentIndex]
  return candidate.legacyIndex !== undefined
    ? message.imageData?.[candidate.legacyIndex]?.base64
    : candidate.page !== undefined
      ? attachment?.pages?.find(({ page }) => page === candidate.page)?.image
      : attachment?.base64
}
function localToken(chat: StoredChat) {
  const images: NativeBackupImageCandidate[] = []
  const value = valid('local chat', chat.id, () => portable(chat, images))
  return JSON.stringify([
    value,
    images.map((candidate) => [candidate, imagePayload(chat, candidate)]),
    chat.isLocalOnly,
    chat.isBlankChat,
    chat.isTemporary,
    chat.syncUserId,
    (chat as StoredChat & { userId?: string }).userId,
  ])
}
function localEligible(chat: StoredChat, userId: string) {
  const owned =
    chat.syncUserId === userId ||
    (chat as StoredChat & { userId?: string }).userId === userId
  return (
    chat.isLocalOnly === true &&
    classifyNativeBackupChat(chat, owned ? 'signed_in' : 'anonymous') ===
      'local'
  )
}
function localInventoryToken(chats: StoredChat[], userId: string): string {
  const values = chats.flatMap((chat) => {
    if (!localEligible(chat, userId)) return []
    try {
      return [[chat.id, localToken(chat)]]
    } catch (error) {
      if (isOmittableCollectionError(error))
        return [[chat.id, error.category, error.reason]]
      throw error
    }
  })
  values.sort((left, right) =>
    left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0,
  )
  return JSON.stringify(values)
}
// A synced document carries only its enclave key in the chat; the backup
// format stores document text inline, so fetch and decode the blob before
// the chat is sanitized. Fetch failures surface through the same
// omittable path image bytes use.
async function inflateOffloadedDocuments(
  chat: StoredChat,
  deps: NativeBackupCollectionDependencies,
  signal?: AbortSignal,
): Promise<StoredChat> {
  const messages = await Promise.all(
    chat.messages.map(async (message) => {
      if (!message.attachments?.some(isOffloadedDocument)) return message
      const attachments = await Promise.all(
        message.attachments.map(async (attachment) => {
          if (!isOffloadedDocument(attachment)) return attachment
          const bytes = await readRecord(
            'document',
            attachment.id,
            () => deps.getCloudImage(attachment),
            signal,
            {
              detail: 'document content is missing',
              category: 'unavailable',
              reason: 'attachment_not_found',
            },
          )
          return {
            ...attachment,
            ...decodeDocumentPayload(attachment.id, bytes),
          }
        }),
      )
      return { ...message, attachments }
    }),
  )
  return { ...chat, messages }
}

async function collectChat(
  chat: StoredChat,
  cloud: boolean,
  deps: NativeBackupCollectionDependencies,
  budget: Budget,
  signal?: AbortSignal,
  allowPartial = false,
) {
  const candidates: NativeBackupImageCandidate[] = []
  const value = valid(cloud ? 'cloud chat' : 'local chat', chat.id, () =>
    portable(chat, candidates),
  )
  type SuccessfulImage = {
    candidate: NativeBackupImageCandidate
    metadata: ReturnType<typeof sanitizeNativeBackupImage>
    bytes: Uint8Array
    mimeType: string
  }
  let pending: Pending | undefined
  const successful: SuccessfulImage[] = []
  const omitted: Array<{
    candidate: NativeBackupImageCandidate
    failure: NativeBackupCollectionError
  }> = []
  if (allowPartial) {
    const allImagesOmitted = structuredClone(value)
    removeOmittedImageReferences(
      allImagesOmitted,
      candidates.map((candidate) => ({ candidate })),
      [],
    )
    pending = budget.chat(allImagesOmitted)
  } else {
    pending = budget.chat(value)
  }
  const results = await mapLimitInOrder(
    candidates,
    ATTACHMENT_DOWNLOAD_CONCURRENCY,
    async (candidate) => {
      try {
        const attachment =
          candidate.attachmentIndex === undefined
            ? undefined
            : chat.messages[candidate.messageIndex].attachments?.[
                candidate.attachmentIndex
              ]
        const base64 = imagePayload(chat, candidate)
        let bytes: Uint8Array | null = null
        if (base64) {
          try {
            bytes = base64ToUint8Array(base64)
          } catch (error) {
            if (
              !(error instanceof Error) ||
              error.name !== 'InvalidCharacterError'
            )
              throw error
            failItem(
              'image',
              candidate.sourceKey,
              'image bytes are invalid',
              'invalid',
              'attachment_payload_invalid',
            )
          }
        } else if (cloud && attachment) {
          bytes = await readRecord(
            'image',
            candidate.sourceKey,
            () => deps.getCloudImage(attachment),
            signal,
            {
              detail: 'image bytes are missing',
              category: 'unavailable',
              reason: 'attachment_not_found',
            },
          )
        }
        if (!bytes)
          failItem(
            'image',
            candidate.sourceKey,
            'image bytes are missing',
            'unavailable',
            'attachment_not_found',
          )
        const mimeType =
          detectNativeBackupImageMimeType(bytes) ??
          failItem(
            'image',
            candidate.sourceKey,
            'image type is unsupported',
            'invalid',
            'attachment_type_unsupported',
          )
        const metadata = valid('image', candidate.sourceKey, () =>
          sanitizeNativeBackupImage({
            ...candidate,
            id: candidate.sourceKey,
            mimeType,
            sizeBytes: bytes.length,
          }),
        )
        return { candidate, bytes, metadata, mimeType }
      } catch (error) {
        if (!allowPartial || !isOmittableCollectionError(error)) throw error
        return { candidate, failure: error }
      }
    },
    (result) => {
      if (!result.failure) budget.image(pending!, result.metadata, result.bytes)
    },
    signal,
  )
  for (const result of results) {
    if (result.failure) {
      omitted.push({ candidate: result.candidate, failure: result.failure })
      continue
    }
    const { candidate, bytes, metadata, mimeType } = result
    if (candidate.legacyIndex !== undefined)
      value.messages[candidate.messageIndex].imageData![
        candidate.legacyIndex
      ].mimeType = mimeType
    successful.push({ candidate, bytes, metadata, mimeType })
  }
  const images = successful.map(({ metadata, bytes }) => ({ metadata, bytes }))
  if (omitted.length) removeOmittedImageReferences(value, omitted, images)
  if (allowPartial) {
    pending = budget.chat(value)
    for (const image of images)
      budget.image(pending, image.metadata, image.bytes)
  }
  return { chat: value, images, pending: pending!, omitted }
}

function removeOmittedImageReferences(
  chat: ReturnType<typeof sanitizeNativeBackupChat>,
  omitted: Array<{ candidate: NativeBackupImageCandidate }>,
  images: Array<{ metadata: ReturnType<typeof sanitizeNativeBackupImage> }>,
) {
  const candidates = omitted.map(({ candidate }) => candidate)
  const pageCandidates = candidates.filter(
    ({ page, legacyIndex }) => page !== undefined && legacyIndex === undefined,
  )
  for (const candidate of pageCandidates) {
    const message = chat.messages[candidate.messageIndex]
    const attachment = message.attachments?.[candidate.attachmentIndex!]
    if (attachment?.type === 'document') {
      const page = attachment.pages?.find(({ page }) => page === candidate.page)
      if (page) delete page.imageId
    }
  }

  const directCandidates = candidates
    .filter(
      ({ attachmentIndex, page, legacyIndex }) =>
        attachmentIndex !== undefined &&
        page === undefined &&
        legacyIndex === undefined,
    )
    .sort(
      (left, right) =>
        right.messageIndex - left.messageIndex ||
        right.attachmentIndex! - left.attachmentIndex!,
    )
  for (const candidate of directCandidates)
    chat.messages[candidate.messageIndex].attachments?.splice(
      candidate.attachmentIndex!,
      1,
    )

  const legacyCandidates = candidates
    .filter(({ legacyIndex }) => legacyIndex !== undefined)
    .sort(
      (left, right) =>
        right.messageIndex - left.messageIndex ||
        right.legacyIndex! - left.legacyIndex!,
    )
  for (const candidate of legacyCandidates)
    chat.messages[candidate.messageIndex].imageData?.splice(
      candidate.legacyIndex!,
      1,
    )
  for (const { metadata } of images) {
    if (metadata.legacyIndex === undefined) continue
    metadata.legacyIndex -= legacyCandidates.filter(
      (candidate) =>
        candidate.messageIndex === metadata.messageIndex &&
        candidate.legacyIndex! < metadata.legacyIndex!,
    ).length
  }
}
async function retryChat<K>(
  kind: string,
  id: string,
  expected: K,
  read: () => Promise<StoredChat | null>,
  revision: (chat: StoredChat) => K,
  eligible: (chat: StoredChat) => boolean,
  refresh: (chat: StoredChat) => Promise<K>,
  collect: (chat: StoredChat) => ReturnType<typeof collectChat>,
  signal?: AbortSignal,
) {
  for (let attempt = 0; attempt < STABLE_READ_ATTEMPTS; attempt++) {
    const chat = await readRecord(kind, id, read, signal)
    const current = revision(chat)
    if (current !== expected) {
      expected = await wait(signal, () => refresh(chat))
      continue
    }
    if (!eligible(chat)) return null
    const result = await collect(chat)
    const verify = await readRecord(kind, id, read, signal)
    if (revision(verify) === current) return result
    expected = await wait(signal, () => refresh(verify))
  }
  return failItem(
    kind,
    id,
    'version changed during collection',
    'unstable',
    'version_did_not_converge',
  )
}

async function collectNativeBackup(
  deps: NativeBackupCollectionDependencies = defaults,
  signal?: AbortSignal,
  allowPartial = false,
): Promise<NativeBackupV2Input> {
  if (!(await wait(signal, () => deps.isAuthenticated())))
    fail('account', 'active', 'signed-in user is required')
  const userId = deps.activeUserId()
  if (!userId) fail('account', 'active', 'signed-in owner is unavailable')
  try {
    deps.requireUnlockedCek()
  } catch {
    fail('account', userId, 'cloud encryption key is locked or unavailable')
  }
  const response = await wait(signal, () => deps.getCloudInventory(signal))
  if (response.total_items > NATIVE_BACKUP_LIMITS.discoveredRecords)
    fail('limits', 'collection', 'discovered record limit exceeded')
  return collectNativeBackupAttempt(
    deps,
    groupCloudInventory(response),
    userId,
    signal,
    allowPartial,
  )
}

async function collectNativeBackupAttempt(
  deps: NativeBackupCollectionDependencies,
  inventory: CloudInventory,
  userId: string,
  signal?: AbortSignal,
  allowPartial = false,
  localInventoryAttempt = 0,
): Promise<NativeBackupV2Input> {
  const localSnapshots = await wait(signal, () => deps.getLocalChats())
  if (
    inventory.discovered + localSnapshots.length >
    NATIVE_BACKUP_LIMITS.discoveredRecords
  )
    fail('limits', 'collection', 'discovered record limit exceeded')
  const chatItems = inventory.chats
  const projectItems = inventory.projects
  const allDocumentItems = inventory.documents
  const initialLocalInventoryToken = localInventoryToken(localSnapshots, userId)
  const budget = new Budget()
  const omissions: NativeBackupOmission[] = []
  const addOmission = (omission: NativeBackupOmission) => {
    signal?.throwIfAborted()
    if (omissions.length >= NATIVE_BACKUP_LIMITS.omissions)
      fail('limits', 'collection', 'omission limit exceeded')
    budget.metadata(omission)
    omissions.push(omission)
  }
  const omit = (
    kind: NativeBackupOmission['kind'],
    sourceId: string,
    error: unknown,
    parentSourceId?: string,
  ) => {
    if (!allowPartial || !isOmittableCollectionError(error)) throw error
    addOmission({
      kind,
      source_id: sourceId,
      ...(parentSourceId ? { parent_source_id: parentSourceId } : {}),
      category: error.category,
      reason: error.reason,
    })
  }
  const projects: ReturnType<typeof sanitizeNativeBackupProject>[] = []
  await collectInBatches(
    projectItems,
    (batch) =>
      deps.getProjects(
        batch.map(({ id, etag }) => ({ id, expectedEtag: etag })),
      ),
    async (item, read) => {
      try {
        projects.push(
          await collectTimedInventoryItem(
            'project',
            item,
            read,
            sanitizeNativeBackupProject,
            budget,
            signal,
          ),
        )
      } catch (error) {
        omit('project', item.id, error)
      }
    },
    signal,
  )
  const includedProjectIds = new Set(projects.map(({ id }) => id))
  const documentItems = allDocumentItems.filter(({ project_id }) =>
    includedProjectIds.has(project_id),
  )
  const projectDocuments: ReturnType<
    typeof sanitizeNativeBackupProjectDocument
  >[] = []
  await collectInBatches(
    documentItems,
    (batch) =>
      deps.getDocuments(
        batch.map(({ project_id, id, etag }) => ({
          projectId: project_id,
          id,
          expectedEtag: etag,
        })),
      ),
    async (item, read) => {
      try {
        projectDocuments.push(
          await collectTimedInventoryItem(
            'project document',
            item,
            read,
            sanitizeNativeBackupProjectDocument,
            budget,
            signal,
          ),
        )
      } catch (error) {
        omit('project_document', item.id, error, item.project_id)
      }
    },
    signal,
  )
  for (const item of projectItems.filter(
    ({ id }) => !includedProjectIds.has(id),
  )) {
    for (const document of allDocumentItems.filter(
      ({ project_id }) => project_id === item.id,
    ))
      addOmission({
        kind: 'project_document',
        source_id: document.id,
        parent_source_id: item.id,
        category: 'unavailable',
        reason: 'parent_project_omitted',
      })
  }
  const cloudResults: Awaited<ReturnType<typeof collectChat>>[] = []
  await collectInBatches(
    chatItems,
    (batch) =>
      deps.getCloudChats(
        batch.map(({ id, etag }) => ({ id, expectedEtag: etag })),
      ),
    async (listed, read) => {
      try {
        const chat = await readRecord('cloud chat', listed.id, read, signal)
        const capturedChat = {
          ...(await inflateOffloadedDocuments(chat, deps, signal)),
          createdAt: listed.created_at,
          updatedAt: listed.updated_at,
          projectId: listed.project_id,
        }
        if (classifyNativeBackupChat(capturedChat, 'cloud') === null) return
        const result = await collectChat(
          capturedChat,
          true,
          deps,
          budget,
          signal,
          allowPartial,
        )
        budget.commit(result.pending, true)
        cloudResults.push(result)
        for (const { failure } of result.omitted)
          omit('attachment', failure.recordId, failure, listed.id)
      } catch (error) {
        omit('cloud_chat', listed.id, error)
      }
    },
    signal,
  )
  const localResults = []
  for (const snapshot of localSnapshots) {
    if (!localEligible(snapshot, userId)) continue
    try {
      const result = await retryChat(
        'local chat',
        snapshot.id,
        localToken(snapshot),
        () => deps.getLocalChat(snapshot.id),
        localToken,
        (chat) => localEligible(chat, userId),
        async (chat) => localToken(chat),
        (chat) => collectChat(chat, false, deps, budget, signal, allowPartial),
        signal,
      )
      if (!result) continue
      budget.commit(result.pending, true)
      localResults.push(result)
      for (const { failure } of result.omitted)
        omit('attachment', failure.recordId, failure, snapshot.id)
    } catch (error) {
      omit('local_chat', snapshot.id, error)
    }
  }
  const cloudChats = cloudResults.map(({ chat }) => chat)
  const localChats = localResults.map(({ chat }) => chat)
  for (const chat of [...cloudChats, ...localChats]) {
    if (chat.projectId && !includedProjectIds.has(chat.projectId)) {
      addOmission({
        kind: 'relationship',
        source_id: chat.id,
        parent_source_id: chat.projectId,
        category: 'unavailable',
        reason: 'project_reference_unavailable',
      })
      delete chat.projectId
    }
  }
  const images = [...cloudResults, ...localResults].flatMap(
    ({ images }) => images,
  )
  const relationships = sanitizeNativeBackupRelationships({
    projectChats: [...cloudChats, ...localChats].flatMap((chat) =>
      chat.projectId ? [{ projectId: chat.projectId, chatId: chat.id }] : [],
    ),
    projectDocuments: projectDocuments.map(({ projectId, id }) => ({
      projectId,
      documentId: id,
    })),
    chatImages: images.map(({ metadata }) => ({
      chatId: metadata.chatId,
      imageId: metadata.id,
    })),
  })
  budget.json(relationships)
  signal?.throwIfAborted()
  const finalLocalSnapshots = await wait(signal, () => deps.getLocalChats())
  if (
    inventory.discovered + finalLocalSnapshots.length >
    NATIVE_BACKUP_LIMITS.discoveredRecords
  )
    fail('limits', 'collection', 'discovered record limit exceeded')
  const localChanged =
    localInventoryToken(finalLocalSnapshots, userId) !==
    initialLocalInventoryToken
  if (localChanged) {
    if (localInventoryAttempt + 1 < NATIVE_BACKUP_LIMITS.localInventoryAttempts)
      return collectNativeBackupAttempt(
        deps,
        inventory,
        userId,
        signal,
        allowPartial,
        localInventoryAttempt + 1,
      )
    if (!allowPartial)
      fail('inventory', 'local', 'local inventory did not converge')
    addOmission({
      kind: 'local_inventory',
      source_id: 'eligible_local_chats',
      category: 'unstable',
      reason: 'inventory_did_not_converge',
    })
  }
  const warnings = deriveNativeBackupWarnings(omissions)
  for (const warning of warnings) budget.metadata(warning)
  const input: NativeBackupV2Input = {
    backupId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    projects,
    projectDocuments,
    cloudChats,
    localChats,
    relationships,
    images,
    omissions,
    warnings,
  }
  return input
}

export async function collectNativeBackupV1(
  deps: NativeBackupCollectionDependencies = defaults,
  signal?: AbortSignal,
): Promise<NativeBackupV1Input> {
  return collectNativeBackup(deps, signal, false)
}

export async function collectNativeBackupV2(
  deps: NativeBackupCollectionDependencies = defaults,
  signal?: AbortSignal,
): Promise<NativeBackupV2Input> {
  return collectNativeBackup(deps, signal, true)
}
