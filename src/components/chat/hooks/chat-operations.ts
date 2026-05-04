import { chatStorage } from '@/services/storage/chat-storage'
import { deletedChatsTracker } from '@/services/storage/deleted-chats-tracker'
import { sessionChatStorage } from '@/services/storage/session-storage'
import { logError } from '@/utils/error-handling'
import type { Chat, Message } from '../types'

/**
 * Chat Operations - Pure functions for managing chat data
 * Handles CRUD operations without React state concerns
 */

/**
 * Creates a new blank chat object without an ID
 */
export function createBlankChat(isLocalOnly = false): Chat {
  return {
    id: '', // Blank chats have no ID
    title: 'New Chat',
    titleState: 'placeholder',
    messages: [],
    createdAt: new Date(),
    isBlankChat: true,
    isLocalOnly,
  }
}

/**
 * Loads all chats from storage
 */
export async function loadChats(isSignedIn: boolean): Promise<Chat[]> {
  try {
    const chats = isSignedIn
      ? await chatStorage.getAllChatsWithSyncStatus()
      : sessionChatStorage.getAllChats()

    return chats
      .filter((chat) => !deletedChatsTracker.isDeleted(chat.id))
      .map((chat) => ({
        ...chat,
        createdAt: new Date(chat.createdAt),
      }))
  } catch (error) {
    logError('Failed to load chats', error, {
      component: 'chat-operations',
      action: 'loadChats',
    })
    return []
  }
}

/**
 * Saves a chat to storage
 */
export async function saveChat(
  chat: Chat,
  isSignedIn: boolean,
  skipCloudSync = false,
): Promise<Chat> {
  try {
    if (isSignedIn) {
      return await chatStorage.saveChat(chat, skipCloudSync)
    } else {
      sessionChatStorage.saveChat(chat)
      return chat
    }
  } catch (error) {
    logError('Failed to save chat', error, {
      component: 'chat-operations',
      action: 'saveChat',
      metadata: { chatId: chat.id },
    })
    throw error
  }
}

/**
 * Deletes a chat from storage
 */
export async function deleteChat(
  chatId: string,
  isSignedIn: boolean,
): Promise<void> {
  if (isSignedIn) {
    await chatStorage.deleteChat(chatId)
  } else {
    sessionChatStorage.deleteChat(chatId)
  }
}

/**
 * Updates a chat with new messages
 */
export function updateChatMessages(chat: Chat, messages: Message[]): Chat {
  return {
    ...chat,
    messages,
    isBlankChat: messages.length === 0,
  }
}

/**
 * Gets the blank chat for the given mode (cloud or local-only)
 * There should only be one blank chat per mode
 */
export function getBlankChat(
  chats: Chat[],
  isLocalOnly = false,
): Chat | undefined {
  return chats.find(
    (c) => c.isBlankChat === true && c.isLocalOnly === isLocalOnly,
  )
}

/**
 * Ensures at least one chat exists
 */
export function ensureAtLeastOneChat(chats: Chat[]): Chat[] {
  if (chats.length === 0) {
    return [createBlankChat()]
  }
  return chats
}

/**
 * Sorts chats with blank chats first, then by creation date
 * Blank chats are always at the top (cloud blank first, then local-only blank)
 */
export function sortChats(chats: Chat[]): Chat[] {
  return [...chats].sort((a, b) => {
    // Both blank chats - cloud blank comes before local-only blank
    if (a.isBlankChat && b.isBlankChat) {
      if (!a.isLocalOnly && b.isLocalOnly) return -1
      if (a.isLocalOnly && !b.isLocalOnly) return 1
      return 0
    }

    // Blank chats always come first
    if (a.isBlankChat && !b.isBlankChat) return -1
    if (!a.isBlankChat && b.isBlankChat) return 1

    // Regular chats sorted by creation date (newest first)
    const timeA = new Date(a.createdAt).getTime()
    const timeB = new Date(b.createdAt).getTime()
    return timeB - timeA
  })
}

/**
 * Merges loaded chats with current state
 * IndexedDB is the source of truth - state chats are only preserved if they don't exist in IndexedDB
 */
export function mergeChatsWithState(
  loadedChats: Chat[],
  currentChats: Chat[],
): Chat[] {
  const chatMap = new Map<string, Chat>()

  // Helper to get unique key for a chat (includes isLocalOnly for blank chats)
  const getChatKey = (chat: Chat) => {
    if (chat.id === '' && chat.isBlankChat) {
      return `blank-${chat.isLocalOnly ? 'local' : 'cloud'}`
    }
    return chat.id
  }

  // Add loaded chats from IndexedDB (source of truth)
  loadedChats.forEach((chat) => {
    chatMap.set(getChatKey(chat), chat)
  })

  // Only preserve state chats if they don't exist in IndexedDB yet
  // (blank chats, unsaved chats, etc.)
  currentChats.forEach((chat) => {
    const key = getChatKey(chat)
    if (!chatMap.has(key)) {
      chatMap.set(key, chat)
    }
  })

  return sortChats(Array.from(chatMap.values()))
}
