import { streamingTracker } from '@/services/cloud/streaming-tracker'
import { chatStorage } from '@/services/storage/chat-storage'
import { sessionChatStorage } from '@/services/storage/session-storage'
import { logError, logInfo } from '@/utils/error-handling'
import type React from 'react'
import type { Chat, Message } from '../types'

/**
 * Chat Persistence Helper
 *
 * Handles saving chat updates to storage with these guarantees:
 * 1. Local-only chats are stored in IndexedDB but NEVER synced to cloud
 * 2. Cloud chats are stored in IndexedDB immediately, then synced to cloud
 * 3. Guest users' chats are stored in session storage only
 * 4. All saves happen immediately through a sequential queue (no debounce, no skipping)
 */

interface CreateUpdateChatWithHistoryCheckParams {
  storeHistory: boolean
  // Live mirror of the chats state. Streamed updates spread a send-time
  // chat snapshot, so metadata changed mid-stream must be re-read from here
  // or it would be reverted by the next flush.
  chatsRef: React.MutableRefObject<Chat[]>
  currentChatRef: React.MutableRefObject<Chat>
}

interface UpdateChatOptions {
  skipCloudSync?: boolean
  skipIndexedDBSave?: boolean
  allowCloudSyncWhileStreaming?: boolean
  metadataPatch?: Partial<Chat>
  requireExisting?: boolean
}

export function createUpdateChatWithHistoryCheck({
  storeHistory,
  chatsRef,
  currentChatRef,
}: CreateUpdateChatWithHistoryCheckParams) {
  return function updateChatWithHistoryCheck(
    setChats: React.Dispatch<React.SetStateAction<Chat[]>>,
    chatSnapshot: Chat,
    setCurrentChat: React.Dispatch<React.SetStateAction<Chat>>,
    chatId: string,
    newMessages: Message[],
    options: UpdateChatOptions = {},
  ) {
    const {
      skipCloudSync = false,
      skipIndexedDBSave = false,
      allowCloudSyncWhileStreaming = false,
      metadataPatch = {},
      requireExisting = false,
    } = options
    const liveChat =
      (currentChatRef.current.id === chatId
        ? currentChatRef.current
        : undefined) ?? chatsRef.current.find((c) => c.id === chatId)
    const updatedChat: Chat = {
      ...chatSnapshot,
      ...liveChat,
      ...metadataPatch,
      id: chatId,
      messages: newMessages,
      // newMessages is the authoritative full history for this chat, so
      // the result is never a metadata-only summary even if the live
      // state entry was demoted to one by a concurrent reload.
      isMetadataOnly: false,
      isBlankChat: newMessages.length === 0,
      // Same rationale as title: the web search toggle can flip while this
      // chat is streaming, so the live value wins over the snapshot.
      webSearchEnabled: liveChat
        ? liveChat.webSearchEnabled
        : chatSnapshot.webSearchEnabled,
      presetId: liveChat ? liveChat.presetId : chatSnapshot.presetId,
    }

    setChats((prevChats) => {
      return prevChats.map((c) => {
        if (c.id === chatId) {
          return {
            ...updatedChat,
            ...c,
            ...metadataPatch,
            messages: newMessages,
            isMetadataOnly: false,
            isBlankChat: newMessages.length === 0,
          }
        }
        return c
      })
    })

    setCurrentChat((prev) =>
      prev.id === chatId
        ? {
            ...updatedChat,
            ...prev,
            ...metadataPatch,
            messages: newMessages,
            isMetadataOnly: false,
            isBlankChat: newMessages.length === 0,
          }
        : prev,
    )

    if (updatedChat.isTemporary) {
      sessionChatStorage.clearStreamingDraft(chatId)
      return
    }

    if (storeHistory) {
      const shouldSkipCloudSync =
        skipCloudSync ||
        updatedChat.isLocalOnly ||
        (!allowCloudSyncWhileStreaming && streamingTracker.isStreaming(chatId))

      if (skipIndexedDBSave) {
        return
      }

      sessionChatStorage.clearStreamingDraft(chatId)

      logInfo('[persistence] Saving chat to storage', {
        component: 'chat-persistence',
        action: 'updateChatWithHistoryCheck',
        metadata: {
          chatId,
          isLocalOnly: updatedChat.isLocalOnly,
          shouldSkipCloudSync,
          isStreaming: streamingTracker.isStreaming(chatId),
          messageCount: newMessages.length,
        },
      })

      const save = requireExisting
        ? chatStorage.saveExistingChat(updatedChat, shouldSkipCloudSync)
        : chatStorage.saveChat(updatedChat, shouldSkipCloudSync)
      save
        .then((savedChat) => {
          if (!savedChat) return
          logInfo('[persistence] Chat saved successfully', {
            component: 'chat-persistence',
            action: 'updateChatWithHistoryCheck.saved',
            metadata: {
              chatId: savedChat.id,
            },
          })
          // The save (and cloud sync, when applicable) has resolved, so
          // clear the pending flag that drives the "Syncing with cloud"
          // sidebar badge. Streaming chunks skip the save path above, so
          // this only fires for real persistence.
          const savedId = savedChat.id
          setChats((prevChats) =>
            prevChats.map((c) =>
              c.id === savedId && c.pendingSave
                ? { ...c, pendingSave: false }
                : c,
            ),
          )
          setCurrentChat((prev) =>
            prev.id === savedId && prev.pendingSave
              ? { ...prev, pendingSave: false }
              : prev,
          )
        })
        .catch((error) => {
          logError('Failed to save chat during update', error, {
            component: 'chat-persistence',
            metadata: {
              chatId,
              isLocalOnly: updatedChat.isLocalOnly,
            },
          })
          // Clear the pending flag even on failure so the badge can't
          // get stuck; the chat stays usable and will retry on the next
          // edit or periodic sync.
          setChats((prevChats) =>
            prevChats.map((c) =>
              c.id === updatedChat.id && c.pendingSave
                ? { ...c, pendingSave: false }
                : c,
            ),
          )
          setCurrentChat((prev) =>
            prev.id === updatedChat.id && prev.pendingSave
              ? { ...prev, pendingSave: false }
              : prev,
          )
        })
    } else {
      if (skipIndexedDBSave) {
        sessionChatStorage.saveStreamingDraft(updatedChat)
      } else {
        sessionChatStorage.saveChat(updatedChat)
      }
    }
  }
}
