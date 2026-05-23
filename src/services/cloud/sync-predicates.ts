/**
 * Sync Predicates
 *
 * Single source of truth for sync eligibility decisions.
 * These predicates centralize the logic for determining which chats
 * can be uploaded, downloaded, or retried for decryption.
 */

import type { StoredChat } from '@/services/storage/indexed-db'

/**
 * Determines if a chat is eligible for upload to the cloud.
 *
 * A chat is NOT uploadable if any of these conditions are true:
 * - isLocalOnly === true (user explicitly chose local storage)
 * - isBlankChat === true (empty placeholder chat)
 * - decryptionFailed === true (would overwrite server data with placeholder)
 * - currently streaming (incomplete data)
 *
 * @param chat The chat to check
 * @param isStreaming Optional function to check if chat is streaming
 * @returns true if the chat can be uploaded
 */
export function isUploadableChat(
  chat: StoredChat,
  isStreaming?: (chatId: string) => boolean,
): boolean {
  if (chat.isLocalOnly === true) {
    return false
  }

  if (chat.isBlankChat === true) {
    return false
  }

  if (chat.decryptionFailed === true) {
    return false
  }

  if (isStreaming && isStreaming(chat.id)) {
    return false
  }

  return true
}

/**
 * Determines if a remote chat should be downloaded and stored locally.
 *
 * A remote chat should be ingested if:
 * - No local version exists
 * - Local version failed decryption (retry with potentially new key)
 * - Remote version is newer than local version AND local has no unsynced modifications
 *
 * @param remote The remote chat metadata
 * @param local The local chat (if exists)
 * @returns true if the remote chat should be downloaded
 */
export function shouldIngestRemoteChat(
  remote: { id: string; updatedAt?: string | null },
  local: StoredChat | null | undefined,
): boolean {
  // If no local chat exists, always ingest
  if (!local) {
    return true
  }

  // If local chat failed decryption, retry with remote data
  // (the enclave may now serve a freshly-rewrapped row).
  if (local.decryptionFailed) {
    return true
  }

  // Don't overwrite local changes that haven't been uploaded yet
  if (local.locallyModified) {
    return false
  }

  // Compare timestamps - ingest if remote is newer
  if (remote.updatedAt) {
    const remoteTimestamp = new Date(remote.updatedAt).getTime()
    const localTimestamp = local.syncedAt || 0

    if (!isNaN(remoteTimestamp) && remoteTimestamp > localTimestamp) {
      return true
    }
  }

  return false
}
