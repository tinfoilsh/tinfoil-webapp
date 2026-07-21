import { logError } from '@/utils/error-handling'

export type ChatChangeReason =
  'save' | 'delete' | 'sync' | 'pagination' | 'recovery'

export interface ChatIdChange {
  from: string
  to: string
}

export interface ChatChangedEvent {
  reason: ChatChangeReason
  ids?: string[]
  idChanges?: ChatIdChange[]
}

type Listener = (event: ChatChangedEvent) => void

class ChatEvents {
  private listeners: Set<Listener> = new Set()
  private listenerCleanupMap = new WeakMap<Listener, () => void>()

  on(listener: Listener): () => void {
    this.listeners.add(listener)

    // Create and store the cleanup function
    const cleanup = () => this.off(listener)
    this.listenerCleanupMap.set(listener, cleanup)

    return cleanup
  }

  off(listener: Listener): void {
    this.listeners.delete(listener)
    this.listenerCleanupMap.delete(listener)
  }

  emit(event: ChatChangedEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (error) {
        logError('Chat event listener error', error, {
          component: 'ChatEvents',
          action: 'emit',
          metadata: { reason: event.reason, idsCount: event.ids?.length ?? 0 },
        })
      }
    }
  }

  // Clean up all listeners (useful for testing or shutdown)
  clear(): void {
    this.listeners.clear()
    // WeakMap will automatically clean up when listeners are garbage collected
  }
}

export const chatEvents = new ChatEvents()
