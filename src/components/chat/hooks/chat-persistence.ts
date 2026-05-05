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
  isStreamingRef: React.MutableRefObject<boolean>
  currentChatIdRef: React.MutableRefObject<string>
}

export function createUpdateChatWithHistoryCheck({
  storeHistory,
  isStreamingRef,
  currentChatIdRef,
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
    const isCurrentChat = currentChatIdRef.current === chatId

    // Only update messages and set isBlankChat based on message count
    // Keep all other properties from chatSnapshot (including title, isLocalOnly, etc.)
    // IMPORTANT: Preserve title from current state to avoid race with early title generation
    const updatedChat: Chat = {
      ...chatSnapshot,
      id: chatId,
      messages: newMessages,
      isBlankChat: newMessages.length === 0,
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
        skipCloudSync || updatedChat.isLocalOnly || isStreamingRef.current

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
          isStreaming: isStreamingRef.current,
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
            // ID changed (server assigned new ID)
            if (isCurrentChat && currentChatIdRef.current === updatedChat.id) {
              // If we're streaming, transfer the streaming state to the new ID
              if (isStreamingRef.current) {
                import('@/services/cloud/streaming-tracker').then(
                  ({ streamingTracker }) => {
                    streamingTracker.endStreaming(updatedChat.id)
                    streamingTracker.startStreaming(savedChat.id)
                  },
                )
              }
              currentChatIdRef.current = savedChat.id
              setCurrentChat(savedChat)
            }
            setChats((prevChats) =>
              prevChats.map((c) => (c.id === updatedChat.id ? savedChat : c)),
            )
          }
        })
        .catch((error) => {
          logError('Failed to save chat during update', error, {
            component: 'chat-persistence',
            metadata: {
              chatId,
              isLocalOnly: updatedChat.isLocalOnly,
            },
          })
        })
    } else {
      sessionChatStorage.saveChat(updatedChat)
    }
  }
}
