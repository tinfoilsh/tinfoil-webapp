/**
 * Chat Ingestion
 *
 * Shared helpers for processing batches of remote chats into local IndexedDB storage.
 * Extracts the repeated "check deleted -> decode -> save -> mark synced" loop that
 * appears in every sync method.
 */

import { logError } from '@/utils/error-handling'
import { chatEvents, type ChatChangeReason } from '../storage/chat-events'
import { indexedDBStorage, type ChatSyncMetadata } from '../storage/indexed-db'
import {
  processRemoteChat,
  type ProcessRemoteChatOptions,
  type RemoteChatData,
} from './chat-codec'
import { cloudStorage } from './cloud-storage'
import { reportChatSyncRecovered } from './sync-health'

export interface RemoteChatEntry {
  id: string
  content?: string | null
  createdAt?: string
  updatedAt?: string
  syncVersion?: number
  projectId?: string | null
}

export interface IngestOptions {
  /** Pre-built map of local chats by ID. If omitted, each chat is fetched individually. */
  localChatMap?: Map<string, ChatSyncMetadata>
  /** Project ID to associate with ingested chats */
  projectId?: string
  fetchMissingContent?: boolean
  setLoadedAt?: boolean
  eventReason?: ChatChangeReason
  forceOverwriteLocal?: boolean
  isCurrent?: () => boolean
  userId?: string
}

export interface IngestFailure {
  chatId: string
  error: unknown
  stage: 'decode' | 'storage'
}

export interface IngestResult {
  savedIds: string[]
  downloaded: number
  errors: IngestFailure[]
}

export async function ingestRemoteChats(
  remoteChats: RemoteChatEntry[],
  options: IngestOptions = {},
): Promise<IngestResult> {
  const {
    localChatMap,
    projectId,
    fetchMissingContent = false,
    setLoadedAt = false,
    eventReason = 'sync',
    forceOverwriteLocal = false,
    isCurrent = () => true,
    userId,
  } = options
  const result: IngestResult = { savedIds: [], downloaded: 0, errors: [] }

  for (const remoteChat of remoteChats) {
    if (!isCurrent()) break
    const localChat = localChatMap
      ? (localChatMap.get(remoteChat.id) ?? null)
      : await indexedDBStorage.getChat(remoteChat.id)
    let stage: IngestFailure['stage'] = 'decode'
    try {
      let fetchedProjectMetadata:
        { projectIdSet: boolean; projectId?: string | null } | undefined
      const codecInput: RemoteChatData = {
        id: remoteChat.id,
        createdAt: remoteChat.createdAt,
        updatedAt: remoteChat.updatedAt,
        formatVersion: 2,
        syncVersion: remoteChat.syncVersion,
      }
      if (remoteChat.content) {
        codecInput.plaintext = remoteChat.content
      } else if (fetchMissingContent) {
        const fetched = await cloudStorage.fetchRawChatContent(remoteChat.id)
        if (fetched) {
          codecInput.plaintext = fetched.plaintext
          codecInput.syncVersion = fetched.syncVersion
          fetchedProjectMetadata = fetched
        }
      }
      if (!codecInput.plaintext) continue

      const codecOptions: ProcessRemoteChatOptions = { localChat }
      if (remoteChat.projectId !== undefined) {
        codecOptions.projectId = remoteChat.projectId
      } else if (fetchedProjectMetadata?.projectIdSet) {
        codecOptions.projectId = fetchedProjectMetadata.projectId
      } else if (projectId) {
        codecOptions.projectId = projectId
      }
      const decoded = await processRemoteChat(codecInput, codecOptions)
      if (!isCurrent()) break
      stage = 'storage'
      const applied = await indexedDBStorage.applyRemoteChatIfFresh({
        chat: decoded.chat,
        syncVersion: decoded.chat.syncVersion ?? 0,
        expectedLocalUpdatedAt: forceOverwriteLocal
          ? undefined
          : (localChat?.updatedAt ?? null),
        setLoadedAt,
        isCurrent,
        userId,
      })
      if (applied.applied) {
        result.savedIds.push(decoded.chat.id)
        result.downloaded++
        reportChatSyncRecovered(decoded.chat.id)
      }
    } catch (error) {
      logError('Failed to ingest remote chat', error, {
        component: 'ChatIngestion',
        action: 'ingestRemoteChats',
        metadata: { chatId: remoteChat.id },
      })
      result.errors.push({ chatId: remoteChat.id, error, stage })
    }
  }

  if (result.savedIds.length > 0 && isCurrent()) {
    chatEvents.emit({ reason: eventReason, ids: result.savedIds })
  }
  return result
}
