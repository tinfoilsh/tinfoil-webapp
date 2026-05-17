import type { Chat } from '@/components/chat/types'
import { SYNC_SESSION_CHATS } from '@/constants/storage-keys'
import { logError } from '@/utils/error-handling'

export const sessionChatStorage = {
  getAllChats(): Chat[] {
    try {
      const chatsJson = sessionStorage.getItem(SYNC_SESSION_CHATS)
      if (!chatsJson) return []

      const chats = JSON.parse(chatsJson)
      if (!Array.isArray(chats)) return []

      // Convert date strings back to Date objects
      return chats.map((chat) => ({
        ...chat,
        createdAt: new Date(chat.createdAt),
        messages: Array.isArray(chat.messages)
          ? chat.messages.map((msg: any) => ({
              ...msg,
              timestamp: new Date(msg.timestamp),
            }))
          : [], // Default to empty array if messages is not an array
      }))
    } catch (error) {
      logError('Failed to get chats from session storage', error, {
        component: 'sessionChatStorage',
        action: 'getAllChats',
      })
      return []
    }
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
      if (chat.isBlankChat) {
        return
      }

      if (!chat.id) {
        logError('Cannot save chat: chat.id is undefined or null', undefined, {
          component: 'sessionChatStorage',
          action: 'saveChat',
        })
        return
      }

      const chats = this.getAllChats()
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
      const chats = this.getAllChats()
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
