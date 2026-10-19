import { SYNC_DELETED_CHATS } from '@/constants/storage-keys'
import { logInfo } from '@/utils/error-handling'

/**
 * Tracks deleted chats so a run that finishes after its chat was deleted
 * cannot write it back. IDs persist for the browser session (via
 * sessionStorage) and are only removed explicitly or via clear().
 */
export class DeletedChatsTracker {
  private deletedChats = new Set<string>()

  constructor() {
    this.loadFromStorage()
  }

  private loadFromStorage(): void {
    if (typeof window === 'undefined') return
    try {
      const stored = sessionStorage.getItem(SYNC_DELETED_CHATS)
      if (!stored) return
      const parsed: unknown = JSON.parse(stored)
      if (!Array.isArray(parsed)) return
      for (const entry of parsed)
        if (typeof entry === 'string') this.deletedChats.add(entry)
    } catch (error) {
      // Ignore errors loading from storage
    }
  }

  private saveToStorage(): void {
    if (typeof window === 'undefined') return
    try {
      if (this.deletedChats.size > 0) {
        sessionStorage.setItem(
          SYNC_DELETED_CHATS,
          JSON.stringify([...this.deletedChats]),
        )
      } else {
        sessionStorage.removeItem(SYNC_DELETED_CHATS)
      }
    } catch (error) {
      // Silently fail - storage may be unavailable or full
    }
  }

  markAsDeleted(chatId: string): void {
    this.deletedChats.add(chatId)
    this.saveToStorage()

    logInfo('Marked chat as deleted', {
      component: 'DeletedChatsTracker',
      action: 'markAsDeleted',
      metadata: { chatId },
    })
  }

  isDeleted(chatId: string): boolean {
    return this.deletedChats.has(chatId)
  }

  removeDeletion(chatId: string): void {
    if (!this.deletedChats.delete(chatId)) return
    this.saveToStorage()

    logInfo('Removed chat deletion from tracker', {
      component: 'DeletedChatsTracker',
      action: 'removeDeletion',
      metadata: { chatId },
    })
  }

  clear(): void {
    this.deletedChats.clear()
    if (typeof window !== 'undefined') {
      sessionStorage.removeItem(SYNC_DELETED_CHATS)
    }
  }
}

export const deletedChatsTracker = new DeletedChatsTracker()
