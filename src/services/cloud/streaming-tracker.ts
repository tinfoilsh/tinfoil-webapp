import { logError } from '@/utils/error-handling'

/**
 * Tracks which chats currently have an in-flight assistant stream.
 *
 * This is the single, app-wide source of truth for "is chat X streaming".
 * It is consumed in three independent places:
 *   1. Persistence/cloud-sync gating (defer uploads until a stream ends).
 *   2. The streaming pipeline (start/end markers per chat).
 *   3. The sidebar streaming indicator, via `useStreamingChats` which
 *      subscribes through the observer API below.
 *
 * Because multiple chats can stream concurrently, callers must always key
 * off a specific `chatId` rather than a global boolean.
 */
class StreamingTracker {
  private streamingChats = new Set<string>()
  private streamEndCallbacks = new Map<string, (() => void)[]>()
  private listeners = new Set<() => void>()
  // Immutable snapshot handed to React via useSyncExternalStore. A fresh
  // Set is published on every change so referential identity tracks state.
  private snapshot: ReadonlySet<string> = new Set()

  startStreaming(chatId: string): void {
    if (this.streamingChats.has(chatId)) return
    this.streamingChats.add(chatId)
    this.publish()
  }

  endStreaming(chatId: string): void {
    const wasStreaming = this.streamingChats.delete(chatId)

    // Execute any callbacks waiting for this chat to finish streaming
    const callbacks = this.streamEndCallbacks.get(chatId)
    if (callbacks) {
      // Execute each callback with error handling to prevent one failure from affecting others
      callbacks.forEach((callback) => {
        try {
          callback()
        } catch (error) {
          logError('Error executing stream end callback', error, {
            component: 'StreamingTracker',
            action: 'endStreaming',
            metadata: { chatId },
          })
        }
      })
      // Always clean up callbacks, even if some failed
      this.streamEndCallbacks.delete(chatId)
    }

    if (wasStreaming) this.publish()
  }

  isStreaming(chatId: string): boolean {
    return this.streamingChats.has(chatId)
  }

  getStreamingChats(): string[] {
    return Array.from(this.streamingChats)
  }

  // Register a callback to be called when a specific chat finishes streaming
  onStreamEnd(chatId: string, callback: () => void): void {
    if (!this.isStreaming(chatId)) {
      // Chat is not streaming, execute callback immediately
      callback()
      return
    }

    const callbacks = this.streamEndCallbacks.get(chatId) || []
    callbacks.push(callback)
    this.streamEndCallbacks.set(chatId, callbacks)
  }

  /**
   * Observer API for React. Arrow-bound so they can be passed directly to
   * `useSyncExternalStore` without re-binding on every render.
   */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot = (): ReadonlySet<string> => this.snapshot

  private publish(): void {
    this.snapshot = new Set(this.streamingChats)
    this.listeners.forEach((listener) => {
      try {
        listener()
      } catch (error) {
        logError('Error notifying streaming listener', error, {
          component: 'StreamingTracker',
          action: 'publish',
        })
      }
    })
  }
}

export const streamingTracker = new StreamingTracker()
