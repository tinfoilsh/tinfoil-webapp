/**
 * Chat Codec
 *
 * Decode chats returned by the sync enclave. The enclave unseals
 * server-side and hands us plaintext JSON, so this module only
 * understands the v2 plaintext shape — legacy v0/v1 client-side
 * decrypt has been removed.
 */

import { ensureValidISODate } from '@/utils/chat-timestamps'
import { logInfo } from '@/utils/error-handling'
import type { StoredChat } from '../storage/indexed-db'

export interface RemoteChatData {
  id: string
  /**
   * Plaintext JSON returned by the sync enclave after server-side
   * unsealing. v2 is the only format the codec accepts.
   */
  plaintext?: string | null
  createdAt?: string
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
  localChat?: StoredChat | null
  projectId?: string
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
  const effectiveProjectId = projectId ?? localChat?.projectId

  const safeCreatedAt = ensureValidISODate(remote.createdAt, remote.id)
  const safeUpdatedAt = ensureValidISODate(
    remote.updatedAt ?? remote.createdAt,
    remote.id,
  )

  if (!remote.plaintext) {
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

  let decrypted: any
  try {
    decrypted = JSON.parse(remote.plaintext)
  } catch (parseErr) {
    throw new Error(
      `v2_plaintext_invalid: ${
        parseErr instanceof Error ? parseErr.message : String(parseErr)
      }`,
    )
  }

  const chat: StoredChat = {
    ...decrypted,
    id: remote.id,
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
    formatVersion: 2,
    projectId: projectId ?? decrypted.projectId ?? localChat?.projectId,
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
