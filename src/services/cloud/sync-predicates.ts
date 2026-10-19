/**
 * Sync Predicates
 *
 * Single source of truth for sync eligibility decisions.
 * These predicates centralize the logic for determining which chats
 * can be uploaded, downloaded, or retried for decryption.
 */

import type {
  ChatSyncMetadata,
  StoredChat,
} from '@/services/storage/indexed-db'
import type { EditClock } from './edit-clock'

export function trustedChatClock(
  chat:
    | Pick<StoredChat, 'clock' | 'writer' | 'clockVersion' | 'syncVersion'>
    | null
    | undefined,
): EditClock | undefined {
  if (
    !chat ||
    typeof chat.clock !== 'number' ||
    !Number.isSafeInteger(chat.clock) ||
    chat.clock <= 0 ||
    typeof chat.writer !== 'string' ||
    chat.writer.trim().length === 0 ||
    typeof chat.clockVersion !== 'number' ||
    !Number.isSafeInteger(chat.clockVersion) ||
    chat.clockVersion <= 0 ||
    chat.clockVersion !== (chat.syncVersion ?? -1)
  ) {
    return undefined
  }
  return { v: chat.clock, w: chat.writer }
}

/**
 * Determines if a chat is eligible for upload to the cloud.
 *
 * A chat is NOT uploadable if any of these conditions are true:
 * - isLocalOnly === true (user explicitly chose local storage)
 * - isBlankChat === true (empty placeholder chat)
 * - decryptionFailed === true (would overwrite server data with placeholder)
 * - no messages (malformed or stale persisted chat, not an intentional blank)
 * - currently streaming (incomplete data)
 *
 * @param chat The chat to check
 * @param isStreaming Optional function to check if chat is streaming
 * @returns true if the chat can be uploaded
 */
export function isUploadableChat(
  chat:
    | Pick<
        ChatSyncMetadata,
        | 'id'
        | 'messageCount'
        | 'isLocalOnly'
        | 'isBlankChat'
        | 'decryptionFailed'
        | 'dataCorrupted'
        | 'isMetadataOnly'
      >
    | Pick<
        StoredChat,
        | 'id'
        | 'messages'
        | 'isLocalOnly'
        | 'isBlankChat'
        | 'decryptionFailed'
        | 'dataCorrupted'
        | 'isMetadataOnly'
      >,
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

  if (chat.isMetadataOnly === true) {
    return false
  }

  const messageCount =
    'messages' in chat ? chat.messages.length : chat.messageCount
  if (chat.dataCorrupted === true || messageCount === 0) {
    return false
  }

  if (isStreaming && isStreaming(chat.id)) {
    return false
  }

  return true
}

/**
 * Last-write-wins arbitration by content modification time, shared by
 * every scope's conflict resolution (chats, profile) so the winner is
 * the same on every device.
 *
 * Returns true when the remote copy is the last write and should
 * overwrite local; false when the local copy is at least as fresh and
 * must be preserved (re-uploaded).
 *
 * A missing or unparseable local timestamp means we cannot prove local
 * is fresher, so remote wins. A missing or unparseable remote timestamp
 * lets local win, since we have a concrete local edit time to trust.
 *
 * @param localUpdatedAt The local copy's content modification time
 * @param remoteUpdatedAt The remote copy's content modification time
 * @returns true if the remote copy should overwrite local
 */
export function remoteWinsLastWrite(
  localUpdatedAt?: string | null,
  remoteUpdatedAt?: string | null,
): boolean {
  const localTime = localUpdatedAt
    ? new Date(localUpdatedAt).getTime()
    : Number.NaN
  if (Number.isNaN(localTime)) {
    return true
  }

  const remoteTime = remoteUpdatedAt
    ? new Date(remoteUpdatedAt).getTime()
    : Number.NaN
  return !Number.isNaN(remoteTime) && remoteTime > localTime
}

/**
 * Unified conflict arbitration for every sync scope (chat rows,
 * profile fields). When both sides carry a trusted edit clock the
 * winner is the higher `(v, w)` pair — a total order that makes the
 * merge a convergent CRDT LWW-register and removes wall-clock skew
 * from the decision. When either clock is absent (legacy rows, or a
 * write by a client that predates clocks) it falls back to the
 * timestamp arbitration so behavior matches the pre-clock client.
 *
 * Callers MUST pass clocks only when both are trusted (the row's
 * server etag equals the `clockVersion` stamped in the blob);
 * otherwise pass `undefined` so the timestamp fallback governs.
 *
 * Returns true when the remote copy should overwrite local.
 */
export function remoteWins(args: {
  localClock?: EditClock | null
  remoteClock?: EditClock | null
  localUpdatedAt?: string | null
  remoteUpdatedAt?: string | null
}): boolean {
  const { localClock, remoteClock, localUpdatedAt, remoteUpdatedAt } = args
  if (localClock && remoteClock) {
    if (remoteClock.v !== localClock.v) {
      return remoteClock.v > localClock.v
    }
    if (remoteClock.w !== localClock.w) {
      return remoteClock.w > localClock.w
    }
    // Identical clock: the same logical write. No overwrite.
    return false
  }
  return remoteWinsLastWrite(localUpdatedAt, remoteUpdatedAt)
}
