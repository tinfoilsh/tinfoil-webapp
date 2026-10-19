import { SYNC_DELETED_CHATS } from '@/constants/storage-keys'
import { logInfo } from '@/utils/error-handling'

/**
 * Tracks deleted chats to prevent resurrection during sync.
 * IDs persist for the browser session (via sessionStorage) and are only
 * removed explicitly by source or via clear().
 */
export class DeletedChatsTracker {
  private localDeletedChats = new Set<string>()
  private remoteDeletedChats = new Set<string>()

  constructor() {
    this.loadFromStorage()
  }

  private loadFromStorage(): void {
    if (typeof window === 'undefined') return
    try {
      const stored = sessionStorage.getItem(SYNC_DELETED_CHATS)
      if (stored) {
        const parsed: unknown[] = JSON.parse(stored)
        parsed.forEach((entry) => {
          if (typeof entry === 'string') {
            // The legacy string format combined local and remote tombstones.
            // Revision sync is authoritative, so an upsert must be able to
            // retire these after they suppress any stale in-flight save.
            this.remoteDeletedChats.add(entry)
          } else if (entry && typeof entry === 'object' && 'chatId' in entry) {
            const persisted = entry as {
              chatId: unknown
              local?: unknown
              remote?: unknown
            }
            if (typeof persisted.chatId !== 'string') return
            if (persisted.local === true) {
              this.localDeletedChats.add(persisted.chatId)
            }
            if (persisted.remote === true) {
              this.remoteDeletedChats.add(persisted.chatId)
            }
            if (persisted.local !== true && persisted.remote !== true) {
              // Backward compat with old {chatId, deletedAt} format
              this.remoteDeletedChats.add(persisted.chatId)
            }
          }
        })
        this.saveToStorage()
      }
    } catch (error) {
      // Ignore errors loading from storage
    }
  }

  private saveToStorage(): void {
    if (typeof window === 'undefined') return
    try {
      const ids = new Set([
        ...this.localDeletedChats,
        ...this.remoteDeletedChats,
      ])
      if (ids.size > 0) {
        sessionStorage.setItem(
          SYNC_DELETED_CHATS,
          JSON.stringify(
            Array.from(ids, (chatId) => ({
              chatId,
              local: this.localDeletedChats.has(chatId),
              remote: this.remoteDeletedChats.has(chatId),
            })),
          ),
        )
      } else {
        sessionStorage.removeItem(SYNC_DELETED_CHATS)
      }
    } catch (error) {
      // Silently fail - storage may be unavailable or full
    }
  }

  markAsDeleted(chatId: string): void {
    this.localDeletedChats.add(chatId)
    this.saveToStorage()

    logInfo('Marked chat as deleted', {
      component: 'DeletedChatsTracker',
      action: 'markAsDeleted',
      metadata: { chatId },
    })
  }

  markAsRemoteDeleted(chatId: string): void {
    this.remoteDeletedChats.add(chatId)
    this.saveToStorage()

    logInfo('Marked remote chat as deleted', {
      component: 'DeletedChatsTracker',
      action: 'markAsRemoteDeleted',
      metadata: { chatId },
    })
  }

  isDeleted(chatId: string): boolean {
    return (
      this.localDeletedChats.has(chatId) || this.remoteDeletedChats.has(chatId)
    )
  }

  removeLocalDeletion(chatId: string): boolean {
    if (this.localDeletedChats.delete(chatId)) {
      this.saveToStorage()

      logInfo('Removed local chat deletion from tracker', {
        component: 'DeletedChatsTracker',
        action: 'removeLocalDeletion',
        metadata: { chatId },
      })
      return true
    }
    return false
  }

  removeRemoteDeletion(chatId: string): boolean {
    if (!this.remoteDeletedChats.delete(chatId)) return false
    this.saveToStorage()

    logInfo('Removed remote chat deletion from tracker', {
      component: 'DeletedChatsTracker',
      action: 'removeRemoteDeletion',
      metadata: { chatId },
    })
    return !this.localDeletedChats.has(chatId)
  }

  clear(): void {
    this.localDeletedChats.clear()
    this.remoteDeletedChats.clear()
    if (typeof window !== 'undefined') {
      sessionStorage.removeItem(SYNC_DELETED_CHATS)
    }
  }

  getDeletedIds(): string[] {
    return Array.from(
      new Set([...this.localDeletedChats, ...this.remoteDeletedChats]),
    )
  }
}

export const deletedChatsTracker = new DeletedChatsTracker()
