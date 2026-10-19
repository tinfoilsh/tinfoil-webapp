/**
 * Chat Codec
 *
 * Decode chats returned by the sync enclave. The enclave unseals
 * server-side and hands us plaintext JSON, so this module only
 * understands the v2 plaintext shape — legacy v0/v1 client-side
 * decrypt has been removed.
 */

import { DEFAULT_CHAT_TITLE } from '@/constants/chat'
import { ensureValidISODate } from '@/utils/chat-timestamps'
import { logInfo } from '@/utils/error-handling'
import type { ChatSyncMetadata, StoredChat } from '../storage/indexed-db'
import { observe } from './edit-clock'
import { RemoteChatPlaintextSchema, type RemoteChatMessage } from './schemas'

export interface RemoteChatData {
  id: string
  /**
   * Plaintext JSON returned by the sync enclave after server-side
   * unsealing. v2 is the only format the codec accepts.
   */
  plaintext?: string | null
  createdAt?: string | null
  updatedAt?: string | null
  formatVersion?: number
  syncVersion?: number
  projectId?: string
}

export interface ProcessedChatResult {
  chat: StoredChat
  status: 'decrypted' | 'no_content'
}

export interface ProcessRemoteChatOptions {
  localChat?: Pick<ChatSyncMetadata, 'projectId'> | null
  projectId?: string | null
}

export class RemoteChatDecodeError extends Error {
  constructor(
    public readonly reason: 'invalid_json' | 'invalid_shape',
    options?: ErrorOptions,
  ) {
    super(`v2_plaintext_invalid: ${reason}`, options)
    this.name = 'RemoteChatDecodeError'
  }
}

type StoredMessage = StoredChat['messages'][number]
type StoredAttachment = NonNullable<StoredMessage['attachments']>[number]

function hasNonEmptyString(
  value: Record<string, unknown>,
  field: string,
): boolean {
  return typeof value[field] === 'string' && value[field].trim().length > 0
}

function hasReadablePages(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.some(
      (page) =>
        page !== null &&
        typeof page === 'object' &&
        (hasNonEmptyString(page as Record<string, unknown>, 'text') ||
          hasNonEmptyString(page as Record<string, unknown>, 'image')),
    )
  )
}

function isUsableRemoteAttachment(value: unknown): value is StoredAttachment {
  if (value === null || typeof value !== 'object') return false
  const attachment = value as Record<string, unknown>
  if (
    (attachment.type !== 'image' && attachment.type !== 'document') ||
    typeof attachment.id !== 'string' ||
    typeof attachment.fileName !== 'string'
  ) {
    return false
  }
  if (hasNonEmptyString(attachment, 'base64')) return true
  if (hasNonEmptyString(attachment, 'thumbnailBase64')) return true
  if (attachment.type === 'document') {
    // Inline content or an enclave key the content can be fetched by.
    return (
      hasNonEmptyString(attachment, 'textContent') ||
      hasReadablePages(attachment.pages) ||
      (hasNonEmptyString(attachment, 'id') &&
        hasNonEmptyString(attachment, 'encryptionKey'))
    )
  }
  return (
    hasNonEmptyString(attachment, 'id') &&
    (hasNonEmptyString(attachment, 'encryptionKey') ||
      hasNonEmptyString(attachment, 'key'))
  )
}

function sanitizeRemoteMessages(
  messages: RemoteChatMessage[],
): StoredChat['messages'] {
  return messages.map((message) => {
    const attachments = Array.isArray(message.attachments)
      ? message.attachments.filter(isUsableRemoteAttachment)
      : undefined
    return { ...message, attachments } as StoredMessage
  })
}

/**
 * Decode a plaintext v2 row coming back from the enclave into a
 * `StoredChat`. Failure modes:
 *   - missing plaintext        → `status: 'no_content'` placeholder
 *   - malformed plaintext JSON → thrown error tagged `v2_plaintext_invalid`
 *     so callers can route it through `decideRecovery`.
 */
export async function processRemoteChat(
  remote: RemoteChatData,
  options: ProcessRemoteChatOptions = {},
): Promise<ProcessedChatResult> {
  const { localChat, projectId } = options
  const hasExplicitProjectId = 'projectId' in options
  const effectiveProjectId = hasExplicitProjectId
    ? (projectId ?? undefined)
    : localChat?.projectId

  const safeCreatedAt = ensureValidISODate(
    remote.createdAt ?? remote.updatedAt,
    remote.id,
  )
  const safeUpdatedAt = ensureValidISODate(
    remote.updatedAt ?? remote.createdAt,
    remote.id,
  )

  // Only a missing plaintext is "no content"; an empty string is a
  // zero-byte (corrupt) row and must fall through to the parse so it
  // surfaces as v2_plaintext_invalid instead of a benign placeholder.
  if (remote.plaintext == null) {
    logInfo('Remote chat has no plaintext', {
      component: 'ChatCodec',
      action: 'processRemoteChat',
      metadata: { chatId: remote.id },
    })

    return {
      chat: createPlaceholderChat({
        id: remote.id,
        createdAt: safeCreatedAt,
        updatedAt: safeUpdatedAt,
        projectId: effectiveProjectId,
      }),
      status: 'no_content',
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(remote.plaintext)
  } catch (parseErr) {
    if (parseErr instanceof SyntaxError)
      throw new RemoteChatDecodeError('invalid_json', { cause: parseErr })
    throw parseErr
  }

  const validation = RemoteChatPlaintextSchema.safeParse(parsed)
  if (!validation.success) {
    throw new RemoteChatDecodeError('invalid_shape', {
      cause: validation.error,
    })
  }
  const decrypted = validation.data
  const messages = sanitizeRemoteMessages(decrypted.messages)

  // Advance the local logical clock past any remote edit clock so a
  // later local edit is guaranteed to outrank what we just observed.
  observe(typeof decrypted.clock === 'number' ? decrypted.clock : null)

  const chat: StoredChat = {
    ...decrypted,
    title: decrypted.title ?? DEFAULT_CHAT_TITLE,
    // MessageSchema validates the fields the app depends on and
    // passes the rest through, so the runtime shape is a Message.
    messages,
    id: remote.id,
    createdAt: ensureValidISODate(
      decrypted.createdAt ?? remote.createdAt ?? remote.updatedAt,
      remote.id,
    ),
    updatedAt: ensureValidISODate(
      decrypted.updatedAt ?? remote.updatedAt ?? remote.createdAt,
      remote.id,
    ),
    lastAccessedAt: Date.now(),
    syncedAt: Date.now(),
    locallyModified: false,
    syncVersion: remote.syncVersion ?? decrypted.syncVersion ?? 1,
    clockVersion:
      remote.syncVersion === undefined ? undefined : decrypted.clockVersion,
    formatVersion: 2,
    projectId: hasExplicitProjectId
      ? (projectId ?? undefined)
      : (decrypted.projectId ?? localChat?.projectId),
  }

  return { chat, status: 'decrypted' }
}

interface PlaceholderOptions {
  id: string
  createdAt: string
  updatedAt: string
  projectId?: string
}

function createPlaceholderChat(options: PlaceholderOptions): StoredChat {
  const { id, createdAt, updatedAt, projectId } = options

  return {
    id,
    title: 'Encrypted',
    messages: [],
    createdAt,
    updatedAt,
    lastAccessedAt: Date.now(),
    decryptionFailed: false,
    dataCorrupted: false,
    formatVersion: 2,
    syncedAt: Date.now(),
    locallyModified: false,
    syncVersion: 1,
    projectId,
  } as StoredChat
}

export async function processRemoteChats(
  remoteChats: RemoteChatData[],
  localChatMap: Map<string, ChatSyncMetadata>,
): Promise<ProcessedChatResult[]> {
  const results: ProcessedChatResult[] = []

  for (const remote of remoteChats) {
    const localChat = localChatMap.get(remote.id)
    const result = await processRemoteChat(remote, { localChat })
    results.push(result)
  }

  return results
}
