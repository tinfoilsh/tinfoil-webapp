import { useHarness } from '@/services/harness/provider'
import { reportHarnessError } from '@/services/harness/runtime'
import type { Project } from '@/types/project'
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
export const PROJECTS_CHANGED = 'harness-projects-changed'
export function useProjects({ autoLoad = true }: { autoLoad?: boolean } = {}) {
  const { api, keyReady } = useHarness()
  const projects = useSyncExternalStore(
    api.projects.subscribe,
    api.projects.getSnapshot,
    api.projects.getSnapshot,
  )
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const refresh = useCallback(async () => {
    if (!api.userId || !keyReady) {
      return
    }
    setLoading(true)
    try {
      await api.projects.read(async () => {
        const all: Project[] = []
        let cursor: string | null = null
        do {
          const page: { projects: Project[]; nextCursor: string | null } =
            await api.post('/v1/projects/list', { cursor })
          all.push(...page.projects)
          cursor = page.nextCursor
        } while (cursor)
        return all
      }, api.signal())
      setError(null)
    } catch (cause) {
      if (!api.lifetime.signal.aborted)
        setError(
          cause instanceof Error ? cause.message : 'Unable to load projects.',
        )
      throw cause
    } finally {
      if (!api.lifetime.signal.aborted) setLoading(false)
    }
  }, [api, keyReady])
  useEffect(() => {
    if (autoLoad && !api.projects.hasLoaded)
      void refresh().catch(reportHarnessError)
    const changed = () => {
      void refresh().catch(reportHarnessError)
    }
    window.addEventListener(PROJECTS_CHANGED, changed)
    return () => window.removeEventListener(PROJECTS_CHANGED, changed)
  }, [api, autoLoad, refresh])
  return { projects, loading, error, refresh, loadProjects: refresh }
}
