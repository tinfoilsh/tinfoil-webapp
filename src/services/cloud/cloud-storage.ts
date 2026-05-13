import type { Message } from '@/components/chat/types'
import { AUTH_ACTIVE_USER_ID } from '@/constants/storage-keys'
import {
  base64ToUint8Array,
  decryptAttachment,
  encryptAttachment,
  uint8ArrayToBase64,
} from '@/utils/binary-codec'
import { logError } from '@/utils/error-handling'
import { authTokenManager } from '../auth'
import { encryptionService } from '../encryption/encryption-service'
import { type StoredChat } from '../storage/indexed-db'
import {
  pull as enclavePull,
  push as enclavePush,
  hexToB64,
  newIdempotencyKey,
  pullItemPlaintext,
  type PullKey,
} from '../sync-enclave/sync-api'
import { processRemoteChat, type RemoteChatData } from './chat-codec'

/**
 * Build the `keys` array the enclave `pull` endpoint accepts: the
 * primary CEK first, then any fallback (recovery) keys the local
 * service has accumulated. The enclave tries each in order; the first
 * that unseals wins.
 */
function pullKeysFromEncryptionService(): PullKey[] {
  const all = encryptionService.getAllKeys()
  const out: PullKey[] = []
  if (all.primary) out.push({ key: hexToB64(all.primary) })
  for (const alt of all.alternatives) {
    if (alt !== all.primary) out.push({ key: hexToB64(alt) })
  }
  return out
}

function requirePrimaryKeyB64(): string {
  const key = encryptionService.getKey()
  if (!key) {
    throw new Error('cloud-storage: no encryption key available')
  }
  return hexToB64(key)
}

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL || 'https://api.tinfoil.sh'
const AUTH_INIT_WAIT_MS = 3000
const RESTORE_DELETED_CHAT_HEADER = 'X-Restore-Deleted-Chat'

export interface ChatListResponse {
  conversations: Array<{
    id: string
    key: string
    createdAt: string
    updatedAt: string
    title: string
    messageCount: number
    syncVersion: number
    size: number
    formatVersion: number
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
    const messages: Message[] = (chat.messages as Message[]) || []

    await this.encryptAndUploadAttachments(messages, chat.id)
    const strippedChat = {
      ...chat,
      messages: stripBase64FromMessages(messages),
    }
    const plaintext = new TextEncoder().encode(JSON.stringify(strippedChat))

    const metadata: Record<string, unknown> = {
      messageCount: messages.length,
    }
    if (chat.projectId) {
      metadata.projectId = chat.projectId
    }
    if (options.restoreDeleted) {
      metadata.restoreDeleted = true
    }

    await enclavePush({
      scope: 'chat',
      id: chat.id,
      keyB64: requirePrimaryKeyB64(),
      plaintext,
      ifMatch: null,
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
          const { encryptedData, key } = await encryptAttachment(raw)
          await this.uploadAttachment(att.id, chatId, encryptedData)

          att.encryptionKey = uint8ArrayToBase64(key)
        }
      }
    }
  }

  private async uploadAttachment(
    attachmentId: string,
    chatId: string,
    encryptedData: Uint8Array,
  ): Promise<void> {
    const response = await fetch(
      `${API_BASE_URL}/api/storage/attachment/${attachmentId}`,
      {
        method: 'PUT',
        headers: {
          ...(await this.getHeaders()),
          'Content-Type': 'application/octet-stream',
          'X-Chat-Id': chatId,
        },
        body: encryptedData as unknown as BodyInit,
      },
    )

    if (!response.ok) {
      throw new Error(
        `Failed to upload attachment ${attachmentId}: ${response.statusText}`,
      )
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
    const results: BulkConversationResult[] = []
    let succeeded = 0
    let failed = 0
    for (const chat of chats) {
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
    const keys = pullKeysFromEncryptionService()
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
   * Fetch and decrypt all image attachments that have an encryption key but
   * no base64 yet. Returns a map of attachmentId -> base64 string so the
   * caller can merge results into the current (possibly updated) messages
   * without overwriting the entire array with a stale snapshot.
   */
  async loadChatImages(messages: Message[]): Promise<Record<string, string>> {
    const results: Record<string, string> = {}
    const tasks: Promise<void>[] = []

    for (const msg of messages) {
      for (const att of msg.attachments || []) {
        if (att.type !== 'image' || !att.encryptionKey || att.base64) {
          continue
        }

        const attId = att.id
        const keyB64 = att.encryptionKey

        tasks.push(
          (async () => {
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
    const params = new URLSearchParams()
    if (options?.limit) {
      params.append('limit', options.limit.toString())
    }
    if (options?.continuationToken) {
      params.append('continuationToken', options.continuationToken)
    }
    if (options?.includeContent) {
      params.append('includeContent', 'true')
    }

    // Add cache-busting parameter to avoid stale CDN/browser cache
    params.append('_t', Date.now().toString())

    const url = `${API_BASE_URL}/api/chats/list${params.toString() ? `?${params.toString()}` : ''}`
    const response = await fetch(url, {
      headers: await this.getHeaders(),
      cache: 'no-store',
    })

    if (!response.ok) {
      throw new Error(`Failed to list chats: ${response.statusText}`)
    }

    return response.json()
  }

  async updateMetadata(
    chatId: string,
    metadata: Record<string, string>,
  ): Promise<void> {
    const response = await fetch(`${API_BASE_URL}/api/storage/metadata`, {
      method: 'POST',
      headers: await this.getHeaders(),
      body: JSON.stringify({
        conversationId: chatId,
        metadata,
      }),
    })

    if (!response.ok) {
      throw new Error(`Failed to update metadata: ${response.statusText}`)
    }
  }

  async deleteChat(chatId: string): Promise<void> {
    const response = await fetch(
      `${API_BASE_URL}/api/storage/conversation/${chatId}`,
      {
        method: 'DELETE',
        headers: await this.getHeaders(),
      },
    )

    if (!response.ok && response.status !== 404) {
      throw new Error(`Failed to delete chat: ${response.statusText}`)
    }
  }

  async deleteAllChats(): Promise<{ deleted: number }> {
    const response = await fetch(`${API_BASE_URL}/api/storage/conversations`, {
      method: 'DELETE',
      headers: await this.getHeaders(),
    })

    if (!response.ok) {
      throw new Error(`Failed to delete all chats: ${response.statusText}`)
    }

    return response.json()
  }

  async getChatSyncStatus(): Promise<ChatSyncStatus> {
    // Add cache-busting parameter to avoid stale CDN/browser cache
    const url = `${API_BASE_URL}/api/chats/sync-status?_t=${Date.now()}`
    const response = await fetch(url, {
      headers: await this.getHeaders(),
      cache: 'no-store',
    })

    if (!response.ok) {
      throw new Error(`Failed to get chat sync status: ${response.statusText}`)
    }

    return response.json()
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

  async updateChatProject(
    chatId: string,
    projectId: string | null,
  ): Promise<void> {
    const response = await fetch(
      `${API_BASE_URL}/api/storage/conversation/${chatId}/project`,
      {
        method: 'PATCH',
        headers: await this.getHeaders(),
        body: JSON.stringify({ projectId }),
      },
    )

    if (!response.ok) {
      throw new Error(`Failed to update chat project: ${response.statusText}`)
    }
  }

  async getDeletedChatsSince(since: string): Promise<{ deletedIds: string[] }> {
    const params = new URLSearchParams()
    params.append('since', since)
    params.append('_t', Date.now().toString())

    const url = `${API_BASE_URL}/api/chats/deleted-since?${params.toString()}`
    const response = await fetch(url, {
      headers: await this.getHeaders(),
      cache: 'no-store',
    })

    if (!response.ok) {
      throw new Error(
        `Failed to get deleted chats since: ${response.statusText}`,
      )
    }

    return response.json()
  }

  async getChatsUpdatedSince(options: {
    since: string
    includeContent?: boolean
    continuationToken?: string
  }): Promise<ChatListResponse> {
    const params = new URLSearchParams()
    params.append('since', options.since)
    if (options.includeContent) {
      params.append('includeContent', 'true')
    }
    if (options.continuationToken) {
      params.append('continuationToken', options.continuationToken)
    }
    // Add cache-busting parameter to avoid stale CDN/browser cache
    params.append('_t', Date.now().toString())

    const url = `${API_BASE_URL}/api/chats/updated-since?${params.toString()}`
    const response = await fetch(url, {
      headers: await this.getHeaders(),
      cache: 'no-store',
    })

    if (!response.ok) {
      throw new Error(
        `Failed to get chats updated since: ${response.statusText}`,
      )
    }

    return response.json()
  }

  async getAllChatsSyncStatus(): Promise<ChatSyncStatus> {
    const url = `${API_BASE_URL}/api/chats/all-sync-status?_t=${Date.now()}`
    const response = await fetch(url, {
      headers: await this.getHeaders(),
      cache: 'no-store',
    })

    if (!response.ok) {
      throw new Error(
        `Failed to get all chats sync status: ${response.statusText}`,
      )
    }

    return response.json()
  }

  async getAllChatsUpdatedSince(options: {
    since: string
    continuationToken?: string
  }): Promise<ChatListResponse> {
    const params = new URLSearchParams()
    params.append('since', options.since)
    if (options.continuationToken) {
      params.append('continuationToken', options.continuationToken)
    }
    params.append('_t', Date.now().toString())

    const url = `${API_BASE_URL}/api/chats/all-updated-since?${params.toString()}`
    const response = await fetch(url, {
      headers: await this.getHeaders(),
      cache: 'no-store',
    })

    if (!response.ok) {
      throw new Error(
        `Failed to get all chats updated since: ${response.statusText}`,
      )
    }

    return response.json()
  }
}

export const cloudStorage = new CloudStorageService()
