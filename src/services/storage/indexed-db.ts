import type {
  Attachment,
  Chat as ChatType,
  Message,
  PendingRecoveryEnvelope,
} from '@/components/chat/types'
import { ACCOUNT_RESET_FAILED_EVENT } from '@/constants/auth-events'
import {
  AUTH_ACCOUNT_RESET_FAILED,
  AUTH_ACCOUNT_RESET_SIGNAL,
  AUTH_ACTIVE_USER_ID,
} from '@/constants/storage-keys'
import { nextClock } from '@/services/cloud/edit-clock'
import type { Project } from '@/types/project'
import { logError, logWarning } from '@/utils/error-handling'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { deletedChatsTracker } from './deleted-chats-tracker'

export interface Chat extends Omit<ChatType, 'createdAt'> {
  createdAt: string
  updatedAt: string
  model?: string
}

export interface StoredChat extends Chat {
  lastAccessedAt: number
  syncedAt?: number
  locallyModified?: boolean
  syncPending?: 0 | 1
  syncVersion?: number
  formatVersion?: number
  decryptionFailed?: boolean
  dataCorrupted?: boolean
  version?: number
  loadedAt?: number
  isLocalOnly?: boolean
  isBlankChat?: boolean
  // Logical edit clock for conflict arbitration. `clock`/`writer` are
  // bumped on each local content edit; `clockVersion` records the
  // syncVersion the clock was last maintained at, so a reader can tell
  // whether a clock-unaware client wrote since (see remoteWins).
  clock?: number
  writer?: string
  clockVersion?: number
  pendingUpload?: 0 | 1
  syncUserId?: string
  projectLocallyModified?: boolean
}

export interface ChatSyncMetadata {
  id: string
  messageCount: number
  projectId?: string
  decryptionFailed?: boolean
  dataCorrupted?: boolean
  locallyModified?: boolean
  syncedAt?: number
  updatedAt: string
  isLocalOnly?: boolean
  isBlankChat?: boolean
  isMetadataOnly?: boolean
}

export interface SaveChatResult {
  saved: boolean
  isLocalOnly: boolean
}

export interface ChatRecoverySummary {
  id: string
  pendingRecoveries: PendingRecoveryEnvelope[]
}

export interface SyncState {
  id: 'account'
  userId: string
  appliedRevision: string | null
  bootstrapped: boolean
}

interface StoredProject {
  cacheKey: string
  userId: string
  project: Project
}

export interface RemoteChatState {
  id: string
  revision: string
  kind: 'upsert' | 'delete'
  etag?: string
  keyId?: string
  projectId: string | null
  updatedAt: string
}

export interface SyncDeleteOutboxEntry {
  id: string
  userId: string
  idempotencyKey: string
  createdAt: number
}

interface StoredAttachmentPayload {
  id: string
  chatId: string
  base64?: string
  thumbnailBase64?: string
  textContent?: string
  pages?: Attachment['pages']
}

type StoredAttachmentReference = Attachment & {
  storagePayloadId?: string
}

/**
 * Rewrite emitted by the upload path when the enclave mints a fresh
 * attachment id + per-attachment key. `clientId` is what the local
 * attachment used before the upload; `serverId` and `encryptionKey`
 * are what the chat envelope was sealed with. `finalizeUpload`
 * applies these against the freshest local copy so we never mutate
 * the wrong attachment after a concurrent edit.
 */
export interface AttachmentRewrite {
  clientId: string
  serverId: string
  encryptionKey: string
  storagePayloadId?: string
}

export class AttachmentPayloadIdUnavailableError extends Error {
  readonly code = 'ATTACHMENT_PAYLOAD_ID_UNAVAILABLE'

  constructor() {
    super('Secure random UUID generation is unavailable')
    this.name = 'AttachmentPayloadIdUnavailableError'
  }
}

export class AttachmentPayloadReferenceAmbiguityError extends Error {
  readonly code = 'ATTACHMENT_PAYLOAD_REFERENCE_AMBIGUOUS'

  constructor() {
    super('Attachment payload reference is ambiguous')
    this.name = 'AttachmentPayloadReferenceAmbiguityError'
  }
}

export class AttachmentPayloadReferenceMissingError extends Error {
  readonly code = 'ATTACHMENT_PAYLOAD_REFERENCE_MISSING'

  constructor() {
    super('Attachment has no payload or remote retrieval identity')
    this.name = 'AttachmentPayloadReferenceMissingError'
  }
}

export class AttachmentPayloadMissingError extends Error {
  readonly code = 'ATTACHMENT_PAYLOAD_MISSING'

  constructor() {
    super('Stored attachment payload is missing')
    this.name = 'AttachmentPayloadMissingError'
  }
}

export const DB_NAME = 'tinfoil-chat'
export const DB_VERSION = 7
export const INDEXED_DB_UPGRADE_BLOCKED_EVENT = 'indexedDBUpgradeBlocked'
const CHATS_STORE = 'chats'
const CHATS_PROJECT_INDEX = 'projectId'
const CHATS_SYNC_PENDING_INDEX = 'syncPending'
const PROJECTS_STORE = 'projects'
const PROJECTS_USER_INDEX = 'userId'
const MIGRATIONS_STORE = 'migrations'
const SYNC_PENDING_MIGRATION_ID = 'sync-pending-v4'
const ATTACHMENT_PAYLOADS_STORE = 'attachmentPayloads'
const ATTACHMENT_PAYLOADS_CHAT_INDEX = 'chatId'
const GENERATED_ATTACHMENT_PAYLOAD_PREFIX = 'attachment-payload:'
const CHAT_SUMMARIES_STORE = 'chatSummaries'
const CHAT_SUMMARIES_MIGRATION_ID = 'chat-summaries-v6'
const SYNC_STATE_STORE = 'sync_state'
const REMOTE_CHAT_STATE_STORE = 'remote_chat_state'
const SYNC_OUTBOX_STORE = 'sync_outbox'
const ACCOUNT_SYNC_STATE_ID = 'account'
const ACCOUNT_CHANGE_RESET_TIMEOUT_MS = 10_000
const ACCOUNT_CHANGE_READ_ERROR = 'IndexedDB read superseded by account change'
const ACCOUNT_CHANGE_WRITE_ERROR =
  'IndexedDB write superseded by account change'
const CHAT_SYNC_BOOLEAN_FIELDS = [
  'decryptionFailed',
  'dataCorrupted',
  'locallyModified',
  'isLocalOnly',
  'isBlankChat',
] as const
let isUpgradeBlocked = false
const textEncoder = new TextEncoder()

export function isIndexedDBUpgradeBlocked(): boolean {
  return isUpgradeBlocked
}

function hashString(input: string): string {
  return bytesToHex(sha256(textEncoder.encode(input)))
}

function deserializeStoredChat(chat: StoredChat): StoredChat {
  if (!Array.isArray(chat.messages)) {
    throw new Error('Stored chat has invalid messages')
  }

  // Full rows always carry their real messages; drop summary markers that
  // an earlier write may have leaked so readers never mistake a hydrated
  // chat for a summary.
  const { isMetadataOnly, messageCount, ...fullChat } = chat

  return {
    ...fullChat,
    messages: chat.messages.map((message) => ({
      ...message,
      timestamp: message.timestamp ? new Date(message.timestamp) : new Date(),
    })),
  } as StoredChat
}

function toChatSyncMetadata(chat: unknown): ChatSyncMetadata {
  if (!chat || typeof chat !== 'object') {
    throw new Error('Stored chat has invalid sync metadata')
  }

  const rawChat = chat as Record<string, unknown>
  if (typeof rawChat.id !== 'string' || rawChat.id.trim().length === 0) {
    throw new Error('Stored chat has invalid sync metadata: id')
  }
  if (!Array.isArray(rawChat.messages)) {
    throw new Error('Stored chat has invalid sync metadata: messages')
  }
  if (
    typeof rawChat.updatedAt !== 'string' ||
    rawChat.updatedAt.trim().length === 0
  ) {
    throw new Error('Stored chat has invalid sync metadata: updatedAt')
  }
  if (
    rawChat.projectId !== undefined &&
    typeof rawChat.projectId !== 'string'
  ) {
    throw new Error('Stored chat has invalid sync metadata: projectId')
  }
  if (
    rawChat.syncedAt !== undefined &&
    (typeof rawChat.syncedAt !== 'number' || !Number.isFinite(rawChat.syncedAt))
  ) {
    throw new Error('Stored chat has invalid sync metadata: syncedAt')
  }
  for (const field of CHAT_SYNC_BOOLEAN_FIELDS) {
    if (rawChat[field] !== undefined && typeof rawChat[field] !== 'boolean') {
      throw new Error(`Stored chat has invalid sync metadata: ${field}`)
    }
  }

  return {
    id: rawChat.id,
    messageCount: rawChat.messages.length,
    projectId: rawChat.projectId as string | undefined,
    decryptionFailed: rawChat.decryptionFailed as boolean | undefined,
    dataCorrupted: rawChat.dataCorrupted as boolean | undefined,
    locallyModified: rawChat.locallyModified as boolean | undefined,
    syncedAt: rawChat.syncedAt as number | undefined,
    updatedAt: rawChat.updatedAt,
    isLocalOnly: rawChat.isLocalOnly as boolean | undefined,
    isBlankChat: rawChat.isBlankChat as boolean | undefined,
  }
}

/**
 * Computes a stable fingerprint for a chat's meaningful content.
 * Used to decide if a chat is "locally modified" (and should be re-uploaded).
 *
 * Intentionally ignores `updatedAt` so we don't treat "save time changed" as a content change.
 * Avoids hashing huge blobs (documentContent/image base64) by hashing or summarizing those fields.
 */
export function chatContentFingerprint(chat: {
  title?: string
  projectId?: string
  messages?: any[]
  pendingRecoveries?: any[]
}): string {
  const messages = (chat.messages || []).map((m) => ({
    role: m.role,
    content: m.content,
    turnId: m.turnId,
    thoughts: m.thoughts,
    isThinking: m.isThinking,
    thinkingDuration: m.thinkingDuration,
    isError: m.isError,
    timestamp: m.timestamp,
    timeline: m.timeline,
    // New format: hash attachment data to avoid huge fingerprints
    attachments:
      Array.isArray(m.attachments) && m.attachments.length > 0
        ? m.attachments.map((a: any) => ({
            id: a.id,
            type: a.type,
            fileName: a.fileName,
            mimeType: a.mimeType,
            fileSize: a.fileSize,
            description: a.description,
            encryptionKey: a.encryptionKey,
            base64Hash:
              typeof a.base64 === 'string' ? hashString(a.base64) : null,
            base64Length: typeof a.base64 === 'string' ? a.base64.length : 0,
            thumbnailBase64Hash:
              typeof a.thumbnailBase64 === 'string'
                ? hashString(a.thumbnailBase64)
                : null,
            thumbnailBase64Length:
              typeof a.thumbnailBase64 === 'string'
                ? a.thumbnailBase64.length
                : 0,
            textContentHash:
              typeof a.textContent === 'string'
                ? hashString(a.textContent)
                : null,
            textContentLength:
              typeof a.textContent === 'string' ? a.textContent.length : 0,
            pagesHash: Array.isArray(a.pages)
              ? hashString(JSON.stringify(a.pages))
              : null,
          }))
        : [],
    // Legacy fields — still included for old messages that haven't been migrated
    documents: m.documents,
    documentContentHash:
      typeof m.documentContent === 'string'
        ? hashString(m.documentContent)
        : null,
    documentContentLength:
      typeof m.documentContent === 'string' ? m.documentContent.length : 0,
    imageData:
      Array.isArray(m.imageData) && m.imageData.length > 0
        ? m.imageData.map((img: any) => ({
            mimeType: img?.mimeType,
            base64Hash:
              typeof img?.base64 === 'string' ? hashString(img.base64) : null,
            base64Length:
              typeof img?.base64 === 'string' ? img.base64.length : 0,
          }))
        : [],
  }))

  return JSON.stringify({
    title: chat.title ?? '',
    projectId: chat.projectId ?? null,
    messages,
    pendingRecoveries: chat.pendingRecoveries ?? [],
  })
}

/**
 * Determine whether a chat should be marked as locally modified (needing upload).
 *
 * Rules:
 * 1. Chats that failed decryption are NEVER marked modified — they are placeholders
 *    with empty messages that would overwrite real encrypted data on the server.
 * 2. Existing chats: mark modified if meaningful content changed, or preserve the
 *    existing modified flag so previously-dirty chats stay dirty.
 * 3. New chats: use the caller-provided value, defaulting to true.
 */
export function computeLocallyModified(opts: {
  isFailedDecryption: boolean
  existingChat: StoredChat | undefined
  hasContentChanges: boolean
  callerValue: boolean | undefined
}): boolean {
  if (opts.isFailedDecryption) {
    return false
  }
  if (opts.existingChat) {
    return opts.hasContentChanges || opts.existingChat.locallyModified === true
  }
  return opts.callerValue ?? true
}

export function chatNeedsSync(
  chat: Pick<
    StoredChat,
    'locallyModified' | 'syncedAt' | 'isLocalOnly' | 'decryptionFailed'
  >,
): 0 | 1 {
  if (chat.isLocalOnly || chat.decryptionFailed) return 0
  return chat.locallyModified === true || chat.syncedAt == null ? 1 : 0
}

export function resolveStoredLocalOnly(
  incoming: boolean | undefined,
  existing: boolean | undefined,
  allowExplicitChange = false,
): boolean {
  if (allowExplicitChange) return incoming === true
  return incoming === true || existing === true
}

function updateSyncPending(chat: StoredChat): StoredChat {
  chat.syncPending = chatNeedsSync(chat)
  return chat
}

function toStoredChatSummary(chat: StoredChat): StoredChat {
  return {
    ...chat,
    messages: [],
    messageCount: Array.isArray(chat.messages) ? chat.messages.length : 0,
    isMetadataOnly: true,
  }
}

function putStoredChat(
  chatStore: IDBObjectStore,
  summaryStore: IDBObjectStore,
  chat: StoredChat,
): IDBRequest<IDBValidKey> {
  const prepared = updateSyncPending(chat)
  summaryStore.put(toStoredChatSummary(prepared))
  // isMetadataOnly/messageCount describe summary rows only; persisting
  // them on the full row would make hydrated reads look like summaries.
  const { isMetadataOnly, messageCount, ...fullRow } = prepared
  return chatStore.put(fullRow)
}

/**
 * Copies mutable chat containers without duplicating immutable attachment
 * payload strings. New nested message fields must be snapshotted here.
 */
export function snapshotChatForStorage(chat: Chat): Chat {
  return {
    ...chat,
    pendingRecoveries: chat.pendingRecoveries?.map((recovery) => ({
      ...recovery,
    })),
    messages: chat.messages.map((message) => ({
      ...message,
      attachments: message.attachments?.map((attachment) => ({
        ...attachment,
        pages: attachment.pages?.map((page) => ({ ...page })),
      })),
      annotations: message.annotations?.map((annotation) => ({
        ...annotation,
        url_citation: { ...annotation.url_citation },
      })),
      codeExecCalls: message.codeExecCalls?.map((call) => ({ ...call })),
      documents: message.documents?.map((document) => ({ ...document })),
      imageData: message.imageData?.map((image) => ({ ...image })),
      timeline: message.timeline
        ? structuredClone(message.timeline)
        : undefined,
      toolCalls: message.toolCalls?.map((call) => ({ ...call })),
      urlFetches: message.urlFetches?.map((urlFetch) => ({
        ...urlFetch,
        sources: urlFetch.sources?.map((source) => ({ ...source })),
      })),
      webSearch: message.webSearch
        ? {
            ...message.webSearch,
            sources: message.webSearch.sources?.map((source) => ({
              ...source,
            })),
          }
        : undefined,
    })),
  }
}

function attachmentHasPayload(attachment: Attachment): boolean {
  return (
    attachment.base64 !== undefined ||
    attachment.thumbnailBase64 !== undefined ||
    attachment.textContent !== undefined ||
    attachment.pages !== undefined
  )
}

// Cloud copies keep image thumbnails but never the full-resolution bytes,
// so a thumbnail alone must not stop an image from adopting the payload
// already stored locally.
function attachmentMissingStoredContent(attachment: Attachment): boolean {
  return attachment.type === 'image'
    ? attachment.base64 === undefined
    : !attachmentHasPayload(attachment)
}

type AttachmentPayloadContent = Pick<
  StoredAttachmentPayload,
  'base64' | 'thumbnailBase64' | 'textContent' | 'pages'
>

function inheritMissingPayloadContent(
  target: StoredAttachmentReference,
  content: AttachmentPayloadContent,
): void {
  if (target.base64 === undefined && content.base64 !== undefined) {
    target.base64 = content.base64
  }
  if (
    target.thumbnailBase64 === undefined &&
    content.thumbnailBase64 !== undefined
  ) {
    target.thumbnailBase64 = content.thumbnailBase64
  }
  if (target.textContent === undefined && content.textContent !== undefined) {
    target.textContent = content.textContent
  }
  if (target.pages === undefined && content.pages !== undefined) {
    target.pages = content.pages
  }
}

function isLazilyRetrievableAttachment(attachment: Attachment): boolean {
  return (
    attachment.type === 'image' &&
    attachment.id.trim().length > 0 &&
    typeof attachment.encryptionKey === 'string' &&
    attachment.encryptionKey.trim().length > 0
  )
}

function createAttachmentPayloadId(
  chatId: string,
  reservedPayloadIds: Set<string>,
): string {
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    throw new AttachmentPayloadIdUnavailableError()
  }

  const token = globalThis.crypto.randomUUID()
  const encodedChatId = bytesToHex(textEncoder.encode(chatId))
  const baseId = `${GENERATED_ATTACHMENT_PAYLOAD_PREFIX}${encodedChatId}:${token}`
  let payloadId = baseId
  let collision = 0
  while (reservedPayloadIds.has(payloadId)) {
    collision += 1
    payloadId = `${baseId}:${collision}`
  }
  reservedPayloadIds.add(payloadId)
  return payloadId
}

function normalizeAttachmentPayloads(chat: Chat): {
  messages: Message[]
  payloads: StoredAttachmentPayload[]
  referencedPayloadIds: Set<string>
} {
  const payloads: StoredAttachmentPayload[] = []
  const referencedPayloadIds = new Set<string>()
  const attachmentIdOccurrences = new Map<string, number>()
  const reservedPayloadIds = new Set<string>()
  const explicitlyReferencedPayloadIds = new Set<string>()

  for (const message of chat.messages) {
    for (const attachment of message.attachments ?? []) {
      reservedPayloadIds.add(`${chat.id}:${attachment.id}`)
      const storagePayloadId = (attachment as StoredAttachmentReference)
        .storagePayloadId
      if (storagePayloadId) {
        reservedPayloadIds.add(storagePayloadId)
        explicitlyReferencedPayloadIds.add(storagePayloadId)
      }
    }
  }

  const messages = chat.messages.map((message) => ({
    ...message,
    attachments: message.attachments?.map((attachment) => {
      const storedAttachment = attachment as StoredAttachmentReference
      const occurrence = attachmentIdOccurrences.get(attachment.id) ?? 0
      attachmentIdOccurrences.set(attachment.id, occurrence + 1)
      const legacyPayloadId = `${chat.id}:${attachment.id}`
      const referencedPayloadId = storedAttachment.storagePayloadId
      const payloadId =
        referencedPayloadId && !referencedPayloadIds.has(referencedPayloadId)
          ? referencedPayloadId
          : occurrence === 0 &&
              !referencedPayloadIds.has(legacyPayloadId) &&
              !explicitlyReferencedPayloadIds.has(legacyPayloadId)
            ? legacyPayloadId
            : createAttachmentPayloadId(chat.id, reservedPayloadIds)
      referencedPayloadIds.add(payloadId)
      const { base64, thumbnailBase64, textContent, pages, ...metadata } =
        storedAttachment

      if (attachmentHasPayload(attachment)) {
        payloads.push({
          id: payloadId,
          chatId: chat.id,
          base64,
          thumbnailBase64,
          textContent,
          pages,
        })
      }

      return {
        ...metadata,
        storagePayloadId: payloadId,
      }
    }),
  }))

  return {
    messages,
    payloads,
    referencedPayloadIds,
  }
}

function normalizeAttachmentPayloadsInTransaction(
  chat: Chat,
  transaction: IDBTransaction,
  reject: (reason?: unknown) => void,
): ReturnType<typeof normalizeAttachmentPayloads> | null {
  try {
    return normalizeAttachmentPayloads(chat)
  } catch (error) {
    transaction.abort()
    reject(error)
    return null
  }
}

function inheritAttachmentPayloadReferences(
  chat: Chat,
  existing: StoredChat | null | undefined,
  existingPayloads: StoredAttachmentPayload[] = [],
): Chat {
  type PayloadCandidate = {
    payloadId: string
    messageKey: string
    attachmentKey: string
    used: boolean
  }
  const existingPayloadById = new Map(
    existingPayloads.map((payload) => [payload.id, payload]),
  )
  const adoptCandidate = (
    incoming: StoredAttachmentReference,
    candidate: PayloadCandidate,
  ) => {
    candidate.used = true
    incoming.storagePayloadId = candidate.payloadId
    const payload = existingPayloadById.get(candidate.payloadId)
    if (payload) inheritMissingPayloadContent(incoming, payload)
  }
  type IncomingAttachment = {
    attachment: StoredAttachmentReference
    messageKey: string
    attachmentKey: string
  }
  const candidatesByAttachmentId = new Map<string, PayloadCandidate[]>()
  const incomingByAttachmentId = new Map<string, IncomingAttachment[]>()

  const messageKey = (message: Message): string => {
    if (message.turnId) return `turn:${message.turnId}`
    const timestamp =
      message.timestamp instanceof Date
        ? message.timestamp.toISOString()
        : String(message.timestamp)
    return `${message.role}:${timestamp}`
  }
  const attachmentKey = (attachment: Attachment): string =>
    JSON.stringify([
      attachment.type,
      attachment.fileName,
      attachment.mimeType ?? null,
      attachment.fileSize ?? null,
      attachment.description ?? null,
      attachment.encryptionKey ?? null,
    ])

  for (const message of existing?.messages ?? []) {
    for (const attachment of message.attachments ?? []) {
      const storedAttachment = attachment as StoredAttachmentReference
      if (storedAttachment.storagePayloadId) {
        const candidates =
          candidatesByAttachmentId.get(storedAttachment.id) ?? []
        candidates.push({
          payloadId: storedAttachment.storagePayloadId,
          messageKey: messageKey(message),
          attachmentKey: attachmentKey(storedAttachment),
          used: false,
        })
        candidatesByAttachmentId.set(storedAttachment.id, candidates)
      }
    }
  }

  const messages = chat.messages.map((message) => ({
    ...message,
    attachments: message.attachments?.map((attachment) => {
      const clonedAttachment = { ...attachment } as StoredAttachmentReference
      const incoming = incomingByAttachmentId.get(attachment.id) ?? []
      incoming.push({
        attachment: clonedAttachment,
        messageKey: messageKey(message),
        attachmentKey: attachmentKey(attachment),
      })
      incomingByAttachmentId.set(attachment.id, incoming)
      return clonedAttachment
    }),
  }))

  for (const [attachmentId, incomingAttachments] of incomingByAttachmentId) {
    const candidates = candidatesByAttachmentId.get(attachmentId) ?? []

    for (const incoming of incomingAttachments) {
      if (!attachmentMissingStoredContent(incoming.attachment)) {
        continue
      }

      if (incoming.attachment.storagePayloadId) {
        const referenceMatches = candidates.filter(
          (candidate) =>
            !candidate.used &&
            candidate.payloadId === incoming.attachment.storagePayloadId &&
            candidate.attachmentKey === incoming.attachmentKey,
        )
        if (referenceMatches.length > 1) {
          throw new AttachmentPayloadReferenceAmbiguityError()
        }
        if (referenceMatches.length === 1) {
          adoptCandidate(incoming.attachment, referenceMatches[0])
          continue
        }
        if (isLazilyRetrievableAttachment(incoming.attachment)) {
          continue
        }
        throw new AttachmentPayloadReferenceMissingError()
      }

      const metadataMatches = candidates.filter(
        (candidate) =>
          !candidate.used && candidate.attachmentKey === incoming.attachmentKey,
      )
      const messageMatches = metadataMatches.filter(
        (candidate) => candidate.messageKey === incoming.messageKey,
      )
      const exactMatches =
        messageMatches.length > 0 ? messageMatches : metadataMatches

      if (exactMatches.length > 1) {
        throw new AttachmentPayloadReferenceAmbiguityError()
      }

      const candidate = exactMatches[0]
      if (candidate) {
        adoptCandidate(incoming.attachment, candidate)
        continue
      }

      if (!isLazilyRetrievableAttachment(incoming.attachment)) {
        throw new AttachmentPayloadReferenceMissingError()
      }
    }
  }

  return {
    ...chat,
    messages,
  }
}

// Rewrites match by the local payload reference first and fall back to
// the stable client id, so a rewrite can only relabel the attachment it
// was minted for even after the message list moved around.
export function applyAttachmentRewritesInPlace(
  messages: Message[],
  rewrites: AttachmentRewrite[],
): void {
  const rewritesByPayloadId = new Map(
    rewrites
      .filter((rewrite) => rewrite.storagePayloadId)
      .map((rewrite) => [rewrite.storagePayloadId, rewrite]),
  )
  const rewritesByClientId = new Map<string, AttachmentRewrite[]>()
  for (const rewrite of rewrites) {
    if (rewrite.storagePayloadId) continue
    const candidates = rewritesByClientId.get(rewrite.clientId) ?? []
    candidates.push(rewrite)
    rewritesByClientId.set(rewrite.clientId, candidates)
  }
  const appliedRewrites = new Set<AttachmentRewrite>()
  for (const msg of messages) {
    for (const att of msg.attachments ?? []) {
      const storedAttachment = att as StoredAttachmentReference
      const rewriteByPayloadId = storedAttachment.storagePayloadId
        ? rewritesByPayloadId.get(storedAttachment.storagePayloadId)
        : undefined
      const rewrite =
        rewriteByPayloadId && !appliedRewrites.has(rewriteByPayloadId)
          ? rewriteByPayloadId
          : rewritesByClientId
              .get(att.id)
              ?.find((candidate) => !appliedRewrites.has(candidate))
      if (rewrite) {
        appliedRewrites.add(rewrite)
        att.id = rewrite.serverId
        att.encryptionKey = rewrite.encryptionKey
      }
    }
  }
}

function hydrateAttachmentPayloads(
  chat: StoredChat,
  payloads: StoredAttachmentPayload[],
): StoredChat {
  const payloadById = new Map(payloads.map((payload) => [payload.id, payload]))

  return {
    ...chat,
    messages: chat.messages.map((message) => ({
      ...message,
      attachments: message.attachments?.map((attachment) => {
        const { storagePayloadId, ...metadata } =
          attachment as StoredAttachmentReference
        if (!storagePayloadId) {
          if (
            attachmentHasPayload(metadata) ||
            isLazilyRetrievableAttachment(metadata)
          ) {
            return metadata
          }
          throw new AttachmentPayloadMissingError()
        }
        const payload = storagePayloadId
          ? payloadById.get(storagePayloadId)
          : undefined
        if (!payload) {
          if (isLazilyRetrievableAttachment(metadata)) {
            return { ...metadata, storagePayloadId }
          }
          throw new AttachmentPayloadMissingError()
        }
        const { id, chatId, ...content } = payload
        return { ...metadata, storagePayloadId, ...content }
      }),
    })),
  }
}

function deleteAttachmentPayloadsForChat(
  store: IDBObjectStore,
  chatId: string,
): void {
  const request = store
    .index(ATTACHMENT_PAYLOADS_CHAT_INDEX)
    .openKeyCursor(IDBKeyRange.only(chatId))
  request.onsuccess = () => {
    const cursor = request.result
    if (!cursor) return
    store.delete(cursor.primaryKey)
    cursor.continue()
  }
}

export function derivePendingUpload(
  chat: Pick<
    StoredChat,
    | 'locallyModified'
    | 'isLocalOnly'
    | 'isBlankChat'
    | 'decryptionFailed'
    | 'dataCorrupted'
    | 'messages'
    | 'syncUserId'
  > & { isMetadataOnly?: boolean },
): 0 | 1 {
  return chat.locallyModified === true &&
    typeof chat.syncUserId === 'string' &&
    chat.syncUserId.length > 0 &&
    chat.isLocalOnly !== true &&
    chat.isBlankChat !== true &&
    chat.decryptionFailed !== true &&
    chat.dataCorrupted !== true &&
    chat.isMetadataOnly !== true &&
    // A malformed legacy row must fail closed without aborting DB migration.
    Array.isArray(chat.messages) &&
    chat.messages.length > 0
    ? 1
    : 0
}

/**
 * Whether the server may hold a row for this chat, i.e. a delete must
 * be propagated remotely rather than being purely local. Single
 * source of truth for the sync-delete eligibility predicate.
 */
function chatKnownToServer(
  chat: Pick<StoredChat, 'syncedAt' | 'syncVersion'>,
): boolean {
  return chat.syncedAt != null || (chat.syncVersion ?? 0) > 0
}

function syncDeleteOutboxEntry(
  id: string,
  userId: string,
  idempotencyKey: string,
): SyncDeleteOutboxEntry {
  return { id, userId, idempotencyKey, createdAt: Date.now() }
}

function activeUserId(): string | undefined {
  if (typeof window === 'undefined') return undefined
  try {
    return localStorage.getItem(AUTH_ACTIVE_USER_ID) ?? undefined
  } catch {
    return undefined
  }
}

function chatOwnerId(chat: StoredChat | Chat): string | undefined {
  return (
    (chat as StoredChat).syncUserId ??
    (chat as StoredChat & { userId?: string }).userId
  )
}

export class IndexedDBStorage {
  private db: IDBDatabase | null = null
  private initializationPromise: Promise<void> | null = null
  private saveQueue: Promise<unknown> = Promise.resolve()
  private syncPendingIndexReady = false
  private chatSummariesReady = false
  private saveGeneration = 0
  // Account cleanup always reloads; keep this instance fail-closed until then.
  private accountResetStarted = false
  private accountResetPromise: Promise<void> | null = null
  private activeSaveGeneration: number | null = null
  private readonly accountResetSignal: Promise<never>
  private rejectAccountReads!: (reason: Error) => void

  constructor() {
    this.accountResetSignal = new Promise((_, reject) => {
      this.rejectAccountReads = reject
    })
    void this.accountResetSignal.catch(() => {})
  }

  async initialize(): Promise<void> {
    if (this.db) return
    if (this.initializationPromise) return this.initializationPromise

    // Check if IndexedDB is available
    if (typeof window === 'undefined' || !window.indexedDB) {
      throw new Error('IndexedDB not available')
    }

    const saveGeneration = this.saveGeneration
    const initializationPromise = new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION)
      let abandoned = false

      request.onerror = (event) => {
        const error = (event.target as IDBOpenDBRequest).error
        logError('IndexedDB open error', error, {
          component: 'IndexedDBStorage',
        })
        reject(
          new Error(
            `Failed to open database: ${error?.message || 'Unknown error'}`,
          ),
        )
      }

      request.onsuccess = () => {
        if (abandoned) {
          request.result.close()
          return
        }
        isUpgradeBlocked = false
        const db = request.result
        db.onversionchange = () => {
          db.close()
          if (this.db === db) {
            this.db = null
          }
        }

        if (saveGeneration !== this.saveGeneration) {
          db.close()
          reject(new Error('Database open superseded by account change'))
          return
        }

        this.db = db
        resolve()
      }

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result

        try {
          if (!db.objectStoreNames.contains(CHATS_STORE)) {
            const store = db.createObjectStore(CHATS_STORE, { keyPath: 'id' })
            store.createIndex('lastAccessedAt', 'lastAccessedAt', {
              unique: false,
            })
            store.createIndex('createdAt', 'createdAt', { unique: false })
            // Add sync-related indexes
            store.createIndex('syncedAt', 'syncedAt', { unique: false })
            store.createIndex(CHATS_SYNC_PENDING_INDEX, 'syncPending', {
              unique: false,
            })
            store.createIndex(CHATS_PROJECT_INDEX, 'projectId', {
              unique: false,
            })
            store.createIndex(
              'pendingUploadByUser',
              ['pendingUpload', 'syncUserId'],
              { unique: false },
            )
          } else {
            const store = request.transaction!.objectStore(CHATS_STORE)
            if (store.indexNames.contains('locallyModified')) {
              store.deleteIndex('locallyModified')
            }
            if (!store.indexNames.contains(CHATS_PROJECT_INDEX)) {
              store.createIndex(CHATS_PROJECT_INDEX, 'projectId', {
                unique: false,
              })
            }
            if (!store.indexNames.contains(CHATS_SYNC_PENDING_INDEX)) {
              store.createIndex(CHATS_SYNC_PENDING_INDEX, 'syncPending', {
                unique: false,
              })
            }
            if (store.indexNames.contains('pendingUpload')) {
              store.deleteIndex('pendingUpload')
            }
            if (!store.indexNames.contains('pendingUploadByUser')) {
              store.createIndex(
                'pendingUploadByUser',
                ['pendingUpload', 'syncUserId'],
                { unique: false },
              )
            }
            const cursorRequest = store.openCursor()
            cursorRequest.onsuccess = () => {
              const cursor = cursorRequest.result
              if (!cursor) return
              const chat = cursor.value as StoredChat
              chat.syncUserId ??= chatOwnerId(chat) ?? activeUserId()
              chat.pendingUpload = derivePendingUpload(chat)
              chat.syncPending = chatNeedsSync(chat)
              cursor.update(chat)
              cursor.continue()
            }
          }
          if (!db.objectStoreNames.contains(PROJECTS_STORE)) {
            const store = db.createObjectStore(PROJECTS_STORE, {
              keyPath: 'cacheKey',
            })
            store.createIndex(PROJECTS_USER_INDEX, 'userId', { unique: false })
          }
          if (!db.objectStoreNames.contains(SYNC_STATE_STORE)) {
            db.createObjectStore(SYNC_STATE_STORE, { keyPath: 'id' })
          }
          if (!db.objectStoreNames.contains(REMOTE_CHAT_STATE_STORE)) {
            db.createObjectStore(REMOTE_CHAT_STATE_STORE, {
              keyPath: 'id',
            })
          } else {
            const store = request.transaction!.objectStore(
              REMOTE_CHAT_STATE_STORE,
            )
            if (store.indexNames.contains('updatedAt')) {
              store.deleteIndex('updatedAt')
            }
          }
          if (!db.objectStoreNames.contains(SYNC_OUTBOX_STORE)) {
            const store = db.createObjectStore(SYNC_OUTBOX_STORE, {
              keyPath: ['userId', 'id'],
            })
            store.createIndex('userId', 'userId', { unique: false })
          }
          if (!db.objectStoreNames.contains(MIGRATIONS_STORE)) {
            db.createObjectStore(MIGRATIONS_STORE, { keyPath: 'id' })
          }
          if (!db.objectStoreNames.contains(ATTACHMENT_PAYLOADS_STORE)) {
            const store = db.createObjectStore(ATTACHMENT_PAYLOADS_STORE, {
              keyPath: 'id',
            })
            store.createIndex(
              ATTACHMENT_PAYLOADS_CHAT_INDEX,
              ATTACHMENT_PAYLOADS_CHAT_INDEX,
              { unique: false },
            )
          }
          if (!db.objectStoreNames.contains(CHAT_SUMMARIES_STORE)) {
            db.createObjectStore(CHAT_SUMMARIES_STORE, { keyPath: 'id' })
          }
          if ((event as IDBVersionChangeEvent).oldVersion === 0) {
            const migrations =
              request.transaction?.objectStore(MIGRATIONS_STORE)
            migrations?.put({
              id: SYNC_PENDING_MIGRATION_ID,
              completedAt: Date.now(),
            })
            migrations?.put({
              id: CHAT_SUMMARIES_MIGRATION_ID,
              completedAt: Date.now(),
            })
          }
        } catch (error) {
          logError('Failed to create object store', error, {
            component: 'IndexedDBStorage',
          })
          reject(new Error(`Failed to upgrade database: ${error}`))
        }
      }

      request.onblocked = () => {
        abandoned = true
        isUpgradeBlocked = true
        logWarning('IndexedDB upgrade blocked - close other tabs', {
          component: 'IndexedDBStorage',
        })
        window.dispatchEvent(new Event(INDEXED_DB_UPGRADE_BLOCKED_EVENT))
        reject(new Error('Database upgrade blocked'))
      }
    })

    this.initializationPromise = initializationPromise

    try {
      await initializationPromise
    } finally {
      if (this.initializationPromise === initializationPromise) {
        this.initializationPromise = null
      }
    }
  }

  private async ensureDB(): Promise<IDBDatabase> {
    if (!this.db) {
      await this.initialize()
    }
    if (!this.db) {
      throw new Error('Database not initialized')
    }
    return this.db
  }

  private async waitForSaveQueue(): Promise<void> {
    if (this.accountResetStarted) {
      throw new Error(ACCOUNT_CHANGE_READ_ERROR)
    }
    await Promise.race([
      this.saveQueue.catch(() => {}),
      this.accountResetSignal,
    ])
    if (this.accountResetStarted) {
      throw new Error(ACCOUNT_CHANGE_READ_ERROR)
    }
  }

  private protectRead<T>(read: Promise<T>): Promise<T> {
    return Promise.race([read, this.accountResetSignal])
  }

  private assertActiveSaveGeneration(): void {
    if (
      this.accountResetStarted ||
      this.activeSaveGeneration !== this.saveGeneration
    ) {
      throw new Error(ACCOUNT_CHANGE_WRITE_ERROR)
    }
  }

  /**
   * Serialize a write behind every previously queued one. The
   * returned promise is the caller's view of the operation (typed
   * result, rejections included); the same promise becomes the new
   * queue tail so a failure is logged as "recovered" by whichever
   * operation queues next.
   */
  private enqueueSave<T>(
    action: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (this.accountResetStarted) {
      return Promise.reject(new Error(ACCOUNT_CHANGE_WRITE_ERROR))
    }

    const saveGeneration = this.saveGeneration
    const result = this.saveQueue
      .catch((error) => {
        logError('Previous save operation failed, recovering queue', error, {
          component: 'IndexedDBStorage',
          action: `${action}.queueRecovery`,
        })
      })
      .then(async () => {
        if (saveGeneration !== this.saveGeneration) {
          throw new Error(ACCOUNT_CHANGE_WRITE_ERROR)
        }
        this.activeSaveGeneration = saveGeneration
        try {
          return await operation()
        } finally {
          if (this.activeSaveGeneration === saveGeneration) {
            this.activeSaveGeneration = null
          }
        }
      })
    this.saveQueue = result
    return result
  }

  async resetForAccountChange(notifyOtherTabs = true): Promise<void> {
    if (this.accountResetPromise) return this.accountResetPromise

    if (notifyOtherTabs && typeof window !== 'undefined') {
      try {
        localStorage.setItem(AUTH_ACCOUNT_RESET_SIGNAL, crypto.randomUUID())
        localStorage.removeItem(AUTH_ACCOUNT_RESET_SIGNAL)
      } catch {
        // best-effort — this tab still clears and blocks its own storage
      }
    }

    this.accountResetStarted = true
    this.rejectAccountReads(new Error(ACCOUNT_CHANGE_READ_ERROR))
    this.saveGeneration += 1
    this.saveQueue = Promise.resolve()
    this.initializationPromise = null

    const db = this.db
    this.db = null
    db?.close()

    const reset = this.ensureDB().then((resetDb) => {
      const storeNames = Array.from(resetDb.objectStoreNames).filter(
        (storeName) => storeName !== MIGRATIONS_STORE,
      )
      return new Promise<void>((resolve, reject) => {
        const transaction = resetDb.transaction(storeNames, 'readwrite')
        const timeout = window.setTimeout(() => {
          try {
            transaction.abort()
          } finally {
            reject(
              new Error('Timed out resetting IndexedDB for account change'),
            )
          }
        }, ACCOUNT_CHANGE_RESET_TIMEOUT_MS)

        transaction.oncomplete = () => {
          clearTimeout(timeout)
          resolve()
        }
        transaction.onerror = () => {
          clearTimeout(timeout)
          reject(new Error('Failed to reset IndexedDB for account change'))
        }
        transaction.onabort = () => {
          clearTimeout(timeout)
          reject(new Error('IndexedDB account reset was aborted'))
        }

        for (const storeName of storeNames) {
          const clearRequest = transaction.objectStore(storeName).clear()
          clearRequest.onerror = () => {
            clearTimeout(timeout)
            reject(
              new Error(
                `Failed to clear IndexedDB store ${storeName} for account change`,
              ),
            )
          }
        }
      })
    })

    const trackedReset = reset
    this.accountResetPromise = trackedReset
    this.saveQueue = trackedReset
    void trackedReset.then(
      () => {
        if (this.accountResetPromise === trackedReset) {
          this.accountResetPromise = null
        }
      },
      () => {
        if (this.accountResetPromise === trackedReset) {
          this.accountResetPromise = null
        }
      },
    )
    return trackedReset
  }

  async saveChat(chat: Chat): Promise<SaveChatResult> {
    const chatSnapshot = snapshotChatForStorage(chat)
    return this.enqueueSave('saveChat', () =>
      this.saveChatInternal(chatSnapshot),
    )
  }

  async saveExistingChat(chat: Chat): Promise<SaveChatResult> {
    const chatSnapshot = snapshotChatForStorage(chat)
    return this.enqueueSave('saveExistingChat', () =>
      this.saveChatInternal(chatSnapshot, { requireExisting: true }),
    )
  }

  async restoreDecryptionPlaceholder(chat: StoredChat): Promise<void> {
    const chatSnapshot = snapshotChatForStorage(chat)
    await this.enqueueSave('restoreDecryptionPlaceholder', () =>
      this.saveChatInternal(chatSnapshot, { markContentChangesAsLocal: false }),
    )
  }

  async mutateChat(
    chatId: string,
    mutation: (chat: StoredChat) => {
      chat: StoredChat
      changed: boolean
    },
  ): Promise<StoredChat | null> {
    return this.enqueueSave('mutateChat', async () => {
      const db = await this.ensureDB()
      return new Promise<StoredChat | null>((resolve, reject) => {
        const transaction = db.transaction(
          [CHATS_STORE, CHAT_SUMMARIES_STORE, ATTACHMENT_PAYLOADS_STORE],
          'readwrite',
        )
        const store = transaction.objectStore(CHATS_STORE)
        const summaryStore = transaction.objectStore(CHAT_SUMMARIES_STORE)
        const payloadStore = transaction.objectStore(ATTACHMENT_PAYLOADS_STORE)
        let output: StoredChat | null = null

        transaction.oncomplete = () => resolve(output)
        transaction.onerror = () => reject(new Error('Failed to mutate chat'))
        transaction.onabort = () =>
          reject(new Error('Chat mutation transaction aborted'))

        const request = store.get(chatId)
        request.onerror = () => reject(new Error('Failed to read chat'))
        const payloadRequest = payloadStore
          .index(ATTACHMENT_PAYLOADS_CHAT_INDEX)
          .getAll(IDBKeyRange.only(chatId))
        payloadRequest.onerror = () =>
          reject(new Error('Failed to read attachment payloads'))
        // Requests fire in issue order within a transaction, so the chat
        // read has settled by the time the payload read succeeds.
        payloadRequest.onsuccess = () => {
          const stored = request.result as StoredChat | undefined
          if (!stored) return

          // The mutation sees (and callers receive) the hydrated chat so
          // attachment content survives the round trip; the write below
          // re-normalizes payloads back out of the chat record.
          let current: StoredChat
          try {
            current = hydrateAttachmentPayloads(
              stored,
              payloadRequest.result as StoredAttachmentPayload[],
            )
          } catch (error) {
            transaction.abort()
            reject(error)
            return
          }
          const result = mutation(current)
          if (!result.changed) {
            output = result.chat
            return
          }

          const clock = nextClock(current.clock)
          output = {
            ...result.chat,
            messages: result.chat.messages.map((message) => ({
              ...message,
              timestamp:
                message.timestamp instanceof Date
                  ? message.timestamp.toISOString()
                  : message.timestamp,
            })) as any,
            lastAccessedAt: Date.now(),
            clock: clock.v,
            writer: clock.w,
            locallyModified: computeLocallyModified({
              isFailedDecryption: current.decryptionFailed === true,
              existingChat: current,
              hasContentChanges: true,
              callerValue: result.chat.locallyModified,
            }),
            version: 1,
            syncUserId:
              chatOwnerId(result.chat) ?? current.syncUserId ?? activeUserId(),
            projectLocallyModified:
              result.chat.projectLocallyModified ??
              current.projectLocallyModified ??
              false,
          }
          const mutated = updateSyncPending(output)
          mutated.pendingUpload = derivePendingUpload(mutated)
          const normalizedAttachments =
            normalizeAttachmentPayloadsInTransaction(
              mutated,
              transaction,
              reject,
            )
          if (!normalizedAttachments) return
          const writeChatAndPayloads = () => {
            for (const payload of normalizedAttachments.payloads) {
              const putRequest = payloadStore.put(payload)
              putRequest.onerror = () =>
                reject(
                  putRequest.error ??
                    new Error('Failed to save attachment payload'),
                )
            }
            putStoredChat(store, summaryStore, {
              ...output!,
              messages: normalizedAttachments.messages as any,
            })
          }
          const payloadCursor = payloadStore
            .index(ATTACHMENT_PAYLOADS_CHAT_INDEX)
            .openCursor(IDBKeyRange.only(chatId))
          payloadCursor.onerror = () =>
            reject(new Error('Failed to reconcile attachment payloads'))
          payloadCursor.onsuccess = () => {
            const cursor = payloadCursor.result
            if (cursor) {
              if (
                !normalizedAttachments.referencedPayloadIds.has(
                  String(cursor.primaryKey),
                )
              ) {
                cursor.delete()
              }
              cursor.continue()
              return
            }
            writeChatAndPayloads()
          }
        }
      })
    })
  }

  private async saveChatInternal(
    chat: Chat,
    options: {
      requireExisting?: boolean
      markContentChangesAsLocal?: boolean
      allowLocalOnlyChange?: boolean
    } = {},
  ): Promise<SaveChatResult> {
    this.assertActiveSaveGeneration()
    const db = await this.ensureDB()
    this.assertActiveSaveGeneration()

    // Don't save blank chats to IndexedDB
    if ((chat as StoredChat).isBlankChat === true) {
      return {
        saved: false,
        isLocalOnly: (chat as StoredChat).isLocalOnly === true,
      }
    }

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(
        [CHATS_STORE, ATTACHMENT_PAYLOADS_STORE, CHAT_SUMMARIES_STORE],
        'readwrite',
      )
      const store = transaction.objectStore(CHATS_STORE)
      const payloadStore = transaction.objectStore(ATTACHMENT_PAYLOADS_STORE)
      const summaryStore = transaction.objectStore(CHAT_SUMMARIES_STORE)
      let result: SaveChatResult = {
        saved: false,
        isLocalOnly: (chat as StoredChat).isLocalOnly === true,
      }

      transaction.oncomplete = () => {
        resolve(result)
      }

      transaction.onerror = (event) => {
        import('@/utils/error-handling').then(({ logError }) => {
          logError(
            '[IndexedDB] Transaction error',
            (event.target as any).error,
            {
              component: 'IndexedDBStorage',
              action: 'saveChatInternal',
            },
          )
        })
        reject(new Error('Failed to save chat'))
      }

      transaction.onabort = (event) => {
        import('@/utils/error-handling').then(({ logError }) => {
          logError(
            '[IndexedDB] Transaction aborted',
            (event.target as any).error,
            {
              component: 'IndexedDBStorage',
              action: 'saveChatInternal',
              metadata: { chatId: chat.id },
            },
          )
        })
        reject(transaction.error ?? new Error('Transaction aborted'))
      }

      const getRequest = store.get(chat.id)

      getRequest.onsuccess = () => {
        const existingChat = getRequest.result as StoredChat | undefined
        if (options.requireExisting && !existingChat) {
          return
        }

        // Metadata-only copies carry an empty messages array as a
        // lightweight stand-in; the stored row stays the source of truth
        // for content until hydration. Apply the metadata over the stored
        // messages instead of overwriting them, and never materialize a
        // row from a summary whose full chat no longer exists.
        if ((chat as StoredChat).isMetadataOnly === true) {
          if (!existingChat) {
            return
          }
          chat = {
            ...chat,
            messages: existingChat.messages,
            pendingRecoveries: existingChat.pendingRecoveries,
          }
        }

        const normalizedAttachments = normalizeAttachmentPayloadsInTransaction(
          chat,
          transaction,
          reject,
        )
        if (!normalizedAttachments) return
        const messagesForStorage = normalizedAttachments.messages.map(
          (msg) => ({
            ...msg,
            timestamp:
              msg.timestamp instanceof Date
                ? msg.timestamp.toISOString()
                : msg.timestamp,
          }),
        )

        // Determine if the chat's meaningful content has changed compared to existing version.
        // NOTE: We intentionally ignore `updatedAt` so we don't create sync churn from timestamps.
        const hasContentChanges = existingChat
          ? chatContentFingerprint({
              title: existingChat.title,
              projectId: existingChat.projectId,
              messages: existingChat.messages,
              pendingRecoveries: existingChat.pendingRecoveries,
            }) !==
            chatContentFingerprint({
              title: chat.title,
              projectId: (chat as StoredChat).projectId,
              messages: messagesForStorage,
              pendingRecoveries: (chat as StoredChat).pendingRecoveries,
            })
          : false

        // Never mark chats that failed to decrypt as locally modified.
        // These are placeholder chats with empty messages that should NOT be uploaded.
        // If we set locallyModified: true, they would overwrite real encrypted data on the server.
        const isFailedDecryption =
          (chat as StoredChat).decryptionFailed === true

        // Bump the edit clock only on a genuine local content edit: a
        // changed existing chat, or a brand-new locally-created one.
        // Re-saves that don't touch content (and synced writes) keep the
        // existing clock so they don't outrank a real concurrent edit.
        const bumpClock =
          !isFailedDecryption &&
          options.markContentChangesAsLocal !== false &&
          (hasContentChanges ||
            (!existingChat && ((chat as StoredChat).locallyModified ?? true)))
        const bumpedClock = bumpClock
          ? nextClock(existingChat?.clock ?? (chat as StoredChat).clock)
          : null

        const locallyModified = computeLocallyModified({
          isFailedDecryption,
          existingChat,
          hasContentChanges:
            options.markContentChangesAsLocal === false
              ? false
              : hasContentChanges,
          callerValue: (chat as StoredChat).locallyModified,
        })
        const isLocalOnly = resolveStoredLocalOnly(
          (chat as StoredChat).isLocalOnly,
          existingChat?.isLocalOnly,
          options.allowLocalOnlyChange,
        )
        const storedChat: StoredChat = {
          ...chat,
          messages: messagesForStorage as any,
          lastAccessedAt: Date.now(),
          syncedAt: existingChat?.syncedAt ?? (chat as StoredChat).syncedAt,
          clock:
            bumpedClock?.v ?? existingChat?.clock ?? (chat as StoredChat).clock,
          writer:
            bumpedClock?.w ??
            existingChat?.writer ??
            (chat as StoredChat).writer,
          clockVersion:
            existingChat?.clockVersion ?? (chat as StoredChat).clockVersion,
          // For existing chats: mark as modified if content changed, or preserve existing modified state
          // This ensures modified chats are always picked up for sync even if they were
          // loaded with locallyModified: false from a previous sync
          // For new chats: use provided value or default to true
          // IMPORTANT: Never mark failed-to-decrypt chats as modified - they are placeholders
          locallyModified,
          syncPending: chatNeedsSync({
            locallyModified,
            syncedAt: existingChat?.syncedAt ?? (chat as StoredChat).syncedAt,
            isLocalOnly,
            decryptionFailed: isFailedDecryption,
          }),
          syncVersion:
            existingChat?.syncVersion ?? (chat as StoredChat).syncVersion,
          decryptionFailed: (chat as StoredChat).decryptionFailed,
          dataCorrupted: (chat as StoredChat).dataCorrupted,
          version: 1,
          loadedAt:
            (chat as StoredChat).loadedAt ??
            existingChat?.loadedAt ??
            undefined,
          isLocalOnly,
          syncUserId:
            chatOwnerId(chat) ?? existingChat?.syncUserId ?? activeUserId(),
          projectLocallyModified:
            (chat as StoredChat).projectLocallyModified ??
            existingChat?.projectLocallyModified ??
            false,
        }
        result = { saved: true, isLocalOnly }

        const writeChatAndPayloads = () => {
          for (const payload of normalizedAttachments.payloads) {
            const payloadRequest = payloadStore.put(payload)
            payloadRequest.onerror = () =>
              reject(
                payloadRequest.error ??
                  new Error('Failed to save attachment payload'),
              )
          }
          const putRequest = putStoredChat(store, summaryStore, storedChat)
          putRequest.onerror = () => reject(new Error('Failed to save chat'))
        }
        storedChat.pendingUpload = derivePendingUpload(storedChat)

        const payloadCursor = payloadStore
          .index(ATTACHMENT_PAYLOADS_CHAT_INDEX)
          .openCursor(IDBKeyRange.only(chat.id))
        payloadCursor.onerror = () =>
          reject(new Error('Failed to reconcile attachment payloads'))
        payloadCursor.onsuccess = () => {
          const cursor = payloadCursor.result
          if (cursor) {
            if (
              !normalizedAttachments.referencedPayloadIds.has(
                String(cursor.primaryKey),
              )
            ) {
              cursor.delete()
            }
            cursor.continue()
            return
          }
          writeChatAndPayloads()
        }
      }

      getRequest.onerror = () =>
        reject(new Error('Failed to check existing chat'))
    })
  }

  private async getStoredChatInternal(id: string): Promise<StoredChat | null> {
    const db = await this.ensureDB()

    return new Promise((resolve, reject) => {
      const transaction = db.transaction([CHATS_STORE], 'readonly')
      const store = transaction.objectStore(CHATS_STORE)
      const request = store.get(id)

      request.onsuccess = () => {
        try {
          const chat = request.result as StoredChat | undefined
          resolve(chat ? deserializeStoredChat(chat) : null)
        } catch (error) {
          reject(error)
        }
      }
      request.onerror = () => reject(new Error('Failed to get chat'))
    })
  }

  private async getChatInternal(id: string): Promise<StoredChat | null> {
    const db = await this.ensureDB()

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(
        [CHATS_STORE, ATTACHMENT_PAYLOADS_STORE],
        'readonly',
      )
      let chat: StoredChat | null = null
      let payloads: StoredAttachmentPayload[] = []
      const chatRequest = transaction.objectStore(CHATS_STORE).get(id)
      const payloadRequest = transaction
        .objectStore(ATTACHMENT_PAYLOADS_STORE)
        .index(ATTACHMENT_PAYLOADS_CHAT_INDEX)
        .getAll(IDBKeyRange.only(id))

      chatRequest.onsuccess = () => {
        try {
          const stored = chatRequest.result as StoredChat | undefined
          chat = stored ? deserializeStoredChat(stored) : null
        } catch (error) {
          reject(error)
        }
      }
      chatRequest.onerror = () => reject(new Error('Failed to get chat'))
      payloadRequest.onsuccess = () => {
        payloads = payloadRequest.result as StoredAttachmentPayload[]
      }
      payloadRequest.onerror = () =>
        reject(new Error('Failed to get attachment payloads'))
      transaction.oncomplete = () => {
        try {
          resolve(chat ? hydrateAttachmentPayloads(chat, payloads) : null)
        } catch (error) {
          reject(error)
        }
      }
    })
  }

  async getChat(id: string): Promise<StoredChat | null> {
    await this.waitForSaveQueue()
    return this.protectRead(
      this.getChatInternal(id).then((chat) => {
        if (chat) {
          this.updateLastAccessed(id).catch((error) =>
            logError('Failed to update last accessed time', error, {
              component: 'IndexedDBStorage',
              metadata: { chatId: id },
            }),
          )
        }
        return chat
      }),
    )
  }

  async deleteChat(id: string): Promise<void> {
    // Serialize through saveQueue so a deletion can't race with an in-flight
    // saveChatInternal that would resurrect the row after the delete.
    return this.enqueueSave('deleteChat', async () => {
      const db = await this.ensureDB()
      return new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(
          [CHATS_STORE, ATTACHMENT_PAYLOADS_STORE, CHAT_SUMMARIES_STORE],
          'readwrite',
        )
        const store = transaction.objectStore(CHATS_STORE)
        const request = store.delete(id)
        transaction.objectStore(CHAT_SUMMARIES_STORE).delete(id)
        deleteAttachmentPayloadsForChat(
          transaction.objectStore(ATTACHMENT_PAYLOADS_STORE),
          id,
        )

        transaction.oncomplete = () => resolve()
        transaction.onerror = () => reject(new Error('Failed to delete chat'))
        request.onerror = () => reject(new Error('Failed to delete chat'))
      })
    })
  }

  async deleteChatIfUnchanged(
    id: string,
    expectedUpdatedAt: string,
    isCurrent: () => boolean = () => true,
  ): Promise<boolean> {
    return this.enqueueSave('deleteChatIfUnchanged', async () => {
      if (!isCurrent()) return false
      const db = await this.ensureDB()
      if (!isCurrent()) return false
      return new Promise<boolean>((resolve, reject) => {
        const transaction = db.transaction(
          [CHATS_STORE, ATTACHMENT_PAYLOADS_STORE, CHAT_SUMMARIES_STORE],
          'readwrite',
        )
        const store = transaction.objectStore(CHATS_STORE)
        let deleted = false
        const getRequest = store.get(id)

        getRequest.onsuccess = () => {
          if (!isCurrent()) return
          const chat = getRequest.result as StoredChat | undefined
          if (!chat || chat.updatedAt !== expectedUpdatedAt) return
          store.delete(id)
          transaction.objectStore(CHAT_SUMMARIES_STORE).delete(id)
          deleteAttachmentPayloadsForChat(
            transaction.objectStore(ATTACHMENT_PAYLOADS_STORE),
            id,
          )
          deleted = true
        }
        transaction.oncomplete = () => resolve(deleted)
        transaction.onerror = () =>
          reject(new Error('Failed to conditionally delete chat'))
        getRequest.onerror = () =>
          reject(new Error('Failed to read chat for conditional deletion'))
      })
    })
  }

  /**
   * Remove every synced chat from the local mirror. The revision
   * checkpoint asserts that the mirror reflects every remote change up
   * to `appliedRevision`; once the mirror is emptied that assertion is
   * false, so the checkpoint is cleared in the same transaction and the
   * next sync re-bootstraps from a snapshot instead of replaying only
   * the changes made since the wipe.
   */
  async deleteAllNonLocalChats(): Promise<number> {
    return this.enqueueSave('deleteAllNonLocalChats', async () => {
      const db = await this.ensureDB()
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(
          [
            CHATS_STORE,
            ATTACHMENT_PAYLOADS_STORE,
            CHAT_SUMMARIES_STORE,
            SYNC_STATE_STORE,
            REMOTE_CHAT_STATE_STORE,
          ],
          'readwrite',
        )
        transaction.objectStore(SYNC_STATE_STORE).clear()
        transaction.objectStore(REMOTE_CHAT_STATE_STORE).clear()
        const store = transaction.objectStore(CHATS_STORE)
        const request = store.openCursor()
        let deletedCount = 0

        request.onsuccess = (event) => {
          const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result
          if (cursor) {
            const chat = cursor.value as StoredChat
            if (!chat.isLocalOnly) {
              cursor.delete()
              transaction.objectStore(CHAT_SUMMARIES_STORE).delete(chat.id)
              deleteAttachmentPayloadsForChat(
                transaction.objectStore(ATTACHMENT_PAYLOADS_STORE),
                chat.id,
              )
              deletedCount++
            }
            cursor.continue()
          }
        }

        transaction.oncomplete = () => resolve(deletedCount)
        transaction.onerror = () =>
          reject(new Error('Failed to delete non-local chats'))
        request.onerror = () =>
          reject(new Error('Failed to delete non-local chats'))
      })
    })
  }

  /**
   * Returns every known project chat ID, including authenticated remote IDs
   * and matching local rows, not only the rows removed from local storage.
   */
  async deleteChatsByProject(
    projectId: string,
    remoteIds: string[],
    userId: string,
    createIdempotencyKey: () => string,
    isCurrent: () => boolean = () => true,
  ): Promise<string[]> {
    // Serialize through saveQueue so deletions can't race with an in-flight
    // saveChatInternal that would resurrect a row after the delete.
    return this.enqueueSave('deleteChatsByProject', async () => {
      if (!isCurrent()) return []
      const db = await this.ensureDB()
      if (!isCurrent()) return []
      return new Promise<string[]>((resolve, reject) => {
        const transaction = db.transaction(
          [
            CHATS_STORE,
            ATTACHMENT_PAYLOADS_STORE,
            CHAT_SUMMARIES_STORE,
            SYNC_OUTBOX_STORE,
          ],
          'readwrite',
        )
        const store = transaction.objectStore(CHATS_STORE)
        const outbox = transaction.objectStore(SYNC_OUTBOX_STORE)
        const remoteIdSet = new Set(remoteIds)
        const stagedIds = new Set<string>()
        const deletedIds = new Set(remoteIdSet)
        let accountChanged = false
        const abortIfStale = (): boolean => {
          if (isCurrent()) return false
          accountChanged = true
          try {
            transaction.abort()
          } catch {}
          return true
        }
        const stageDeleteIntent = (id: string) => {
          if (stagedIds.has(id) || abortIfStale()) return
          stagedIds.add(id)
          const existingIntent = outbox.get([userId, id])
          existingIntent.onsuccess = () => {
            if (abortIfStale() || existingIntent.result) return
            try {
              const putRequest = outbox.put(
                syncDeleteOutboxEntry(id, userId, createIdempotencyKey()),
              )
              putRequest.onsuccess = () => {
                abortIfStale()
              }
            } catch (error) {
              try {
                transaction.abort()
              } catch {}
              reject(error)
            }
          }
        }
        for (const id of remoteIdSet) stageDeleteIntent(id)
        const request = store.openCursor()

        request.onsuccess = (event) => {
          if (abortIfStale()) return
          const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result
          if (cursor) {
            const chat = cursor.value as StoredChat
            const ownedByUser = chat.syncUserId === userId
            if (
              ownedByUser &&
              (chat.projectId === projectId || remoteIdSet.has(chat.id))
            ) {
              deletedIds.add(chat.id)
              if (remoteIdSet.has(chat.id) || chatKnownToServer(chat)) {
                stageDeleteIntent(chat.id)
              }
              const deleteRequest = cursor.delete()
              deleteRequest.onsuccess = () => {
                abortIfStale()
              }
              transaction.objectStore(CHAT_SUMMARIES_STORE).delete(chat.id)
              deleteAttachmentPayloadsForChat(
                transaction.objectStore(ATTACHMENT_PAYLOADS_STORE),
                chat.id,
              )
            }
            cursor.continue()
          }
        }

        transaction.oncomplete = () => resolve([...deletedIds])
        transaction.onerror = () =>
          reject(new Error('Failed to delete project chats'))
        transaction.onabort = () =>
          reject(
            new Error(
              accountChanged
                ? 'Cloud account changed during project deletion'
                : 'Project chat deletion transaction aborted',
            ),
          )
        request.onerror = () =>
          reject(new Error('Failed to delete project chats'))
      })
    })
  }

  async getAllChatIds(): Promise<string[]> {
    await this.waitForSaveQueue()
    const db = await this.ensureDB()

    return this.protectRead(
      new Promise((resolve, reject) => {
        const transaction = db.transaction([CHATS_STORE], 'readonly')
        const store = transaction.objectStore(CHATS_STORE)
        const request = store.getAllKeys()

        request.onsuccess = () => {
          resolve((request.result as IDBValidKey[]).map((k) => String(k)))
        }
        request.onerror = () => reject(new Error('Failed to list chat IDs'))
      }),
    )
  }

  async getChatCount(): Promise<number> {
    await this.waitForSaveQueue()
    const db = await this.ensureDB()

    return this.protectRead(
      new Promise((resolve, reject) => {
        const transaction = db.transaction([CHATS_STORE], 'readonly')
        const store = transaction.objectStore(CHATS_STORE)
        const request = store.count()

        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(new Error('Failed to count chats'))
      }),
    )
  }

  async deleteAllChats(): Promise<number> {
    // Serialize through saveQueue so a clear() can't race with an in-flight
    // saveChatInternal that would re-insert a row after the wipe.
    return this.enqueueSave('deleteAllChats', async () => {
      const db = await this.ensureDB()
      return new Promise<number>((resolve, reject) => {
        const transaction = db.transaction(
          [CHATS_STORE, ATTACHMENT_PAYLOADS_STORE, CHAT_SUMMARIES_STORE],
          'readwrite',
        )
        const store = transaction.objectStore(CHATS_STORE)
        const countRequest = store.count()
        let count = 0

        countRequest.onsuccess = () => {
          count = countRequest.result
          store.clear()
          transaction.objectStore(ATTACHMENT_PAYLOADS_STORE).clear()
          transaction.objectStore(CHAT_SUMMARIES_STORE).clear()
        }

        transaction.oncomplete = () => resolve(count)
        transaction.onerror = () =>
          reject(new Error('Failed to clear chats store'))
        countRequest.onerror = () => reject(new Error('Failed to count chats'))
      })
    })
  }

  // Count chats that are eligible for cloud sync (everything except
  // local-only rows). Cheaper than getAllChats when the caller only
  // needs the total — avoids deserializing every stored message.
  async getCloudChatCount(): Promise<number> {
    await this.ensureChatSummaries()
    await this.waitForSaveQueue()
    const db = await this.ensureDB()

    return this.protectRead(
      new Promise((resolve, reject) => {
        const transaction = db.transaction([CHAT_SUMMARIES_STORE], 'readonly')
        const store = transaction.objectStore(CHAT_SUMMARIES_STORE)
        const request = store.openCursor()
        let count = 0

        request.onsuccess = (event) => {
          const cursor = (event.target as IDBRequest).result
          if (cursor) {
            const chat = cursor.value
            if (!chat.isLocalOnly) {
              count++
            }
            cursor.continue()
          } else {
            resolve(count)
          }
        }

        request.onerror = () => reject(new Error('Failed to count chats'))
      }),
    )
  }

  async getProjectChatCount(projectId: string): Promise<number> {
    await this.ensureChatSummaries()
    await this.waitForSaveQueue()
    const db = await this.ensureDB()

    return this.protectRead(
      new Promise((resolve, reject) => {
        const transaction = db.transaction([CHAT_SUMMARIES_STORE], 'readonly')
        const store = transaction.objectStore(CHAT_SUMMARIES_STORE)
        const request = store.openCursor()
        let count = 0

        request.onsuccess = () => {
          const cursor = request.result
          if (!cursor) {
            resolve(count)
            return
          }
          const chat = cursor.value as StoredChat
          if (chat.projectId === projectId && !chat.isLocalOnly) {
            count += 1
          }
          cursor.continue()
        }
        request.onerror = () =>
          reject(new Error('Failed to count cached project chats'))
      }),
    )
  }

  async hasPendingChatRecoveries(): Promise<boolean> {
    await this.ensureChatSummaries()
    await this.waitForSaveQueue()
    const db = await this.ensureDB()

    return this.protectRead(
      new Promise((resolve, reject) => {
        const transaction = db.transaction([CHAT_SUMMARIES_STORE], 'readonly')
        const store = transaction.objectStore(CHAT_SUMMARIES_STORE)
        const request = store.openCursor()

        request.onsuccess = (event) => {
          const cursor = (event.target as IDBRequest<IDBCursorWithValue | null>)
            .result
          if (!cursor) {
            resolve(false)
            return
          }
          const chat = cursor.value as StoredChat
          if ((chat.pendingRecoveries?.length ?? 0) > 0) {
            resolve(true)
            return
          }
          cursor.continue()
        }

        request.onerror = () =>
          reject(new Error('Failed to inspect pending chat recoveries'))
      }),
    )
  }

  async getPendingChatRecoveries(): Promise<ChatRecoverySummary[]> {
    await this.ensureChatSummaries()
    await this.waitForSaveQueue()
    const db = await this.ensureDB()

    return this.protectRead(
      new Promise((resolve, reject) => {
        const transaction = db.transaction([CHAT_SUMMARIES_STORE], 'readonly')
        const store = transaction.objectStore(CHAT_SUMMARIES_STORE)
        const request = store.openCursor()
        const chats: ChatRecoverySummary[] = []

        request.onsuccess = () => {
          const cursor = request.result
          if (!cursor) {
            resolve(chats)
            return
          }
          const chat = cursor.value as StoredChat
          if (chat.pendingRecoveries?.length) {
            chats.push({
              id: chat.id,
              pendingRecoveries: chat.pendingRecoveries,
            })
          }
          cursor.continue()
        }
        request.onerror = () =>
          reject(new Error('Failed to get pending chat recoveries'))
      }),
    )
  }

  async isChatHistoryAuthoritative(
    expectedCloudVersions: ReadonlyMap<string, number>,
  ): Promise<boolean> {
    await this.waitForSaveQueue()
    const db = await this.ensureDB()

    return this.protectRead(
      new Promise((resolve, reject) => {
        const transaction = db.transaction([CHATS_STORE], 'readonly')
        const store = transaction.objectStore(CHATS_STORE)
        const request = store.openCursor()
        const missingCloudVersions = new Map(expectedCloudVersions)

        request.onsuccess = (event) => {
          const cursor = (event.target as IDBRequest<IDBCursorWithValue | null>)
            .result
          if (!cursor) {
            resolve(missingCloudVersions.size === 0)
            return
          }
          const chat = cursor.value as StoredChat
          if (!chat.isLocalOnly) {
            const expectedVersion = missingCloudVersions.get(chat.id)
            if (
              chat.locallyModified ||
              chat.decryptionFailed ||
              expectedVersion === undefined ||
              chat.syncVersion !== expectedVersion
            ) {
              resolve(false)
              return
            }
            missingCloudVersions.delete(chat.id)
          }
          cursor.continue()
        }

        request.onerror = () =>
          reject(new Error('Failed to verify local chat history'))
      }),
    )
  }

  async getAllChats(): Promise<StoredChat[]> {
    await this.waitForSaveQueue()
    const db = await this.ensureDB()

    return this.protectRead(
      new Promise((resolve, reject) => {
        const transaction = db.transaction(
          [CHATS_STORE, ATTACHMENT_PAYLOADS_STORE, CHAT_SUMMARIES_STORE],
          'readonly',
        )
        const store = transaction.objectStore(CHATS_STORE)
        // Sort by ID (primary key) which contains reverse timestamp
        const request = store.openCursor(null, 'next') // Ascending order on reverse timestamp = most recent first

        const chats: StoredChat[] = []
        const payloadIndex = transaction
          .objectStore(ATTACHMENT_PAYLOADS_STORE)
          .index(ATTACHMENT_PAYLOADS_CHAT_INDEX)

        request.onsuccess = (event) => {
          const cursor = (event.target as IDBRequest<IDBCursorWithValue | null>)
            .result
          if (!cursor) return

          const rawChat = cursor.value as StoredChat
          const payloadRequest = payloadIndex.getAll(
            IDBKeyRange.only(rawChat.id),
          )
          payloadRequest.onsuccess = () => {
            try {
              const chat = deserializeStoredChat(rawChat)
              chats.push(
                hydrateAttachmentPayloads(
                  chat,
                  payloadRequest.result as StoredAttachmentPayload[],
                ),
              )
              cursor.continue()
            } catch (error) {
              reject(error)
            }
          }
          payloadRequest.onerror = () =>
            reject(new Error('Failed to get attachment payloads'))
        }

        request.onerror = () => reject(new Error('Failed to get all chats'))
        transaction.oncomplete = () => resolve(chats)
        transaction.onerror = () => reject(new Error('Failed to get all chats'))
        transaction.onabort = () =>
          reject(new Error('Get all chats transaction aborted'))
      }),
    )
  }

  async getChatSyncMetadata(): Promise<ChatSyncMetadata[]> {
    await this.waitForSaveQueue()
    const db = await this.ensureDB()

    return this.protectRead(
      new Promise((resolve, reject) => {
        const transaction = db.transaction([CHATS_STORE], 'readonly')
        const request = transaction.objectStore(CHATS_STORE).openCursor()
        const metadata: ChatSyncMetadata[] = []

        request.onsuccess = () => {
          try {
            const cursor = request.result
            if (!cursor) {
              resolve(metadata)
              return
            }
            metadata.push(toChatSyncMetadata(cursor.value))
            cursor.continue()
          } catch (error) {
            reject(error)
          }
        }
        request.onerror = () =>
          reject(new Error('Failed to get chat sync metadata'))
      }),
    )
  }

  async getChatSummaries(): Promise<StoredChat[]> {
    await this.ensureChatSummaries()
    await this.waitForSaveQueue()
    const db = await this.ensureDB()

    return this.protectRead(
      new Promise((resolve, reject) => {
        const transaction = db.transaction([CHAT_SUMMARIES_STORE], 'readonly')
        const request = transaction.objectStore(CHAT_SUMMARIES_STORE).getAll()
        request.onsuccess = () => {
          const chats: StoredChat[] = []
          for (const chat of request.result as StoredChat[]) {
            if (!Array.isArray(chat.messages)) {
              logWarning('Skipping invalid chat summary', {
                component: 'IndexedDBStorage',
                metadata: { chatId: chat.id },
              })
              continue
            }
            chats.push(chat)
          }
          resolve(chats)
        }
        request.onerror = () =>
          reject(new Error('Failed to get chat summaries'))
      }),
    )
  }

  private async ensureChatSummaries(): Promise<void> {
    if (this.chatSummariesReady) return
    return this.enqueueSave('ensureChatSummaries', async () => {
      if (this.chatSummariesReady) return
      const db = await this.ensureDB()
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(
          [CHATS_STORE, CHAT_SUMMARIES_STORE, MIGRATIONS_STORE],
          'readwrite',
        )
        const chatsStore = transaction.objectStore(CHATS_STORE)
        const summariesStore = transaction.objectStore(CHAT_SUMMARIES_STORE)
        const migrationsStore = transaction.objectStore(MIGRATIONS_STORE)

        transaction.oncomplete = () => resolve()
        transaction.onerror = () =>
          reject(new Error('Failed to prepare chat summaries'))
        transaction.onabort = () =>
          reject(new Error('Chat summary migration was aborted'))

        const markerRequest = migrationsStore.get(CHAT_SUMMARIES_MIGRATION_ID)
        markerRequest.onerror = () =>
          reject(new Error('Failed to read the chat summary migration'))
        markerRequest.onsuccess = () => {
          if (markerRequest.result) return

          const cursorRequest = chatsStore.openCursor()
          cursorRequest.onerror = () =>
            reject(new Error('Failed to migrate chat summaries'))
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result
            if (!cursor) {
              migrationsStore.put({
                id: CHAT_SUMMARIES_MIGRATION_ID,
                completedAt: Date.now(),
              })
              return
            }

            const chat = cursor.value as StoredChat
            if (Array.isArray(chat.messages)) {
              summariesStore.put(toStoredChatSummary(chat))
            } else {
              logWarning('Skipping invalid chat during summary migration', {
                component: 'IndexedDBStorage',
                metadata: { chatId: chat.id },
              })
            }
            cursor.continue()
          }
        }
      })
      this.chatSummariesReady = true
    })
  }

  async getProjectsForUser(userId: string): Promise<Project[]> {
    await this.waitForSaveQueue()
    const db = await this.ensureDB()

    return this.protectRead(
      new Promise((resolve, reject) => {
        const transaction = db.transaction([PROJECTS_STORE], 'readonly')
        const store = transaction.objectStore(PROJECTS_STORE)
        const request = store.index(PROJECTS_USER_INDEX).getAll(userId)

        request.onsuccess = () => {
          const projects = (request.result as StoredProject[])
            .map((record) => record.project)
            .sort(
              (a, b) =>
                new Date(b.updatedAt).getTime() -
                new Date(a.updatedAt).getTime(),
            )
          resolve(projects)
        }
        request.onerror = () =>
          reject(new Error('Failed to get cached projects'))
      }),
    )
  }

  async replaceProjectsForUser(
    userId: string,
    projects: Project[],
  ): Promise<void> {
    return this.enqueueSave('replaceProjectsForUser', async () => {
      const db = await this.ensureDB()
      return new Promise<void>((resolve, reject) => {
        const transaction = db.transaction([PROJECTS_STORE], 'readwrite')
        const store = transaction.objectStore(PROJECTS_STORE)
        const cursorRequest = store
          .index(PROJECTS_USER_INDEX)
          .openKeyCursor(IDBKeyRange.only(userId))

        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result
          if (cursor) {
            store.delete(cursor.primaryKey)
            cursor.continue()
            return
          }

          for (const project of projects) {
            const record: StoredProject = {
              cacheKey: `${userId}:${project.id}`,
              userId,
              project,
            }
            store.put(record)
          }
        }
        transaction.oncomplete = () => resolve()
        transaction.onerror = () =>
          reject(new Error('Failed to replace cached projects'))
      })
    })
  }

  async saveProjectForUser(userId: string, project: Project): Promise<void> {
    return this.enqueueSave('saveProjectForUser', async () => {
      const db = await this.ensureDB()
      return new Promise<void>((resolve, reject) => {
        const transaction = db.transaction([PROJECTS_STORE], 'readwrite')
        transaction.objectStore(PROJECTS_STORE).put({
          cacheKey: `${userId}:${project.id}`,
          userId,
          project,
        } satisfies StoredProject)
        transaction.oncomplete = () => resolve()
        transaction.onerror = () => reject(new Error('Failed to cache project'))
      })
    })
  }

  async deleteProjectForUser(userId: string, projectId: string): Promise<void> {
    return this.enqueueSave('deleteProjectForUser', async () => {
      const db = await this.ensureDB()
      return new Promise<void>((resolve, reject) => {
        const transaction = db.transaction([PROJECTS_STORE], 'readwrite')
        transaction.objectStore(PROJECTS_STORE).delete(`${userId}:${projectId}`)
        transaction.oncomplete = () => resolve()
        transaction.onerror = () =>
          reject(new Error('Failed to remove cached project'))
      })
    })
  }

  async deleteAllProjects(): Promise<void> {
    return this.enqueueSave('deleteAllProjects', async () => {
      const db = await this.ensureDB()
      return new Promise<void>((resolve, reject) => {
        const transaction = db.transaction([PROJECTS_STORE], 'readwrite')
        transaction.objectStore(PROJECTS_STORE).clear()
        transaction.oncomplete = () => resolve()
        transaction.onerror = () =>
          reject(new Error('Failed to clear cached projects'))
      })
    })
  }

  async clearAll(): Promise<void> {
    const db = await this.ensureDB()

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(
        [CHATS_STORE, ATTACHMENT_PAYLOADS_STORE, CHAT_SUMMARIES_STORE],
        'readwrite',
      )
      const store = transaction.objectStore(CHATS_STORE)
      const request = store.clear()
      transaction.objectStore(ATTACHMENT_PAYLOADS_STORE).clear()
      transaction.objectStore(CHAT_SUMMARIES_STORE).clear()

      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(new Error('Failed to clear all chats'))
      request.onerror = () => reject(new Error('Failed to clear all chats'))
    })
  }

  private async updateLastAccessed(id: string): Promise<void> {
    return this.enqueueSave('updateLastAccessed', async () => {
      const db = await this.ensureDB()
      return new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(
          [CHATS_STORE, CHAT_SUMMARIES_STORE],
          'readwrite',
        )
        const store = transaction.objectStore(CHATS_STORE)
        const summaryStore = transaction.objectStore(CHAT_SUMMARIES_STORE)
        const request = store.get(id)

        transaction.oncomplete = () => resolve()
        transaction.onerror = () =>
          reject(new Error('Failed to update last accessed'))
        transaction.onabort = () =>
          reject(new Error('Last accessed update transaction aborted'))
        request.onerror = () =>
          reject(new Error('Failed to read chat for last accessed update'))
        request.onsuccess = () => {
          const chat = request.result as StoredChat | undefined
          if (!chat) return
          chat.lastAccessedAt = Date.now()
          const putRequest = putStoredChat(store, summaryStore, chat)
          putRequest.onerror = () =>
            reject(new Error('Failed to update last accessed'))
        }
      })
    })
  }

  async getUnsyncedChats(): Promise<StoredChat[]> {
    const metadata = await this.getUnsyncedChatMetadata()
    const hydrated = await Promise.all(
      metadata.map((chat) => this.getChatInternal(chat.id)),
    )
    return hydrated.filter((chat): chat is StoredChat => chat !== null)
  }

  async getUnsyncedChatMetadata(): Promise<ChatSyncMetadata[]> {
    await this.ensureSyncPendingIndex()
    await this.waitForSaveQueue()
    const db = await this.ensureDB()

    return this.protectRead(
      new Promise((resolve, reject) => {
        const transaction = db.transaction([CHATS_STORE], 'readonly')
        const store = transaction.objectStore(CHATS_STORE)
        const request = store
          .index(CHATS_SYNC_PENDING_INDEX)
          .openCursor(IDBKeyRange.only(1))
        const metadata: ChatSyncMetadata[] = []

        request.onsuccess = () => {
          try {
            const cursor = request.result
            if (!cursor) {
              resolve(metadata)
              return
            }
            metadata.push(toChatSyncMetadata(cursor.value))
            cursor.continue()
          } catch (error) {
            reject(error)
          }
        }
        request.onerror = () =>
          reject(new Error('Failed to get unsynced chats'))
      }),
    )
  }

  private async ensureSyncPendingIndex(): Promise<void> {
    if (this.syncPendingIndexReady) return
    return this.enqueueSave('ensureSyncPendingIndex', async () => {
      if (this.syncPendingIndexReady) return
      const db = await this.ensureDB()
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(
          [CHATS_STORE, MIGRATIONS_STORE],
          'readwrite',
        )
        const chatsStore = transaction.objectStore(CHATS_STORE)
        const migrationsStore = transaction.objectStore(MIGRATIONS_STORE)

        transaction.oncomplete = () => resolve()
        transaction.onerror = () =>
          reject(new Error('Failed to prepare the pending sync index'))
        transaction.onabort = () =>
          reject(new Error('Pending sync index migration was aborted'))

        const markerRequest = migrationsStore.get(SYNC_PENDING_MIGRATION_ID)
        markerRequest.onerror = () =>
          reject(new Error('Failed to read the pending sync migration'))
        markerRequest.onsuccess = () => {
          if (markerRequest.result) return

          const cursorRequest = chatsStore.openCursor()
          cursorRequest.onerror = () =>
            reject(new Error('Failed to migrate pending sync records'))
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result
            if (!cursor) {
              migrationsStore.put({
                id: SYNC_PENDING_MIGRATION_ID,
                completedAt: Date.now(),
              })
              return
            }

            const chat = cursor.value as StoredChat
            if (
              !Array.isArray(chat.messages) ||
              chat.messages.some(
                (message) => message === null || typeof message !== 'object',
              )
            ) {
              logError(
                'Skipping malformed chat during pending sync migration',
                new TypeError('Stored chat has invalid messages'),
                {
                  component: 'IndexedDBStorage',
                  action: 'ensureSyncPendingIndex',
                  metadata: { chatId: chat.id },
                },
              )
              if (chat.syncPending !== 0) {
                chat.syncPending = 0
                cursor.update(chat)
              }
              cursor.continue()
              return
            }
            const syncPending = chatNeedsSync(chat)
            if (chat.syncPending !== syncPending) {
              chat.syncPending = syncPending
              cursor.update(chat)
            }
            cursor.continue()
          }
        }
      })
      this.syncPendingIndexReady = true
    })
  }

  async markAsSynced(id: string, syncVersion: number): Promise<void> {
    return this.enqueueSave('markAsSynced', async () => {
      const db = await this.ensureDB()
      return new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(
          [CHATS_STORE, CHAT_SUMMARIES_STORE],
          'readwrite',
        )
        const store = transaction.objectStore(CHATS_STORE)
        const summaryStore = transaction.objectStore(CHAT_SUMMARIES_STORE)
        const request = store.get(id)

        transaction.oncomplete = () => resolve()
        transaction.onerror = () =>
          reject(new Error('Failed to mark as synced'))
        transaction.onabort = () =>
          reject(new Error('Mark as synced transaction aborted'))
        request.onerror = () =>
          reject(new Error('Failed to read chat before marking as synced'))
        request.onsuccess = () => {
          const chat = request.result as StoredChat | undefined
          if (!chat) return
          chat.syncedAt = Date.now()
          chat.locallyModified = false
          chat.syncUserId ??= activeUserId()
          chat.pendingUpload = 0
          chat.syncVersion = syncVersion
          // The clock is now current as of this synced version, so a
          // later reader trusts it for arbitration.
          chat.clockVersion = syncVersion
          const putRequest = putStoredChat(store, summaryStore, chat)
          putRequest.onerror = () =>
            reject(new Error('Failed to mark as synced'))
        }
      })
    })
  }

  /**
   * Rebase a chat's sync version onto the server's current version
   * while KEEPING `locallyModified` set. Used by last-write-wins
   * conflict resolution (§C5) when the local copy is the fresher
   * write: the next upload's If-Match must match the server's current
   * ETag so the CAS succeeds and the local content wins, instead of
   * looping on STALE_BLOB forever. Unlike `markAsSynced`, this never
   * clears the dirty flag, so the chat is still uploaded.
   */
  async rebaseSyncVersion(id: string, syncVersion: number): Promise<void> {
    return this.enqueueSave('rebaseSyncVersion', async () => {
      const db = await this.ensureDB()
      return new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(
          [CHATS_STORE, CHAT_SUMMARIES_STORE],
          'readwrite',
        )
        const store = transaction.objectStore(CHATS_STORE)
        const summaryStore = transaction.objectStore(CHAT_SUMMARIES_STORE)
        const request = store.get(id)

        transaction.oncomplete = () => resolve()
        transaction.onerror = () =>
          reject(new Error('Failed to rebase sync version'))
        transaction.onabort = () =>
          reject(new Error('Sync version rebase transaction aborted'))
        request.onerror = () =>
          reject(new Error('Failed to read chat before rebasing sync version'))
        request.onsuccess = () => {
          const chat = request.result as StoredChat | undefined
          if (!chat) return
          chat.syncVersion = syncVersion
          chat.locallyModified = true
          chat.pendingUpload = derivePendingUpload(chat)
          const putRequest = putStoredChat(store, summaryStore, chat)
          putRequest.onerror = () =>
            reject(new Error('Failed to rebase sync version'))
        }
      })
    })
  }

  /**
   * Atomic upload finalization (§C6 / §H5).
   *
   * Runs inside `saveQueue` so it is serialized with any concurrent
   * user saves. Re-reads the chat fresh and verifies its content fingerprint
   * before applying attachment id/key rewrites or clearing `locallyModified`.
   *
   * If a concurrent edit is detected, the new sync version is still
   * persisted but the chat stays `locallyModified=true` so the next
   * sync cycle uploads the new content.
   */
  async finalizeUpload(opts: {
    chatId: string
    rewrites: AttachmentRewrite[]
    preUploadUpdatedAt: string | undefined
    preUploadFingerprint: string
    syncVersion: number
    uploadedProjectId: string | undefined
    projectIntentIncluded: boolean
  }): Promise<void> {
    return this.enqueueSave('finalizeUpload', async () => {
      const db = await this.ensureDB()
      return new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(
          [CHATS_STORE, ATTACHMENT_PAYLOADS_STORE, CHAT_SUMMARIES_STORE],
          'readwrite',
        )
        const store = transaction.objectStore(CHATS_STORE)
        const payloadStore = transaction.objectStore(ATTACHMENT_PAYLOADS_STORE)
        const summaryStore = transaction.objectStore(CHAT_SUMMARIES_STORE)
        const chatRequest = store.get(opts.chatId)
        const payloadRequest = payloadStore
          .index(ATTACHMENT_PAYLOADS_CHAT_INDEX)
          .getAll(IDBKeyRange.only(opts.chatId))
        transaction.oncomplete = () => resolve()
        transaction.onerror = () =>
          reject(new Error('Failed to finalize upload'))
        transaction.onabort = () =>
          reject(new Error('Upload finalization transaction aborted'))
        chatRequest.onerror = () =>
          reject(new Error('Failed to read chat before finalizing upload'))
        payloadRequest.onerror = () =>
          reject(
            new Error('Failed to read attachment payloads before finalizing'),
          )
        payloadRequest.onsuccess = () => {
          const chat = chatRequest.result as StoredChat | undefined
          if (!chat) return

          let hydratedChat: StoredChat
          try {
            hydratedChat = hydrateAttachmentPayloads(
              chat,
              payloadRequest.result as StoredAttachmentPayload[],
            )
          } catch (error) {
            transaction.abort()
            reject(error)
            return
          }
          const currentFingerprint = chatContentFingerprint(hydratedChat)
          const concurrentEdit =
            (opts.preUploadUpdatedAt !== undefined &&
              chat.updatedAt !== opts.preUploadUpdatedAt) ||
            currentFingerprint !== opts.preUploadFingerprint

          if (!concurrentEdit && opts.rewrites.length > 0) {
            applyAttachmentRewritesInPlace(chat.messages ?? [], opts.rewrites)
          }

          chat.syncVersion = opts.syncVersion
          chat.syncUserId ??= activeUserId()
          if (
            opts.projectIntentIncluded &&
            chat.projectId === opts.uploadedProjectId
          ) {
            chat.projectLocallyModified = false
          }
          if (!concurrentEdit) {
            chat.locallyModified = false
            chat.syncedAt = Date.now()
            // Clock is current as of the uploaded version. On a concurrent
            // edit the chat stays dirty and clockVersion intentionally lags
            // so the next upload re-stamps it.
            chat.clockVersion = opts.syncVersion
          }
          chat.pendingUpload = derivePendingUpload(chat)
          const normalizedAttachments =
            normalizeAttachmentPayloadsInTransaction(chat, transaction, reject)
          if (!normalizedAttachments) return
          chat.messages = normalizedAttachments.messages

          const writeChatAndPayloads = () => {
            for (const payload of normalizedAttachments.payloads) {
              payloadStore.put(payload)
            }
            const request = putStoredChat(store, summaryStore, chat)
            request.onerror = () =>
              reject(new Error('Failed to finalize upload'))
          }
          const payloadCursor = payloadStore
            .index(ATTACHMENT_PAYLOADS_CHAT_INDEX)
            .openCursor(IDBKeyRange.only(chat.id))
          payloadCursor.onerror = () =>
            reject(new Error('Failed to reconcile finalized attachments'))
          payloadCursor.onsuccess = () => {
            const cursor = payloadCursor.result
            if (cursor) {
              if (
                !normalizedAttachments.referencedPayloadIds.has(
                  String(cursor.primaryKey),
                )
              ) {
                cursor.delete()
              }
              cursor.continue()
              return
            }
            writeChatAndPayloads()
          }
        }
      })
    })
  }

  /**
   * CAS ingest (§H6). Apply a remote chat locally only when the
   * on-disk row still matches the snapshot the caller observed.
   * Returns `{ applied: true }` on write and `{ applied: false }`
   * when an interleaved local edit means the remote would clobber
   * the user's in-progress work.
   *
   * Pass `expectedLocalUpdatedAt: undefined` to force the write
   * (e.g. last-write-wins conflict resolution).
   *
   * Pass `allowLocallyModified: true` to keep the timestamp CAS while
   * permitting an overwrite of a `locallyModified` row. Last-write-wins
   * conflict resolution uses this: the remote has already been judged
   * the winner, but the apply must still no-op if the local row changed
   * since that judgement (a TOCTOU edit during the remote download).
   */
  async applyRemoteChatIfFresh(opts: {
    chat: Chat
    syncVersion: number
    expectedLocalUpdatedAt: string | null | undefined
    setLoadedAt?: boolean
    allowLocallyModified?: boolean
    isCurrent?: () => boolean
    userId?: string
  }): Promise<{ applied: boolean }> {
    return this.enqueueSave('applyRemoteChatIfFresh', async () => {
      const isCurrent = opts.isCurrent ?? (() => true)
      if (!isCurrent()) return { applied: false }
      const db = await this.ensureDB()
      if (!isCurrent()) return { applied: false }

      return new Promise<{ applied: boolean }>((resolve, reject) => {
        const transaction = db.transaction(
          [
            CHATS_STORE,
            ATTACHMENT_PAYLOADS_STORE,
            CHAT_SUMMARIES_STORE,
            SYNC_OUTBOX_STORE,
          ],
          'readwrite',
        )
        const store = transaction.objectStore(CHATS_STORE)
        const payloadStore = transaction.objectStore(ATTACHMENT_PAYLOADS_STORE)
        const summaryStore = transaction.objectStore(CHAT_SUMMARIES_STORE)
        const outboxStore = transaction.objectStore(SYNC_OUTBOX_STORE)
        const userId = opts.userId ?? chatOwnerId(opts.chat) ?? activeUserId()
        let existing: StoredChat | undefined
        let existingPayloads: StoredAttachmentPayload[] = []
        let hasPendingDelete = false
        let readsRemaining = userId ? 3 : 2
        let applied = false
        let accountChanged = false

        const abortIfStale = (): boolean => {
          if (isCurrent()) return false
          accountChanged = true
          try {
            transaction.abort()
          } catch {}
          return true
        }
        const maybeApply = () => {
          readsRemaining--
          if (readsRemaining > 0 || abortIfStale() || hasPendingDelete) return
          if (opts.expectedLocalUpdatedAt !== undefined) {
            if (opts.expectedLocalUpdatedAt === null) {
              if (existing) return
            } else if (
              !existing ||
              existing.updatedAt !== opts.expectedLocalUpdatedAt ||
              (existing.locallyModified === true && !opts.allowLocallyModified)
            ) {
              return
            }
          }

          let inheritedChat: Chat
          try {
            inheritedChat = inheritAttachmentPayloadReferences(
              opts.chat,
              existing,
              existingPayloads,
            )
          } catch (error) {
            transaction.abort()
            reject(error)
            return
          }
          const normalizedAttachments =
            normalizeAttachmentPayloadsInTransaction(
              inheritedChat,
              transaction,
              reject,
            )
          if (!normalizedAttachments) return
          const messagesForStorage = normalizedAttachments.messages.map(
            (msg) => ({
              ...msg,
              timestamp:
                msg.timestamp instanceof Date
                  ? msg.timestamp.toISOString()
                  : msg.timestamp,
            }),
          )
          const storedChat: StoredChat = {
            ...opts.chat,
            messages: messagesForStorage as any,
            lastAccessedAt: Date.now(),
            syncedAt: Date.now(),
            locallyModified: false,
            syncPending: 0,
            pendingUpload: 0,
            syncVersion: opts.syncVersion,
            version: 1,
            loadedAt: opts.setLoadedAt
              ? Date.now()
              : ((opts.chat as StoredChat).loadedAt ?? existing?.loadedAt),
            isLocalOnly: (opts.chat as StoredChat).isLocalOnly ?? false,
            syncUserId: userId,
            projectLocallyModified: false,
          }

          const writeChatAndPayloads = () => {
            if (abortIfStale()) return
            for (const payload of normalizedAttachments.payloads) {
              const payloadRequest = payloadStore.put(payload)
              payloadRequest.onerror = () =>
                reject(
                  payloadRequest.error ??
                    new Error('Failed to save remote attachment payload'),
                )
            }
            const putRequest = putStoredChat(store, summaryStore, storedChat)
            putRequest.onerror = () =>
              reject(new Error('Failed to apply remote chat'))
            putRequest.onsuccess = () => {
              if (!abortIfStale()) applied = true
            }
          }
          const payloadCursor = payloadStore
            .index(ATTACHMENT_PAYLOADS_CHAT_INDEX)
            .openCursor(IDBKeyRange.only(opts.chat.id))
          payloadCursor.onerror = () =>
            reject(new Error('Failed to reconcile remote attachment payloads'))
          payloadCursor.onsuccess = () => {
            if (abortIfStale()) return
            const cursor = payloadCursor.result
            if (cursor) {
              if (
                !normalizedAttachments.referencedPayloadIds.has(
                  String(cursor.primaryKey),
                )
              ) {
                cursor.delete()
              }
              cursor.continue()
              return
            }
            writeChatAndPayloads()
          }
        }

        const chatRequest = store.get(opts.chat.id)
        chatRequest.onsuccess = () => {
          existing = chatRequest.result as StoredChat | undefined
          maybeApply()
        }
        chatRequest.onerror = () => reject(new Error('Failed to read chat'))
        const payloadRequest = payloadStore
          .index(ATTACHMENT_PAYLOADS_CHAT_INDEX)
          .getAll(IDBKeyRange.only(opts.chat.id))
        payloadRequest.onsuccess = () => {
          existingPayloads = payloadRequest.result as StoredAttachmentPayload[]
          maybeApply()
        }
        payloadRequest.onerror = () =>
          reject(new Error('Failed to read attachment payloads'))
        if (userId) {
          const deleteRequest = outboxStore.get([userId, opts.chat.id])
          deleteRequest.onsuccess = () => {
            hasPendingDelete = deleteRequest.result !== undefined
            maybeApply()
          }
          deleteRequest.onerror = () =>
            reject(new Error('Failed to inspect pending delete'))
        }
        transaction.oncomplete = () =>
          resolve({ applied: isCurrent() ? applied : false })
        transaction.onerror = () =>
          reject(new Error('Failed to apply remote chat'))
        transaction.onabort = () => {
          if (accountChanged) resolve({ applied: false })
          else reject(new Error('Remote chat transaction aborted'))
        }
      })
    })
  }

  /**
   * Wipe sync metadata for every chat (§H4). Called after a
   * `start_fresh` rotation so subsequent pushes go up as fresh
   * creates instead of failing the next ETag CAS forever.
   */
  async resetSyncMetadataForAllChats(): Promise<void> {
    return this.enqueueSave('resetSyncMetadataForAllChats', async () => {
      const db = await this.ensureDB()
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(
          [CHATS_STORE, CHAT_SUMMARIES_STORE],
          'readwrite',
        )
        const store = transaction.objectStore(CHATS_STORE)
        const summaryStore = transaction.objectStore(CHAT_SUMMARIES_STORE)
        transaction.oncomplete = () => resolve()
        transaction.onerror = () =>
          reject(new Error('Failed to reset sync metadata'))

        const request = store.openCursor()
        request.onsuccess = (event) => {
          const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result
          if (!cursor) return
          const chat = cursor.value as StoredChat
          chat.syncVersion = 0
          chat.syncedAt = undefined
          chat.locallyModified = true
          chat.syncUserId ??= activeUserId()
          chat.pendingUpload = derivePendingUpload(chat)
          const prepared = updateSyncPending(chat)
          cursor.update(prepared)
          summaryStore.put(toStoredChatSummary(prepared))
          cursor.continue()
        }
        request.onerror = () =>
          reject(new Error('Failed to iterate chats for sync reset'))
      })
    })
  }

  async resetChatTimestamps(chatId: string): Promise<void> {
    return this.enqueueSave('resetChatTimestamps', async () => {
      const db = await this.ensureDB()
      const chat = await this.getStoredChatInternal(chatId)

      if (chat) {
        return new Promise<void>((resolve, reject) => {
          const transaction = db.transaction(
            [CHATS_STORE, CHAT_SUMMARIES_STORE],
            'readwrite',
          )
          const store = transaction.objectStore(CHATS_STORE)
          const summaryStore = transaction.objectStore(CHAT_SUMMARIES_STORE)

          transaction.oncomplete = () => resolve()
          transaction.onerror = () =>
            reject(new Error('Failed to reset chat timestamps'))

          const now = new Date().toISOString()
          chat.createdAt = now
          chat.updatedAt = now
          chat.locallyModified = true
          chat.pendingUpload = derivePendingUpload(chat)
          chat.syncedAt = undefined

          const request = putStoredChat(store, summaryStore, chat)

          request.onerror = () =>
            reject(new Error('Failed to reset chat timestamps'))
        })
      }
    })
  }

  async updateChatProject(
    chatId: string,
    projectId: string | null,
  ): Promise<void> {
    return this.enqueueSave('updateChatProject', async () => {
      const chat = await this.getStoredChatInternal(chatId)
      if (chat) {
        chat.projectId = projectId ?? undefined
        chat.projectLocallyModified = true
        chat.locallyModified = true
        chat.updatedAt = new Date().toISOString()
        await this.saveChatInternal(chat)
      }
    })
  }

  async applyRemoteChatProject(
    chatId: string,
    projectId: string | null,
    expectedLocalUpdatedAt: string | null,
  ): Promise<boolean> {
    return this.enqueueSave('applyRemoteChatProject', async () => {
      const chat = await this.getStoredChatInternal(chatId)
      if (
        !chat ||
        chat.updatedAt !== expectedLocalUpdatedAt ||
        chat.locallyModified
      ) {
        return false
      }
      chat.projectId = projectId ?? undefined
      chat.projectLocallyModified = false
      await this.saveChatInternal(chat, {
        markContentChangesAsLocal: false,
      })
      return true
    })
  }

  async updateChatLocalOnly(
    chatId: string,
    isLocalOnly: boolean,
  ): Promise<void> {
    return this.enqueueSave('updateChatLocalOnly', async () => {
      const chat = await this.getStoredChatInternal(chatId)
      if (chat) {
        chat.isLocalOnly = isLocalOnly
        chat.locallyModified = true
        chat.updatedAt = new Date().toISOString()
        await this.saveChatInternal(chat, { allowLocalOnlyChange: true })
      }
    })
  }

  async getSyncState(userId: string): Promise<SyncState | null> {
    await this.saveQueue.catch(() => {})
    const db = await this.ensureDB()
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(SYNC_STATE_STORE, 'readonly')
      const syncState = transaction.objectStore(SYNC_STATE_STORE)
      const request = syncState.get(ACCOUNT_SYNC_STATE_ID)
      transaction.oncomplete = () => {
        const state = request.result as SyncState | undefined
        resolve(state?.userId === userId ? state : null)
      }
      request.onerror = () => reject(new Error('Failed to read sync state'))
    })
  }

  async hasPendingSyncWork(userId: string): Promise<boolean> {
    await this.saveQueue.catch(() => {})
    const db = await this.ensureDB()
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(
        [CHATS_STORE, SYNC_OUTBOX_STORE],
        'readonly',
      )
      let pendingUploads = 0
      let pendingDeletes = 0
      const uploadRequest = transaction
        .objectStore(CHATS_STORE)
        .index('pendingUploadByUser')
        .count(IDBKeyRange.only([1, userId]))
      const deleteRequest = transaction
        .objectStore(SYNC_OUTBOX_STORE)
        .index('userId')
        .count(IDBKeyRange.only(userId))
      uploadRequest.onsuccess = () => {
        pendingUploads = uploadRequest.result
      }
      deleteRequest.onsuccess = () => {
        pendingDeletes = deleteRequest.result
      }
      transaction.oncomplete = () =>
        resolve(pendingUploads > 0 || pendingDeletes > 0)
      transaction.onerror = () =>
        reject(new Error('Failed to inspect pending sync work'))
    })
  }

  async getPendingUploadChats(userId: string): Promise<StoredChat[]> {
    await this.saveQueue.catch(() => {})
    const db = await this.ensureDB()
    return new Promise((resolve, reject) => {
      const request = db
        .transaction(CHATS_STORE, 'readonly')
        .objectStore(CHATS_STORE)
        .index('pendingUploadByUser')
        .getAll(IDBKeyRange.only([1, userId]))
      request.onsuccess = () => resolve(request.result as StoredChat[])
      request.onerror = () =>
        reject(new Error('Failed to list pending uploads'))
    })
  }

  async deleteChatWithPendingIntent(
    id: string,
    idempotencyKey: string,
    userId: string,
    options: {
      /**
       * Queue the delete intent even when the local row cannot prove
       * remote durability. Used for in-flight uploads and memory-only
       * remote chats so deletion still runs after any upload settles.
       */
      forceQueue?: boolean
    } = {},
  ): Promise<boolean> {
    return this.enqueueSave('deleteChatWithPendingIntent', async () => {
      const db = await this.ensureDB()
      return new Promise<boolean>((resolve, reject) => {
        const transaction = db.transaction(
          [
            CHATS_STORE,
            ATTACHMENT_PAYLOADS_STORE,
            CHAT_SUMMARIES_STORE,
            SYNC_OUTBOX_STORE,
          ],
          'readwrite',
        )
        const chats = transaction.objectStore(CHATS_STORE)
        const outbox = transaction.objectStore(SYNC_OUTBOX_STORE)
        let queued = false
        const request = chats.get(id)
        request.onsuccess = () => {
          const chat = request.result as StoredChat | undefined
          chats.delete(id)
          transaction.objectStore(CHAT_SUMMARIES_STORE).delete(id)
          deleteAttachmentPayloadsForChat(
            transaction.objectStore(ATTACHMENT_PAYLOADS_STORE),
            id,
          )
          if (
            (chat === undefined && options.forceQueue === true) ||
            (chat !== undefined &&
              !chat.isLocalOnly &&
              chat.syncUserId === userId &&
              (options.forceQueue === true || chatKnownToServer(chat)))
          ) {
            outbox.put(syncDeleteOutboxEntry(id, userId, idempotencyKey))
            queued = true
          }
        }
        transaction.oncomplete = () => resolve(queued)
        transaction.onerror = () =>
          reject(new Error('Failed to persist pending chat deletion'))
      })
    })
  }

  async getPendingDeletes(userId: string): Promise<SyncDeleteOutboxEntry[]> {
    await this.saveQueue.catch(() => {})
    const db = await this.ensureDB()
    return new Promise((resolve, reject) => {
      const request = db
        .transaction(SYNC_OUTBOX_STORE, 'readonly')
        .objectStore(SYNC_OUTBOX_STORE)
        .index('userId')
        .getAll(IDBKeyRange.only(userId))
      request.onsuccess = () => resolve(request.result)
      request.onerror = () =>
        reject(new Error('Failed to list pending deletes'))
    })
  }

  async enqueuePendingDelete(
    id: string,
    idempotencyKey: string,
    userId: string,
  ): Promise<boolean> {
    return this.enqueueSave('enqueuePendingDelete', async () => {
      const db = await this.ensureDB()
      return new Promise<boolean>((resolve, reject) => {
        const transaction = db.transaction(
          [CHATS_STORE, SYNC_OUTBOX_STORE],
          'readwrite',
        )
        let queued = false
        const request = transaction.objectStore(CHATS_STORE).get(id)
        request.onsuccess = () => {
          const chat = request.result as StoredChat | undefined
          if (!chat || chat.syncUserId !== userId || !chatKnownToServer(chat)) {
            return
          }
          transaction
            .objectStore(SYNC_OUTBOX_STORE)
            .put(syncDeleteOutboxEntry(id, userId, idempotencyKey))
          queued = true
        }
        transaction.oncomplete = () => resolve(queued)
        transaction.onerror = () =>
          reject(new Error('Failed to enqueue pending chat deletion'))
      })
    })
  }

  async acknowledgePendingDelete(id: string, userId: string): Promise<void> {
    return this.enqueueSave('acknowledgePendingDelete', async () => {
      const db = await this.ensureDB()
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(SYNC_OUTBOX_STORE, 'readwrite')
        const store = transaction.objectStore(SYNC_OUTBOX_STORE)
        const key: [string, string] = [userId, id]
        const request = store.get(key)
        request.onsuccess = () => {
          if (request.result) store.delete(key)
        }
        transaction.oncomplete = () => resolve()
        transaction.onerror = () =>
          reject(new Error('Failed to acknowledge pending delete'))
      })
    })
  }

  async acknowledgePendingDeletes(
    ids: string[],
    userId: string,
    isCurrent: () => boolean = () => true,
  ): Promise<void> {
    return this.enqueueSave('acknowledgePendingDeletes', async () => {
      if (!isCurrent()) return
      const db = await this.ensureDB()
      if (!isCurrent()) return
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(SYNC_OUTBOX_STORE, 'readwrite')
        const store = transaction.objectStore(SYNC_OUTBOX_STORE)
        let accountChanged = false
        for (const id of new Set(ids)) {
          if (!isCurrent()) {
            accountChanged = true
            try {
              transaction.abort()
            } catch {}
            break
          }
          const request = store.delete([userId, id])
          request.onsuccess = () => {
            if (!isCurrent()) {
              accountChanged = true
              try {
                transaction.abort()
              } catch {}
            }
          }
        }
        transaction.oncomplete = () => resolve()
        transaction.onerror = () =>
          reject(new Error('Failed to acknowledge pending deletes'))
        transaction.onabort = () =>
          reject(
            new Error(
              accountChanged
                ? 'Cloud account changed while acknowledging project deletion'
                : 'Pending delete acknowledgement transaction aborted',
            ),
          )
      })
    })
  }

  async applyRemoteDeletion(
    id: string,
    userId: string,
    isCurrent: () => boolean = () => true,
  ): Promise<boolean> {
    return this.enqueueSave('applyRemoteDeletion', async () => {
      if (!isCurrent()) return false
      const db = await this.ensureDB()
      if (!isCurrent()) return false
      return new Promise<boolean>((resolve, reject) => {
        const transaction = db.transaction(
          [
            CHATS_STORE,
            ATTACHMENT_PAYLOADS_STORE,
            CHAT_SUMMARIES_STORE,
            SYNC_OUTBOX_STORE,
          ],
          'readwrite',
        )
        const store = transaction.objectStore(CHATS_STORE)
        const outbox = transaction.objectStore(SYNC_OUTBOX_STORE)
        let deleted = false
        let accountChanged = false
        const abortIfStale = (): boolean => {
          if (isCurrent()) return false
          accountChanged = true
          try {
            transaction.abort()
          } catch {}
          return true
        }
        const request = store.get(id)
        request.onsuccess = () => {
          if (abortIfStale()) return
          const chat = request.result as StoredChat | undefined
          if (!chat || chat.isLocalOnly || chat.syncUserId !== userId) return
          const deleteRequest = store.delete(id)
          deleteRequest.onsuccess = () => {
            abortIfStale()
          }
          transaction.objectStore(CHAT_SUMMARIES_STORE).delete(id)
          deleteAttachmentPayloadsForChat(
            transaction.objectStore(ATTACHMENT_PAYLOADS_STORE),
            id,
          )
          deleted = true
        }
        const outboxKey: [string, string] = [userId, id]
        const outboxRequest = outbox.get(outboxKey)
        outboxRequest.onsuccess = () => {
          if (abortIfStale()) return
          if (outboxRequest.result) {
            const deleteRequest = outbox.delete(outboxKey)
            deleteRequest.onsuccess = () => {
              abortIfStale()
            }
          }
        }
        transaction.oncomplete = () => resolve(deleted)
        transaction.onerror = () =>
          reject(new Error('Failed to apply remote deletion'))
        transaction.onabort = () =>
          reject(
            new Error(
              accountChanged
                ? 'Cloud account changed during remote deletion'
                : 'Remote deletion transaction aborted',
            ),
          )
      })
    })
  }

  async commitRevisionBatch(
    states: RemoteChatState[],
    appliedRevision: string,
    userId: string,
  ): Promise<void> {
    return this.enqueueSave('commitRevisionBatch', async () => {
      const db = await this.ensureDB()
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(
          [
            CHATS_STORE,
            CHAT_SUMMARIES_STORE,
            REMOTE_CHAT_STATE_STORE,
            SYNC_STATE_STORE,
          ],
          'readwrite',
        )
        const chats = transaction.objectStore(CHATS_STORE)
        const summaries = transaction.objectStore(CHAT_SUMMARIES_STORE)
        const remote = transaction.objectStore(REMOTE_CHAT_STATE_STORE)
        for (const state of states) {
          remote.put(state)
          if (state.kind === 'upsert') {
            const request = chats.get(state.id)
            request.onsuccess = () => {
              const chat = request.result as StoredChat | undefined
              if (!chat || chat.isLocalOnly || chat.projectLocallyModified) {
                return
              }
              chat.projectId = state.projectId ?? undefined
              chat.projectLocallyModified = false
              chats.put(chat)
              summaries.put(toStoredChatSummary(chat))
            }
          }
        }
        transaction.objectStore(SYNC_STATE_STORE).put({
          id: ACCOUNT_SYNC_STATE_ID,
          userId,
          appliedRevision,
          bootstrapped: true,
        } satisfies SyncState)
        transaction.oncomplete = () => resolve()
        transaction.onerror = () =>
          reject(new Error('Failed to commit revision checkpoint'))
      })
    })
  }

  async reconcileRevisionSnapshot(
    states: RemoteChatState[],
    snapshotRevision: string,
    userId: string,
  ): Promise<string[]> {
    return this.enqueueSave('reconcileRevisionSnapshot', async () => {
      const db = await this.ensureDB()
      return new Promise<string[]>((resolve, reject) => {
        const transaction = db.transaction(
          [
            CHATS_STORE,
            ATTACHMENT_PAYLOADS_STORE,
            CHAT_SUMMARIES_STORE,
            REMOTE_CHAT_STATE_STORE,
            SYNC_STATE_STORE,
          ],
          'readwrite',
        )
        const chats = transaction.objectStore(CHATS_STORE)
        const payloads = transaction.objectStore(ATTACHMENT_PAYLOADS_STORE)
        const summaries = transaction.objectStore(CHAT_SUMMARIES_STORE)
        const remote = transaction.objectStore(REMOTE_CHAT_STATE_STORE)
        const remoteById = new Map(states.map((state) => [state.id, state]))
        const deletedIds: string[] = []
        remote.clear()
        for (const state of states) remote.put(state)
        const cursorRequest = chats.openCursor()
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result
          if (!cursor) return
          const chat = cursor.value as StoredChat
          const state = remoteById.get(chat.id)
          if (chat.isLocalOnly) {
            cursor.continue()
            return
          }
          if (!state) {
            if (chatKnownToServer(chat)) {
              cursor.delete()
              summaries.delete(chat.id)
              deleteAttachmentPayloadsForChat(payloads, chat.id)
              deletedIds.push(chat.id)
            }
          } else if (!chat.projectLocallyModified) {
            chat.projectId = state.projectId ?? undefined
            chat.projectLocallyModified = false
            cursor.update(chat)
            summaries.put(toStoredChatSummary(chat))
          }
          cursor.continue()
        }
        transaction.objectStore(SYNC_STATE_STORE).put({
          id: ACCOUNT_SYNC_STATE_ID,
          userId,
          appliedRevision: snapshotRevision,
          bootstrapped: true,
        } satisfies SyncState)
        transaction.oncomplete = () => resolve(deletedIds)
        transaction.onerror = () =>
          reject(new Error('Failed to reconcile revision snapshot'))
      })
    })
  }

  async getRemoteChatState(id: string): Promise<RemoteChatState | null> {
    const db = await this.ensureDB()
    return new Promise((resolve, reject) => {
      const request = db
        .transaction(REMOTE_CHAT_STATE_STORE, 'readonly')
        .objectStore(REMOTE_CHAT_STATE_STORE)
        .get(id)
      request.onsuccess = () => resolve(request.result ?? null)
      request.onerror = () =>
        reject(new Error('Failed to read remote chat state'))
    })
  }

  async clearRevisionSyncState(): Promise<void> {
    return this.clearRevisionCheckpoint()
  }

  async clearRevisionSyncStateAfterServerWipe(userId: string): Promise<void> {
    return this.enqueueSave(
      'clearRevisionSyncStateAfterServerWipe',
      async () => {
        const db = await this.ensureDB()
        await new Promise<void>((resolve, reject) => {
          const transaction = db.transaction(
            [SYNC_STATE_STORE, REMOTE_CHAT_STATE_STORE, SYNC_OUTBOX_STORE],
            'readwrite',
          )
          transaction.objectStore(SYNC_STATE_STORE).clear()
          transaction.objectStore(REMOTE_CHAT_STATE_STORE).clear()
          const outbox = transaction.objectStore(SYNC_OUTBOX_STORE)
          const request = outbox
            .index('userId')
            .openKeyCursor(IDBKeyRange.only(userId))
          request.onsuccess = () => {
            const cursor = request.result
            if (!cursor) return
            outbox.delete(cursor.primaryKey)
            cursor.continue()
          }
          transaction.oncomplete = () => resolve()
          transaction.onerror = () =>
            reject(new Error('Failed to clear sync state after server wipe'))
        })
      },
    )
  }

  async clearRevisionCheckpoint(): Promise<void> {
    return this.enqueueSave('clearRevisionCheckpoint', async () => {
      const db = await this.ensureDB()
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(
          [SYNC_STATE_STORE, REMOTE_CHAT_STATE_STORE],
          'readwrite',
        )
        transaction.objectStore(SYNC_STATE_STORE).clear()
        transaction.objectStore(REMOTE_CHAT_STATE_STORE).clear()
        transaction.oncomplete = () => resolve()
        transaction.onerror = () =>
          reject(new Error('Failed to clear revision checkpoint'))
      })
    })
  }
}

export const indexedDBStorage = new IndexedDBStorage()

export function handleIndexedDBAccountResetStorageEvent(
  storage: IndexedDBStorage,
  event: StorageEvent,
): void {
  if (event.key !== AUTH_ACCOUNT_RESET_SIGNAL || !event.newValue) return
  void storage
    .resetForAccountChange(false)
    .then(() => {
      sessionStorage.removeItem(AUTH_ACCOUNT_RESET_FAILED)
      deletedChatsTracker.clear()
      window.location.reload()
    })
    .catch((error) => {
      logError(
        'Failed to reset IndexedDB after cross-tab account change',
        error,
        {
          component: 'IndexedDBStorage',
          action: 'crossTabAccountReset',
        },
      )
      sessionStorage.setItem(AUTH_ACCOUNT_RESET_FAILED, 'true')
      window.dispatchEvent(new CustomEvent(ACCOUNT_RESET_FAILED_EVENT))
    })
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    handleIndexedDBAccountResetStorageEvent(indexedDBStorage, event)
  })
}
