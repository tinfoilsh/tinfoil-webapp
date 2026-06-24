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
import { observe } from './edit-clock'
import { RemoteChatPlaintextSchema } from './schemas'

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
    throw new Error(
      `v2_plaintext_invalid: ${
        parseErr instanceof Error ? parseErr.message : String(parseErr)
      }`,
    )
  }

  const validation = RemoteChatPlaintextSchema.safeParse(parsed)
  if (!validation.success) {
    throw new Error(`v2_plaintext_invalid: ${validation.error.message}`)
  }
  const decrypted = validation.data

  // Advance the local logical clock past any remote edit clock so a
  // later local edit is guaranteed to outrank what we just observed.
  observe(typeof decrypted.clock === 'number' ? decrypted.clock : null)

  const chat: StoredChat = {
    ...decrypted,
    title: decrypted.title ?? 'Untitled',
    // MessageSchema validates the fields the app depends on and
    // passes the rest through, so the runtime shape is a Message.
    messages: decrypted.messages as StoredChat['messages'],
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
