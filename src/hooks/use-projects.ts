import { useHarness } from '@/services/harness/provider'
import { getView, type HarnessAPI } from '@/services/harness/runtime'
import type { Project } from '@/types/project'
import { logError } from '@/utils/error-handling'
import { useCallback, useEffect, useSyncExternalStore } from 'react'
export const PROJECTS_CHANGED = 'harness-projects-changed'
interface ProjectListState {
  projects: Project[]
  loading: boolean
  error: string | null
}
// The account's project list, which every useProjects shows. Hooks that load
// together share one listing, and a refresh or a change reloads it once for
// all of them.
class ProjectList {
  private state: ProjectListState = {
    projects: [],
    loading: false,
    error: null,
  }
  private listing: Promise<void> | null = null
  // Only the latest listing applies, so a list read before a change cannot
  // replace the list read after it.
  private generation = 0
  private readonly listeners = new Set<() => void>()
  constructor(private readonly api: HarnessAPI) {}
  read = () => this.state
  subscribe = (listener: () => void) => {
    if (this.listeners.size === 0)
      window.addEventListener(PROJECTS_CHANGED, this.changed)
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0)
        window.removeEventListener(PROJECTS_CHANGED, this.changed)
    }
  }
  private changed = () => {
    void this.refresh()
  }
  private set(patch: Partial<ProjectListState>) {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }
  load(): Promise<void> {
    return (getView().keyReady && this.listing) || this.refresh()
  }
  // A failed refresh keeps its error here and resolves, since callers start
  // one without waiting for it.
  refresh(): Promise<void> {
    const version = ++this.generation
    const isCurrent = () =>
      version === this.generation && !this.api.lifetime.signal.aborted
    if (!this.api.userId || !getView().keyReady) {
      this.listing = null
      this.set({ projects: [], loading: false })
      return Promise.resolve()
    }
    this.set({ loading: true })
    const listing = (async () => {
      try {
        const all: Project[] = []
        let cursor: string | null = null
        do {
          const page: { projects: Project[]; nextCursor: string | null } =
            await this.api.post('/v1/projects/list', { cursor })
          all.push(...page.projects)
          cursor = page.nextCursor
        } while (cursor)
        if (isCurrent()) this.set({ projects: all, error: null })
      } catch (cause) {
        if (!isCurrent()) return
        this.set({
          error:
            cause instanceof Error ? cause.message : 'Unable to load projects.',
        })
        logError('Failed to load projects', cause, {
          component: 'useProjects',
          action: 'refresh',
        })
      } finally {
        // A later refresh has replaced this listing otherwise.
        if (version === this.generation) this.listing = null
        if (isCurrent()) this.set({ loading: false })
      }
    })()
    this.listing = listing
    return listing
  }
}
const lists = new WeakMap<HarnessAPI, ProjectList>()
function projectList(api: HarnessAPI): ProjectList {
  let list = lists.get(api)
  if (!list) {
    list = new ProjectList(api)
    lists.set(api, list)
  }
  return list
}
export function useProjects({ autoLoad = true }: { autoLoad?: boolean } = {}) {
  const { api, keyReady } = useHarness()
  const list = projectList(api)
  const { projects, loading, error } = useSyncExternalStore(
    list.subscribe,
    list.read,
    list.read,
  )
  useEffect(() => {
    if (autoLoad) void list.load()
  }, [autoLoad, list, keyReady])
  const refresh = useCallback(() => list.refresh(), [list])
  return { projects, loading, error, refresh, loadProjects: refresh }
}
