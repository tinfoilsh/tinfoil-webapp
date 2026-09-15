import { logError } from '@/utils/error-handling'

type BundleStateMaybeChangedEvent = {
  type: 'bundle-state-maybe-changed'
}

type PasskeyEvent = BundleStateMaybeChangedEvent

type EventHandler<T extends PasskeyEvent> = (event: T) => void

class PasskeyEventsEmitter {
  private handlers: Map<string, Set<EventHandler<any>>> = new Map()

  on<T extends PasskeyEvent>(
    type: T['type'],
    handler: EventHandler<T>,
  ): () => void {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set())
    }
    this.handlers.get(type)!.add(handler)
    return () => {
      this.handlers.get(type)?.delete(handler)
    }
  }

  emit<T extends PasskeyEvent>(event: T): void {
    const handlers = this.handlers.get(event.type)
    if (!handlers) return
    handlers.forEach((handler) => {
      try {
        handler(event)
      } catch (error) {
        logError('Passkey event handler failed', error, {
          component: 'PasskeyEventsEmitter',
          action: 'emit',
          metadata: { eventType: event.type },
        })
      }
    })
  }

  clear(): void {
    this.handlers.clear()
  }
}

export const passkeyEvents = new PasskeyEventsEmitter()
