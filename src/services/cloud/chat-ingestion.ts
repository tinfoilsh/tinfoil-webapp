/**
 * Chat Ingestion
 *
 * Shared helpers for processing batches of remote chats into local IndexedDB storage.
 * Extracts the repeated "check deleted -> decode -> save -> mark synced" loop that
 * appears in every sync method.
 */

import { base64ToUint8Array } from '@/utils/binary-codec'
import { logError } from '@/utils/error-handling'
import { chatEvents, type ChatChangeReason } from '../storage/chat-events'
import { deletedChatsTracker } from '../storage/deleted-chats-tracker'
import { indexedDBStorage, type StoredChat } from '../storage/indexed-db'
import {
  processRemoteChat,
  type ProcessRemoteChatOptions,
  type RemoteChatData,
} from './chat-codec'
import { cloudStorage } from './cloud-storage'
import { shouldIngestRemoteChat } from './sync-predicates'

/**
 * A remote chat from any API response that carries at least an id and timestamps.
 * The `content` field may be absent if the listing didn't include inline content.
 */
export interface RemoteChatEntry {
  id: string
  content?: string | null
  createdAt: string
  updatedAt?: string
  formatVersion?: number
}

export interface IngestOptions {
  /** Pre-built map of local chats by ID. If omitted, each chat is fetched individually. */
  localChatMap?: Map<string, StoredChat>
  /** Project ID to associate with ingested chats */
  projectId?: string
  /** When true, call shouldIngestRemoteChat to skip chats that are already up-to-date locally */
  checkShouldIngest?: boolean
  /** When true, skip chats that appear in the deleted-chats tracker */
  skipDeleted?: boolean
  /** When true, fetch raw content from the server for chats without inline content */
  fetchMissingContent?: boolean
  /** When true, stamp chat.loadedAt = Date.now() (used by pagination) */
  setLoadedAt?: boolean
  /** Event reason emitted via chatEvents when chats are saved */
  eventReason?: ChatChangeReason
}

export interface IngestResult {
  savedIds: string[]
  downloaded: number
  errors: string[]
  /** IDs of chats that were decrypted with a fallback key and should be re-encrypted with the current key */
  needsReencryption: string[]
}

/**
 * Process a batch of remote chats: decode, save to IndexedDB, and mark as synced.
 *
 * This is the shared core of every sync method's "download loop". Variations are
 * controlled via IngestOptions.
 */
export async function ingestRemoteChats(
  remoteChats: RemoteChatEntry[],
  options: IngestOptions = {},
): Promise<IngestResult> {
  const {
    localChatMap,
    projectId,
    checkShouldIngest = false,
    skipDeleted = true,
    fetchMissingContent = false,
    setLoadedAt = false,
    eventReason = 'sync',
  } = options

  const result: IngestResult = {
    savedIds: [],
    downloaded: 0,
    errors: [],
    needsReencryption: [],
  }

  for (const remoteChat of remoteChats) {
    // Skip recently deleted chats
    if (skipDeleted && deletedChatsTracker.isDeleted(remoteChat.id)) {
      continue
    }

    // Optionally check if we should ingest (skip if local copy is already up-to-date)
    const localChat = localChatMap
      ? (localChatMap.get(remoteChat.id) ?? null)
      : await indexedDBStorage.getChat(remoteChat.id)

    if (checkShouldIngest && !shouldIngestRemoteChat(remoteChat, localChat)) {
      continue
    }

    try {
      // Resolve content: use inline if present, otherwise optionally fetch
      let codecInput: RemoteChatData = {
        id: remoteChat.id,
        createdAt: remoteChat.createdAt,
        updatedAt: remoteChat.updatedAt,
        formatVersion: remoteChat.formatVersion,
      }

      if (remoteChat.content) {
        if (remoteChat.formatVersion === 1) {
          // Inline v1 content is base64-encoded binary from the list endpoint
          const bytes = base64ToUint8Array(remoteChat.content)
          codecInput.binaryContent = bytes.buffer as ArrayBuffer
          codecInput.formatVersion = 1
        } else {
          codecInput.content = remoteChat.content
        }
      } else if (fetchMissingContent) {
        const fetched = await cloudStorage.fetchRawChatContent(remoteChat.id)
        if (fetched) {
          if (fetched.formatVersion === 1) {
            codecInput.binaryContent = fetched.binaryContent
            codecInput.formatVersion = 1
          } else {
            codecInput.content = fetched.content
            codecInput.formatVersion = 0
          }
        }
      }

      // Skip if no content available (either not requested or fetch returned nothing)
      if (!codecInput.content && !codecInput.binaryContent) {
        continue
      }

      const codecOptions: ProcessRemoteChatOptions = { localChat }
      if (projectId) {
        codecOptions.projectId = projectId
      }

      const codecResult = await processRemoteChat(codecInput, codecOptions)
      const chat = codecResult.chat

      if (chat) {
        if (setLoadedAt) {
          chat.loadedAt = Date.now()
        }

        await indexedDBStorage.saveChat(chat)
        await indexedDBStorage.markAsSynced(chat.id, chat.syncVersion ?? 0)
        result.savedIds.push(chat.id)
        result.downloaded++

        if (codecResult.needsReencryption) {
          result.needsReencryption.push(chat.id)
        }
      }
    } catch (error) {
      result.errors.push(
        `Failed to process chat ${remoteChat.id}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  if (result.savedIds.length > 0) {
    chatEvents.emit({ reason: eventReason, ids: result.savedIds })
  }

  return result
}

/**
 * Delete local chats that were deleted remotely since the given timestamp.
 * Emits a chat event if any chats were deleted.
 */
export async function syncRemoteDeletions(
  since: string,
  logAction: string,
): Promise<void> {
  try {
    const { deletedIds } = await cloudStorage.getDeletedChatsSince(since)
    const successfulIds: string[] = []
    for (const id of deletedIds) {
      try {
        deletedChatsTracker.markAsDeleted(id)
        await indexedDBStorage.deleteChat(id)
        successfulIds.push(id)
      } catch (error) {
        logError(
          `Failed to delete chat ${id} during remote deletion sync`,
          error,
          {
            component: 'CloudSync',
            action: logAction,
          },
        )
      }
    }
    if (successfulIds.length > 0) {
      chatEvents.emit({ reason: 'sync', ids: successfulIds })
    }
  } catch (error) {
    logError('Failed to check for remotely deleted chats', error, {
      component: 'CloudSync',
      action: logAction,
    })
  }
}
