import { logError } from '@/utils/error-handling'
import type { Chat, Message } from '../types'
import { saveChat, updateChatMessages } from './chat-operations'

/**
 * Chat Persistence Manager
 *
 * Handles chat persistence with a sequential save queue to prevent race conditions.
 * Each chat gets its own queue to ensure saves happen in order.
 *
 * Three save triggers:
 * 1. Message changes (user input, assistant response)
 * 2. Title changes (after first response)
 * 3. Cloud sync updates (handled separately in cloud-sync.ts)
 */
export class ChatPersistenceManager {
  private saveQueues = new Map<string, Promise<Chat>>()
  private isSignedIn: boolean
  private isDisposed = false

  constructor(
    isSignedIn: boolean,
    private readonly accountScope: string,
    private readonly getAccountScope: () => string,
  ) {
    this.isSignedIn = isSignedIn
  }

  activate() {
    this.isDisposed = false
  }

  setSignedIn(isSignedIn: boolean) {
    this.isSignedIn = isSignedIn
  }

  /**
   * Save a chat immediately with messages.
   * Uses a per-chat queue to ensure saves happen sequentially without race conditions.
   */
  async saveWithMessages(
    chat: Chat,
    messages: Message[],
    skipCloudSync = false,
  ): Promise<Chat> {
    const updatedChat = updateChatMessages(chat, messages)
    return this.save(updatedChat, skipCloudSync)
  }

  /**
   * Save a chat immediately.
   * Queues the save per chat ID to prevent concurrent writes.
   */
  async save(chat: Chat, skipCloudSync = false): Promise<Chat> {
    const existingQueue = this.saveQueues.get(chat.id) || Promise.resolve(chat)

    const savePromise = existingQueue
      .catch(() => undefined)
      .then(async () => {
        if (this.isDisposed || this.accountScope !== this.getAccountScope()) {
          return chat
        }
        try {
          const savedChat = await saveChat(chat, this.isSignedIn, skipCloudSync)
          return savedChat
        } catch (error) {
          logError('Failed to save chat', error, {
            component: 'ChatPersistenceManager',
            action: 'save',
            metadata: { chatId: chat.id },
          })
          throw error
        }
      })

    this.saveQueues.set(chat.id, savePromise)

    try {
      const result = await savePromise
      return result
    } finally {
      if (this.saveQueues.get(chat.id) === savePromise) {
        this.saveQueues.delete(chat.id)
      }
    }
  }

  /**
   * Cleanup on unmount
   */
  cleanup() {
    this.isDisposed = true
    this.saveQueues.clear()
  }
}
