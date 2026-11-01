import type { Chat } from '@/components/chat/types'
import { SYNC_SESSION_CHATS } from '@/constants/storage-keys'
import { logError } from '@/utils/error-handling'
import { deletedChatsTracker } from './deleted-chats-tracker'

// Convert date strings back to Date objects
function restoreChat(chat: Chat): Chat {
  return {
    ...chat,
    ...(chat.createdAt ? { createdAt: new Date(chat.createdAt) } : {}),
    messages: Array.isArray(chat.messages)
      ? chat.messages.map((message) => ({
          ...message,
          timestamp: new Date(message.timestamp),
        }))
      : [], // Default to empty array if messages is not an array
  }
}

function getCanonicalChats(): Chat[] {
  const chatsJson = sessionStorage.getItem(SYNC_SESSION_CHATS)
  const parsedChats = chatsJson ? JSON.parse(chatsJson) : []
  return Array.isArray(parsedChats)
    ? parsedChats.map((chat) => restoreChat(chat as Chat))
    : []
}

export const sessionChatStorage = {
  getAllChats(): Chat[] {
    try {
      return getCanonicalChats()
    } catch (error) {
      logError('Failed to get chats from session storage', error, {
        component: 'sessionChatStorage',
        action: 'getAllChats',
      })
      return []
    }
  },

  getChat(chatId: string): Chat | null {
    return this.getAllChats().find((chat) => chat.id === chatId) ?? null
  },

  saveChat(chat: Chat): void {
    try {
      // Validate chat parameter
      if (!chat) {
        logError(
          'Cannot save chat: chat parameter is undefined or null',
          undefined,
          {
            component: 'sessionChatStorage',
            action: 'saveChat',
          },
        )
        return
      }

      // Never save blank chats to storage
      if (chat.isBlankChat) return

      if (!chat.id) {
        logError('Cannot save chat: chat.id is undefined or null', undefined, {
          component: 'sessionChatStorage',
          action: 'saveChat',
        })
        return
      }

      if (deletedChatsTracker.isDeleted(chat.id)) return

      const chats = getCanonicalChats()
      const existingIndex = chats.findIndex((c) => c.id === chat.id)

      if (existingIndex >= 0) {
        chats[existingIndex] = chat
      } else {
        chats.push(chat)
      }

      sessionStorage.setItem(SYNC_SESSION_CHATS, JSON.stringify(chats))
    } catch (error) {
      logError('Failed to save chat to session storage', error, {
        component: 'sessionChatStorage',
        action: 'saveChat',
        metadata: { chatId: chat?.id || 'undefined' },
      })
    }
  },

  deleteChat(chatId: string): void {
    try {
      const chats = getCanonicalChats()
      const filteredChats = chats.filter((c) => c.id !== chatId)
      sessionStorage.setItem(SYNC_SESSION_CHATS, JSON.stringify(filteredChats))
    } catch (error) {
      logError('Failed to delete chat from session storage', error, {
        component: 'sessionChatStorage',
        action: 'deleteChat',
        metadata: { chatId },
      })
    }
  },

  clearAll(): void {
    try {
      sessionStorage.removeItem(SYNC_SESSION_CHATS)
    } catch (error) {
      logError('Failed to clear session storage', error, {
        component: 'sessionChatStorage',
        action: 'clearAll',
      })
    }
  },
}
