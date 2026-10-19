import type { Message } from '@/components/chat/types'
import { SYNC_PROJECTS_INVALIDATED } from '@/constants/storage-keys'
import { logError } from '@/utils/error-handling'

type ProjectMemoryUpdateEvent = {
  type: 'memory-update-needed'
  projectId: string
  messages: Message[]
}

type ProjectsInvalidatedEvent = {
  type: 'projects-invalidated'
}

type ProjectEvent = ProjectMemoryUpdateEvent | ProjectsInvalidatedEvent

type EventHandler<T extends ProjectEvent> = (event: T) => void

class ProjectEventsEmitter {
  private handlers: Map<string, Set<EventHandler<any>>> = new Map()

  on<T extends ProjectEvent['type']>(
    type: T,
    handler: EventHandler<Extract<ProjectEvent, { type: T }>>,
  ): () => void {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set())
    }
    this.handlers.get(type)!.add(handler)

    return () => {
      this.handlers.get(type)?.delete(handler)
    }
  }

  emit<T extends ProjectEvent>(event: T): void {
    const handlers = this.handlers.get(event.type)
    if (handlers) {
      handlers.forEach((handler) => {
        try {
          handler(event)
        } catch (error) {
          logError('Project event handler failed', error, {
            component: 'ProjectEventsEmitter',
            action: 'emit',
            metadata: { eventType: event.type },
          })
        }
      })
    }
  }

  clear(): void {
    this.handlers.clear()
  }
}

export const projectEvents = new ProjectEventsEmitter()

export function invalidateProjects(): void {
  projectEvents.emit({ type: 'projects-invalidated' })
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(SYNC_PROJECTS_INVALIDATED, crypto.randomUUID())
  } catch {
    // Cross-tab invalidation is best-effort; the current tab was already reset.
  }
}
