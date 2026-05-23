/**
 * Chat Codec
 *
 * Unified pipeline for processing remote chats - decryption and placeholder creation.
 * This module centralizes the decryption logic that was previously duplicated across
 * multiple sync methods.
 */

import { ensureValidISODate } from '@/utils/chat-timestamps'
import { logInfo } from '@/utils/error-handling'
import { encryptionService } from '../encryption/encryption-service'
import type { StoredChat } from '../storage/indexed-db'

/**
 * Remote chat data from the API
 */
export interface RemoteChatData {
  id: string
  content?: string | null
  /** v1 binary content (gzip+AES-GCM encrypted). Mutually exclusive with content. */
  binaryContent?: ArrayBuffer | null
  /**
   * Plaintext JSON returned by the sync enclave after server-side
   * unsealing. When set, `processRemoteChat` decodes it directly and
   * does NOT invoke the legacy `encryptionService.decrypt*` path.
   */
  plaintext?: string | null
  createdAt?: string
  updatedAt?: string | null
  formatVersion?: number
  syncVersion?: number
  projectId?: string
}

/**
 * Result of processing a remote chat
 */
export interface ProcessedChatResult {
  /** The processed chat (decrypted or placeholder) */
  chat: StoredChat
  /** Processing status */
  status: 'decrypted' | 'decryption_failed' | 'corrupted' | 'no_content'
  /** Original encrypted data (only if decryption failed) */
  encryptedData?: string
  /** True when decryption succeeded using a fallback key (chat should be re-encrypted with current key) */
  needsReencryption?: boolean
}

/**
 * Options for processing a remote chat
 */
export interface ProcessRemoteChatOptions {
  /** Existing local chat (if any) - used to preserve project association */
  localChat?: StoredChat | null
  /** Project ID to associate with the chat */
  projectId?: string
}

/**
 * Process a remote chat - decrypt content or create a placeholder.
 *
 * This is the single pipeline for handling remote chat data:
 * 1. If content is present, attempt decryption
 * 2. If decryption succeeds, return decrypted chat
 * 3. If decryption fails, create a placeholder with encrypted data stored
 * 4. If no content, return a placeholder
 *
 * @param remote The remote chat data from the API
 * @param options Processing options
 * @returns Processed chat result
 */
export async function processRemoteChat(
  remote: RemoteChatData,
  options: ProcessRemoteChatOptions = {},
): Promise<ProcessedChatResult> {
  const { localChat, projectId } = options

  // Determine project ID - prefer explicit, then local chat's
  const effectiveProjectId = projectId ?? localChat?.projectId

  // Safe timestamps with fallbacks
  const safeCreatedAt = ensureValidISODate(remote.createdAt, remote.id)
  const safeUpdatedAt = ensureValidISODate(
    remote.updatedAt ?? remote.createdAt,
    remote.id,
  )

  // If no content at all, return a placeholder. V2 rows must always
  // go through the plaintext parser below so malformed enclave output
  // surfaces as an error instead of an encrypted placeholder.
  if (
    remote.formatVersion !== 2 &&
    !remote.content &&
    !remote.binaryContent &&
    !remote.plaintext
  ) {
    logInfo('Remote chat has no content', {
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
        status: 'no_content',
      }),
      status: 'no_content',
    }
  }

  // Try to decrypt the content — route by format version
  try {
    let decrypted: any
    let usedFallbackKey = false

    if (remote.formatVersion === 2) {
      // Enclave already unsealed the row server-side. The plaintext is
      // the JSON-serialized StoredChat shape uploadChat() persisted.
      // §9.6 R5: the v2 path must NOT fall through to the legacy
      // placeholder branch on JSON.parse failure — malformed plaintext
      // here is a server bug, not a "wrong key" outcome. Re-throw a
      // typed error tagged with `v2_plaintext_invalid` so callers can
      // route it through `decideRecovery` and surface it appropriately,
      // instead of polluting the chat list with an `Encrypted`
      // placeholder.
      try {
        decrypted = JSON.parse(remote.plaintext ?? '')
      } catch (parseErr) {
        throw new Error(
          `v2_plaintext_invalid: ${
            parseErr instanceof Error ? parseErr.message : String(parseErr)
          }`,
        )
      }
    } else if (remote.formatVersion === 1 && remote.binaryContent) {
      const info = await encryptionService.decryptV1WithFallbackInfo(
        new Uint8Array(remote.binaryContent),
      )
      decrypted = info.data
      usedFallbackKey = info.usedFallbackKey
    } else if (remote.content) {
      const encrypted = JSON.parse(remote.content)
      const info = await encryptionService.decryptWithFallbackInfo(encrypted)
      decrypted = info.data
      usedFallbackKey = info.usedFallbackKey
    } else {
      throw new Error('No content available for decryption')
    }

    // Ensure timestamps are valid
    const chat: StoredChat = {
      ...decrypted,
      id: remote.id, // Always use the remote ID
      createdAt: ensureValidISODate(
        decrypted.createdAt ?? remote.createdAt,
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
      formatVersion: remote.formatVersion ?? 0,
      // Explicit projectId from caller is authoritative (e.g. cross-scope sync);
      // fall back to the blob's value, then the local chat's value
      projectId: projectId ?? decrypted.projectId ?? localChat?.projectId,
    }

    return {
      chat,
      status: 'decrypted',
      needsReencryption: usedFallbackKey,
    }
  } catch (decryptError) {
    // §9.6 R5: the v2 enclave path does not generate placeholders. A
    // failure here is the enclave returning bytes that aren't valid
    // JSON, which is a server-side bug — surface it to the caller
    // through the normal recovery path instead of pretending it is a
    // legacy "wrong key" decryption failure.
    if (remote.formatVersion === 2) {
      throw decryptError
    }

    // Determine if this is data corruption vs wrong key
    const isCorrupted =
      decryptError instanceof Error &&
      decryptError.message.includes('DATA_CORRUPTED')

    const status = isCorrupted ? 'corrupted' : 'decryption_failed'

    logInfo(`Failed to decrypt chat: ${status}`, {
      component: 'ChatCodec',
      action: 'processRemoteChat',
      metadata: {
        chatId: remote.id,
        isCorrupted,
        error:
          decryptError instanceof Error
            ? decryptError.message
            : 'Unknown error',
      },
    })

    // Preserve encrypted payload for later recovery (e.g., after key rotation).
    // v0: store the JSON string directly. v1: base64-encode the binary.
    let preservedData: string | undefined
    if (remote.content) {
      preservedData = remote.content
    } else if (remote.binaryContent) {
      const bytes = new Uint8Array(remote.binaryContent)
      const CHUNK = 0x8000
      const chunks: string[] = []
      for (let i = 0; i < bytes.length; i += CHUNK) {
        chunks.push(
          String.fromCharCode.apply(
            null,
            Array.from(bytes.subarray(i, i + CHUNK)),
          ),
        )
      }
      preservedData = btoa(chunks.join(''))
    }

    return {
      chat: createPlaceholderChat({
        id: remote.id,
        createdAt: safeCreatedAt,
        updatedAt: safeUpdatedAt,
        projectId: effectiveProjectId,
        status,
        encryptedData: preservedData,
        formatVersion: remote.formatVersion ?? 0,
        dataCorrupted: isCorrupted,
      }),
      status,
      encryptedData: preservedData,
    }
  }
}

/**
 * Options for creating a placeholder chat
 */
interface PlaceholderOptions {
  id: string
  createdAt: string
  updatedAt: string
  projectId?: string
  status: 'decryption_failed' | 'corrupted' | 'no_content'
  encryptedData?: string
  formatVersion?: number
  dataCorrupted?: boolean
}

/**
 * Create a placeholder chat for failed decryption or missing content.
 */
function createPlaceholderChat(options: PlaceholderOptions): StoredChat {
  const {
    id,
    createdAt,
    updatedAt,
    projectId,
    status,
    encryptedData,
    formatVersion,
    dataCorrupted,
  } = options

  return {
    id,
    title: 'Encrypted',
    messages: [],
    createdAt,
    updatedAt,
    lastAccessedAt: Date.now(),
    decryptionFailed: status !== 'no_content',
    dataCorrupted: dataCorrupted ?? false,
    encryptedData,
    formatVersion: formatVersion ?? 0,
    syncedAt: Date.now(),
    locallyModified: false,
    syncVersion: 1,
    projectId,
  } as StoredChat
}

/**
 * Process multiple remote chats in sequence.
 *
 * @param remoteChats Array of remote chats to process
 * @param localChatMap Map of local chats by ID
 * @returns Array of processed chat results
 */
export async function processRemoteChats(
  remoteChats: RemoteChatData[],
  localChatMap: Map<string, StoredChat>,
): Promise<ProcessedChatResult[]> {
  const results: ProcessedChatResult[] = []

  for (const remote of remoteChats) {
    const localChat = localChatMap.get(remote.id)
    const result = await processRemoteChat(remote, { localChat })
    results.push(result)
  }

  return results
}
