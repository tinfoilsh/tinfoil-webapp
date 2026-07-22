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
  // Mirrors the id of the chat currently on screen. Used to decide whether
  // a streamed update should also be reflected into `currentChat`. With
  // concurrent streams this is independent of which chat is streaming.
  viewedChatIdRef: React.MutableRefObject<string>
  // Live mirror of the chats state. Streamed updates spread a send-time
  // chat snapshot, so per-chat preferences toggled mid-stream must be
  // re-read from here or they would be reverted by the next flush.
  chatsRef: React.MutableRefObject<Chat[]>
}

export function createUpdateChatWithHistoryCheck({
  storeHistory,
  viewedChatIdRef,
  chatsRef,
}: CreateUpdateChatWithHistoryCheckParams) {
  return function updateChatWithHistoryCheck(
    setChats: React.Dispatch<React.SetStateAction<Chat[]>>,
    chatSnapshot: Chat,
    setCurrentChat: React.Dispatch<React.SetStateAction<Chat>>,
    chatId: string,
    newMessages: Message[],
    skipCloudSync = false,
    skipIndexedDBSave = false,
  ) {
    const isCurrentChat = viewedChatIdRef.current === chatId

    // Only update messages and set isBlankChat based on message count
    // Keep all other properties from chatSnapshot (including title, isLocalOnly, etc.)
    // IMPORTANT: Preserve title from current state to avoid race with early title generation
    const liveChat = chatsRef.current.find((c) => c.id === chatId)
    const updatedChat: Chat = {
      ...chatSnapshot,
      id: chatId,
      messages: newMessages,
      isBlankChat: newMessages.length === 0,
      // Same rationale as title: the web search toggle can flip while this
      // chat is streaming, so the live value wins over the snapshot.
      webSearchEnabled: liveChat
        ? liveChat.webSearchEnabled
        : chatSnapshot.webSearchEnabled,
    }

    setChats((prevChats) => {
      return prevChats.map((c) => {
        if (c.id === chatId) {
          return {
            ...updatedChat,
            title: c.title, // Preserve title from state (may have been updated by early title gen)
            titleState: c.titleState,
          }
        }
        return c
      })
    })

    if (isCurrentChat) {
      setCurrentChat((prev) => ({
        ...updatedChat,
        title: prev.title, // Preserve title from state (may have been updated by early title gen)
        titleState: prev.titleState,
      }))
    }

    if (updatedChat.isTemporary) {
      return
    }

    if (storeHistory) {
      const shouldSkipCloudSync =
        skipCloudSync ||
        updatedChat.isLocalOnly ||
        streamingTracker.isStreaming(chatId)

      // Skip IndexedDB save if explicitly requested (during streaming chunks)
      if (skipIndexedDBSave) {
        return
      }

      logInfo('[persistence] Saving chat to storage', {
        component: 'chat-persistence',
        action: 'updateChatWithHistoryCheck',
        metadata: {
          chatId,
          isLocalOnly: updatedChat.isLocalOnly,
          shouldSkipCloudSync,
          isStreaming: streamingTracker.isStreaming(chatId),
          messageCount: newMessages.length,
          title: updatedChat.title,
        },
      })

      chatStorage
        .saveChat(updatedChat, shouldSkipCloudSync)
        .then((savedChat) => {
          logInfo('[persistence] Chat saved successfully', {
            component: 'chat-persistence',
            action: 'updateChatWithHistoryCheck.saved',
            metadata: {
              chatId: savedChat.id,
              originalId: updatedChat.id,
              idChanged: savedChat.id !== updatedChat.id,
            },
          })
          if (savedChat.id !== updatedChat.id) {
            // ID changed (server assigned new ID).
            // Carry the streaming marker across so cloud-sync gating and
            // the sidebar indicator keep tracking the same conversation.
            if (streamingTracker.isStreaming(updatedChat.id)) {
              streamingTracker.endStreaming(updatedChat.id)
              streamingTracker.startStreaming(savedChat.id)
            }
            if (isCurrentChat && viewedChatIdRef.current === updatedChat.id) {
              viewedChatIdRef.current = savedChat.id
              setCurrentChat(savedChat)
            }
            setChats((prevChats) =>
              prevChats.map((c) => (c.id === updatedChat.id ? savedChat : c)),
            )
          }

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
      sessionChatStorage.saveChat(updatedChat)
    }
  }
}
