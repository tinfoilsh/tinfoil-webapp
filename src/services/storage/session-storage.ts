import type { Chat } from '@/components/chat/types'
import {
  SYNC_SESSION_CHAT_DRAFT_PREFIX,
  SYNC_SESSION_CHATS,
} from '@/constants/storage-keys'
import { logError } from '@/utils/error-handling'
import { deletedChatsTracker } from './deleted-chats-tracker'

// Convert date strings back to Date objects
function restoreChat(chat: Chat): Chat {
  return {
    ...chat,
    createdAt: new Date(chat.createdAt),
    messages: Array.isArray(chat.messages)
      ? chat.messages.map((message) => ({
          ...message,
          timestamp: new Date(message.timestamp),
        }))
      : [], // Default to empty array if messages is not an array
  }
}

function getDraftKey(chatId: string): string {
  return `${SYNC_SESSION_CHAT_DRAFT_PREFIX}${chatId}`
}

function getStreamingDrafts(): Chat[] {
  const drafts: Chat[] = []
  for (let index = 0; index < sessionStorage.length; index++) {
    const key = sessionStorage.key(index)
    if (!key?.startsWith(SYNC_SESSION_CHAT_DRAFT_PREFIX)) continue
    const value = sessionStorage.getItem(key)
    if (!value) continue
    try {
      drafts.push(restoreChat(JSON.parse(value) as Chat))
    } catch (error) {
      logError('Failed to read chat streaming draft', error, {
        component: 'sessionChatStorage',
        action: 'getStreamingDrafts',
        metadata: { chatId: key.slice(SYNC_SESSION_CHAT_DRAFT_PREFIX.length) },
      })
    }
  }
  return drafts
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
      const chats = getCanonicalChats()

      for (const draft of getStreamingDrafts()) {
        const existingIndex = chats.findIndex((chat) => chat.id === draft.id)
        if (existingIndex >= 0) {
          chats[existingIndex] = { ...chats[existingIndex], ...draft }
        } else {
          chats.push(draft)
        }
      }
      return chats
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

  saveStreamingDraft(chat: Chat): void {
    try {
      if (!chat?.id || chat.isBlankChat || chat.isTemporary) {
        if (chat?.id) this.clearStreamingDraft(chat.id)
        return
      }
      if (deletedChatsTracker.isDeleted(chat.id)) {
        this.clearStreamingDraft(chat.id)
        return
      }
      sessionStorage.setItem(getDraftKey(chat.id), JSON.stringify(chat))
    } catch (error) {
      logError('Failed to save chat streaming draft', error, {
        component: 'sessionChatStorage',
        action: 'saveStreamingDraft',
        metadata: { chatId: chat?.id || 'undefined' },
      })
    }
  },

  clearStreamingDraft(chatId: string): void {
    try {
      sessionStorage.removeItem(getDraftKey(chatId))
    } catch (error) {
      logError('Failed to clear chat streaming draft', error, {
        component: 'sessionChatStorage',
        action: 'clearStreamingDraft',
        metadata: { chatId },
      })
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
        if (chat.id) this.clearStreamingDraft(chat.id)
        return
      }

      if (!chat.id) {
        logError('Cannot save chat: chat.id is undefined or null', undefined, {
          component: 'sessionChatStorage',
          action: 'saveChat',
        })
        return
      }

      if (deletedChatsTracker.isDeleted(chat.id)) {
        this.clearStreamingDraft(chat.id)
        return
      }

      const chats = getCanonicalChats()
      const existingIndex = chats.findIndex((c) => c.id === chat.id)

      if (existingIndex >= 0) {
        chats[existingIndex] = chat
      } else {
        chats.push(chat)
      }

      const draftKey = getDraftKey(chat.id)
      const draft = sessionStorage.getItem(draftKey)
      sessionStorage.removeItem(draftKey)
      try {
        sessionStorage.setItem(SYNC_SESSION_CHATS, JSON.stringify(chats))
      } catch (error) {
        if (draft !== null) {
          try {
            sessionStorage.setItem(draftKey, draft)
          } catch {
            // Both session writes are best effort.
          }
        }
        throw error
      }
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
      sessionStorage.removeItem(getDraftKey(chatId))
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
      const draftKeys: string[] = []
      for (let index = 0; index < sessionStorage.length; index++) {
        const key = sessionStorage.key(index)
        if (key?.startsWith(SYNC_SESSION_CHAT_DRAFT_PREFIX)) {
          draftKeys.push(key)
        }
      }
      draftKeys.forEach((key) => sessionStorage.removeItem(key))
    } catch (error) {
      logError('Failed to clear session storage', error, {
        component: 'sessionChatStorage',
        action: 'clearAll',
      })
    }
  },
}
