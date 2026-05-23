import type { Message } from '@/components/chat/types'
import { AUTH_ACTIVE_USER_ID } from '@/constants/storage-keys'
import {
  base64ToUint8Array,
  decryptAttachment,
  uint8ArrayToBase64,
} from '@/utils/binary-codec'
import { logError } from '@/utils/error-handling'
import { authTokenManager } from '../auth'
import { type StoredChat } from '../storage/indexed-db'
import {
  attachmentGet as enclaveAttachmentGet,
  attachmentPut as enclaveAttachmentPut,
  deleteRow as enclaveDeleteRow,
  listStatus as enclaveListStatus,
  pull as enclavePull,
  push as enclavePush,
  newIdempotencyKey,
  pullItemPlaintext,
  type ListStatusUpdate,
} from '../sync-enclave/sync-api'
import { pullKey, requirePrimaryKeyB64 } from './cek-encoding'
import { processRemoteChat, type RemoteChatData } from './chat-codec'

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL || 'https://api.tinfoil.sh'
const AUTH_INIT_WAIT_MS = 3000
const RESTORE_DELETED_CHAT_HEADER = 'X-Restore-Deleted-Chat'
const ENCLAVE_CHAT_LIST_LIMIT = 100

/**
 * Lean chat list entry. Anything the caller needs beyond (id,
 * updatedAt, projectId) must come from decrypting the row's content
 * — we deliberately do NOT carry title/messageCount/size on the wire
 * any more. Those columns lived on the controlplane only to render
 * the old client-side-decrypt list UI, and surfacing them here from
 * the new enclave path either lies (zeros / empty strings) or
 * duplicates plaintext that the resolver/ingest already derives.
 */
export interface ChatListResponse {
  conversations: Array<{
    id: string
    updatedAt: string
    content?: string
    projectId?: string
  }>
  nextContinuationToken?: string
  hasMore: boolean
}

export interface ChatSyncStatus {
  count: number
  lastUpdated: string | null
}

export interface ProfileSyncStatus {
  exists: boolean
  version?: number
  lastUpdated?: string
}

export interface BulkConversationResult {
  conversationId: string
  success: boolean
  error?: string
}

export interface BulkUploadResponse {
  results: BulkConversationResult[]
  succeeded: number
  failed: number
}

export interface UploadChatOptions {
  restoreDeleted?: boolean
  /**
   * Idempotency key for the enclave write. Required to be stable
   * across all HTTP retries of the same logical upload (§9.6 R1).
   * The upload coalescer owns generation; when called from outside
   * the coalescer (one-shot uploads, sign-in migration), the caller
   * MUST mint a fresh UUID-shaped value once per logical write.
   * When omitted, a fresh key is generated — this is only safe for
   * fire-and-forget uploads that have no retry caller above them.
   */
  idempotencyKey?: string
}

export type RawChatContent =
  | { content: string; formatVersion: 0 }
  | { binaryContent: ArrayBuffer; formatVersion: 1 }
  /**
   * Plaintext envelope-v2 JSON returned by the sync enclave. The `2`
   * here mirrors the wire `tinfoil-sync-envelope-v2` AAD (see
   * syncplan.md §5) — the row is sealed under v2 on the controlplane,
   * the enclave unsealed it, so what we hand back is plaintext.
   */
  | { plaintext: string; formatVersion: 2 }

function chatUpdateToMeta(
  update: ListStatusUpdate,
): ChatListResponse['conversations'][number] {
  return {
    id: update.id,
    updatedAt: update.updated_at,
    projectId: update.project_id ?? undefined,
  }
}

// hasNextCursor guards against truthy-but-meaningless cursor values
// (e.g. a Go zero-time `"0001-01-01T00:00:00Z"`) so paginating loops
// can't accidentally run forever if the server ever stops gating the
// field as carefully as today's `pickNextCursor` does.
function hasNextCursor(cursor: string | undefined): boolean {
  return typeof cursor === 'string' && cursor.length > 0
}

function stripBase64FromMessages(messages: Message[]): Message[] {
  return messages.map((msg) => ({
    ...msg,
    attachments: msg.attachments?.map((att) => {
      if (att.type === 'image' && att.base64) {
        const { base64: _removed, ...rest } = att
        return rest
      }
      return att
    }),
  }))
}

export class CloudStorageService {
  private async ensureAuthReady(): Promise<void> {
    if (
      !authTokenManager.isInitialized() &&
      typeof window !== 'undefined' &&
      localStorage.getItem(AUTH_ACTIVE_USER_ID) !== null
    ) {
      await authTokenManager.waitForInit(AUTH_INIT_WAIT_MS)
    }
  }

  async generateConversationId(timestamp?: string): Promise<{
    conversationId: string
    timestamp: string
    reverseTimestamp: number
  }> {
    const response = await fetch(`${API_BASE_URL}/api/chats/generate-id`, {
      method: 'POST',
      headers: await this.getHeaders(),
      body: JSON.stringify({ timestamp }),
    })

    if (!response.ok) {
      throw new Error(
        `Failed to generate conversation ID: ${response.statusText}`,
      )
    }

    return response.json()
  }

  private async getHeaders(): Promise<Record<string, string>> {
    await this.ensureAuthReady()
    return authTokenManager.getAuthHeaders()
  }

  async isAuthenticated(): Promise<boolean> {
    await this.ensureAuthReady()
    return authTokenManager.isAuthenticated()
  }

  async uploadChat(
    chat: StoredChat,
    options: UploadChatOptions = {},
  ): Promise<string | null> {
    // §9.6 R6 — the user's opt-out is invariant: a chat marked
    // localOnly MUST NEVER reach the enclave. Throw rather than
    // silently drop so an upstream caller bug is caught instead of
    // becoming a data-leak shaped like a successful upload.
    if (chat.isLocalOnly) {
      throw new Error(
        'cloud-storage: refusing to upload a local-only chat (§9.6 R6)',
      )
    }
    const messages: Message[] = (chat.messages as Message[]) || []

    await this.encryptAndUploadAttachments(messages, chat.id)
    const strippedChat = {
      ...chat,
      messages: stripBase64FromMessages(messages),
    }
    const plaintext = new TextEncoder().encode(JSON.stringify(strippedChat))

    const metadata: Record<string, unknown> = {
      messageCount: messages.length,
      // Always emit projectId so the enclave→controlplane path
      // mirrors what the local chat row says. A `null` clears the
      // server's project_id column; omitting the field would leave
      // a stale assignment behind on cross-project moves.
      projectId: chat.projectId ?? null,
    }
    if (options.restoreDeleted) {
      metadata.restoreDeleted = true
    }

    await enclavePush({
      scope: 'chat',
      id: chat.id,
      keyB64: requirePrimaryKeyB64(),
      plaintext,
      ifMatch: options.restoreDeleted ? null : String(chat.syncVersion ?? 0),
      idempotencyKey: options.idempotencyKey ?? newIdempotencyKey(),
      metadata,
    })

    return null
  }

  private async encryptAndUploadAttachments(
    messages: Message[],
    chatId: string,
  ): Promise<void> {
    for (const msg of messages) {
      for (const att of msg.attachments || []) {
        if (att.type === 'image' && att.base64) {
          const raw = base64ToUint8Array(att.base64)
          // The enclave mints both the durable attachment id and a
          // fresh per-attachment AES-256 key. It uploads the raw
          // plaintext to buckets sealed under that key (buckets's
          // v1 envelope), then returns the id + key here so we can
          // (a) adopt the enclave-minted id everywhere we used a
          // local temp id and (b) embed the key in the chat JSON
          // as `att.encryptionKey`. The chat envelope (sealed under
          // the user's CEK) is what keeps the per-attachment keys
          // confidential at rest; this is also how sharing keeps
          // working — re-sealing only the chat plaintext for a
          // recipient hands them every attachment key transitively.
          const { id: enclaveID, att_key } = await enclaveAttachmentPut({
            chatId,
            plaintext: raw,
          })
          att.id = enclaveID
          att.encryptionKey = att_key
        }
      }
    }
  }

  async bulkUploadChats(
    chats: Array<{
      id: string
      title: string
      messages: Array<unknown>
      createdAt: Date | string
      projectId?: string
      isLocalOnly?: boolean
    }>,
  ): Promise<BulkUploadResponse> {
    if (chats.length === 0) {
      return { results: [], succeeded: 0, failed: 0 }
    }

    if (chats.length > 100) {
      throw new Error('Maximum 100 chats per bulk upload request')
    }

    // Each row goes through the enclave push pipeline. There's no bulk
    // push on the enclave wire today, so we fan out single-row pushes
    // and aggregate results to keep the BulkUploadResponse contract
    // intact for callers (sign-in migration, bulk re-encrypt).
    // §9.6 R6 — local-only chats are silently filtered out of the
    // upload set instead of being attempted-and-failed. The caller
    // already chose not to sync them; reporting them as failures
    // would be misleading.
    const eligible = chats.filter((c) => !c.isLocalOnly)
    const results: BulkConversationResult[] = []
    let succeeded = 0
    let failed = 0
    for (const chat of eligible) {
      try {
        await this.uploadChat(chat as unknown as StoredChat)
        results.push({ conversationId: chat.id, success: true })
        succeeded += 1
      } catch (err) {
        results.push({
          conversationId: chat.id,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        })
        failed += 1
      }
    }
    return { results, succeeded, failed }
  }

  /**
   * Fetch raw encrypted content for a single chat by ID.
   * Returns v0 JSON string or v1 binary ArrayBuffer based on X-Format-Version header.
   */
  async fetchRawChatContent(chatId: string): Promise<RawChatContent | null> {
    const keys = pullKey()
    if (keys.length === 0) return null

    const resp = await enclavePull({
      scope: 'chat',
      ids: [chatId],
      keys,
    })
    const item = resp.items[0]
    if (!item || !item.ok) {
      if (item && item.code === 'NOT_FOUND') return null
      return null
    }
    const plaintext = pullItemPlaintext(item)
    if (!plaintext) return null
    return {
      plaintext: new TextDecoder().decode(plaintext),
      formatVersion: 2,
    }
  }

  async downloadChat(chatId: string): Promise<StoredChat | null> {
    try {
      const raw = await this.fetchRawChatContent(chatId)

      if (raw === null) {
        return null
      }

      const remote: RemoteChatData =
        raw.formatVersion === 2
          ? { id: chatId, plaintext: raw.plaintext, formatVersion: 2 }
          : raw.formatVersion === 1
            ? {
                id: chatId,
                binaryContent: raw.binaryContent,
                formatVersion: 1,
              }
            : { id: chatId, content: raw.content, formatVersion: 0 }

      const result = await processRemoteChat(remote)
      return result.chat
    } catch (error) {
      logError(`Failed to download chat ${chatId}`, error, {
        component: 'CloudStorage',
        action: 'downloadChat',
        metadata: { chatId },
      })
      return null
    }
  }

  /**
   * Fetch a single encrypted attachment blob by ID.
   */
  async fetchAttachment(attachmentId: string): Promise<ArrayBuffer | null> {
    const response = await fetch(
      `${API_BASE_URL}/api/storage/attachment/${attachmentId}`,
    )

    if (response.status === 404) {
      return null
    }

    if (!response.ok) {
      throw new Error(
        `Failed to fetch attachment ${attachmentId}: ${response.statusText}`,
      )
    }

    return response.arrayBuffer()
  }

  /**
   * Fetch and decrypt all image attachments that have no base64 yet.
   * Every attachment carries its own AES-256 key in
   * `att.encryptionKey`. We try the buckets-backed read first
   * (through the enclave); on 404 we fall back to the legacy
   * controlplane public BYTEA endpoint, which still holds bytes for
   * attachments that haven't been promoted yet. The same key
   * unlocks both — the rewrap path reuses the per-attachment key as
   * the buckets slot key when it promotes a legacy row.
   *
   * Returns a map of attachmentId -> base64 string so the caller
   * can merge results into the current (possibly updated) messages
   * without overwriting the entire array with a stale snapshot.
   */
  async loadChatImages(
    _chatId: string,
    messages: Message[],
  ): Promise<Record<string, string>> {
    const results: Record<string, string> = {}
    const tasks: Promise<void>[] = []

    for (const msg of messages) {
      for (const att of msg.attachments || []) {
        if (att.type !== 'image' || att.base64) {
          continue
        }
        const attId = att.id
        const keyB64 = att.encryptionKey
        if (!keyB64) {
          continue
        }
        tasks.push(
          (async () => {
            try {
              const plaintext = await enclaveAttachmentGet({
                id: attId,
                attKeyB64: keyB64,
              })
              results[attId] = uint8ArrayToBase64(plaintext)
              return
            } catch {
              // fall through to legacy path
            }
            try {
              const encryptedBuf = await this.fetchAttachment(attId)
              if (!encryptedBuf) return
              const keyBytes = base64ToUint8Array(keyB64)
              const decrypted = await decryptAttachment(
                new Uint8Array(encryptedBuf),
                keyBytes,
              )
              results[attId] = uint8ArrayToBase64(decrypted)
            } catch {
              // Silently skip failed attachments — thumbnail is still available
            }
          })(),
        )
      }
    }

    await Promise.all(tasks)
    return results
  }

  async listChats(options?: {
    limit?: number
    continuationToken?: string
    includeContent?: boolean
  }): Promise<ChatListResponse> {
    await this.ensureAuthReady()
    const limit = Math.min(options?.limit ?? ENCLAVE_CHAT_LIST_LIMIT, 500)
    const status = await enclaveListStatus({
      scope: 'chat',
      cursor: options?.continuationToken,
      limit,
    })
    const conversations = status.updates.map(chatUpdateToMeta)

    if (options?.includeContent && conversations.length > 0) {
      await this.attachInlineContent(conversations)
    }

    return {
      conversations,
      nextContinuationToken: status.next_cursor,
      hasMore: hasNextCursor(status.next_cursor),
    }
  }

  private async attachInlineContent(
    conversations: ChatListResponse['conversations'],
  ): Promise<void> {
    const keys = pullKey()
    if (keys.length === 0) return
    const pulled = await enclavePull({
      scope: 'chat',
      ids: conversations.map((c) => c.id),
      keys,
    })
    const plaintextById = new Map<string, string>()
    for (const item of pulled.items) {
      const plaintext = item.ok ? pullItemPlaintext(item) : null
      if (plaintext) {
        plaintextById.set(item.id, new TextDecoder().decode(plaintext))
      }
    }
    for (const conversation of conversations) {
      conversation.content = plaintextById.get(conversation.id)
    }
  }

  async deleteChat(chatId: string): Promise<void> {
    await enclaveDeleteRow({
      scope: 'chat',
      id: chatId,
      ifMatch: null,
      idempotencyKey: newIdempotencyKey(),
      keyB64: requirePrimaryKeyB64(),
    })
  }

  async deleteAllChats(): Promise<{
    deleted: number
    notificationSent?: boolean
  }> {
    let deleted = 0
    let cursor: string | undefined
    do {
      const status = await enclaveListStatus({
        scope: 'chat',
        cursor,
        limit: 500,
      })
      for (const update of status.updates) {
        await enclaveDeleteRow({
          scope: 'chat',
          id: update.id,
          ifMatch: update.etag,
          idempotencyKey: newIdempotencyKey(),
          keyB64: requirePrimaryKeyB64(),
        })
        deleted++
      }
      // Loop until the server stops advertising a next cursor — the
      // freshly-deleted rows fall out of the result set so each page
      // is fresh work, never a re-pass of what we just deleted.
      cursor = status.next_cursor
    } while (cursor)
    return { deleted }
  }

  async getChatSyncStatus(): Promise<ChatSyncStatus> {
    let count = 0
    let lastUpdated: string | null = null
    let cursor: string | undefined
    do {
      const status = await enclaveListStatus({
        scope: 'chat',
        cursor,
        limit: 500,
      })
      count += status.updates.length
      for (const update of status.updates) {
        if (!lastUpdated || update.updated_at > lastUpdated) {
          lastUpdated = update.updated_at
        }
      }
      cursor = status.next_cursor
    } while (cursor)
    return { count, lastUpdated }
  }

  async getProfileSyncStatus(): Promise<ProfileSyncStatus> {
    const response = await fetch(`${API_BASE_URL}/api/profile/sync-status`, {
      headers: await this.getHeaders(),
    })

    if (!response.ok) {
      throw new Error(
        `Failed to get profile sync status: ${response.statusText}`,
      )
    }

    return response.json()
  }

  /**
   * Intentionally a no-op. Project membership rides on the next
   * `uploadChat` (via `metadata.projectId`) and the controlplane
   * stamps the row's `project_id` column from there. Callers MUST
   * pair this with a `backupChat` so the change actually propagates.
   */
  async updateChatProject(
    _chatId: string,
    _projectId: string | null,
  ): Promise<void> {
    return
  }

  async getDeletedChatsSince(since: string): Promise<{ deletedIds: string[] }> {
    const deletedIds: string[] = []
    let cursor: string | undefined = since
    do {
      const status = await enclaveListStatus({
        scope: 'chat',
        cursor,
        limit: 500,
      })
      for (const d of status.deletes) deletedIds.push(d.id)
      cursor = status.next_cursor
    } while (cursor)
    return { deletedIds }
  }

  async getChatsUpdatedSince(options: {
    since: string
    includeContent?: boolean
    continuationToken?: string
  }): Promise<ChatListResponse> {
    const status = await enclaveListStatus({
      scope: 'chat',
      cursor: options.continuationToken ?? options.since,
      limit: ENCLAVE_CHAT_LIST_LIMIT,
    })
    const conversations = status.updates.map(chatUpdateToMeta)
    if (options.includeContent && conversations.length > 0) {
      await this.attachInlineContent(conversations)
    }
    return {
      conversations,
      nextContinuationToken: status.next_cursor,
      hasMore: hasNextCursor(status.next_cursor),
    }
  }

  async getAllChatsSyncStatus(): Promise<ChatSyncStatus> {
    return this.getChatSyncStatus()
  }

  async getAllChatsUpdatedSince(options: {
    since: string
    continuationToken?: string
  }): Promise<ChatListResponse> {
    return this.getChatsUpdatedSince({
      since: options.since,
      continuationToken: options.continuationToken,
      includeContent: true,
    })
  }
}

export const cloudStorage = new CloudStorageService()
