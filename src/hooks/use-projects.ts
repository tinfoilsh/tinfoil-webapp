import { useHarness } from '@/services/harness/provider'
import type { Project } from '@/types/project'
import { logError } from '@/utils/error-handling'
import { useCallback, useEffect, useRef, useState } from 'react'
export const PROJECTS_CHANGED = 'harness-projects-changed'
export function useProjects({ autoLoad = true }: { autoLoad?: boolean } = {}) {
  const { api, keyReady } = useHarness()
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Only the latest refresh applies, so a list read before a change cannot
  // replace the list read after it.
  const generation = useRef(0)
  // A failed refresh keeps its error here and resolves, since callers start
  // one without waiting for it.
  const refresh = useCallback(async () => {
    const version = ++generation.current
    const isCurrent = () =>
      version === generation.current && !api.lifetime.signal.aborted
    if (!api.userId || !keyReady) {
      setProjects([])
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const all: Project[] = []
      let cursor: string | null = null
      do {
        const page: { projects: Project[]; nextCursor: string | null } =
          await api.post('/v1/projects/list', { cursor })
        all.push(...page.projects)
        cursor = page.nextCursor
      } while (cursor)
      if (!isCurrent()) return
      setProjects(all)
      setError(null)
    } catch (cause) {
      if (!isCurrent()) return
      setError(
        cause instanceof Error ? cause.message : 'Unable to load projects.',
      )
      logError('Failed to load projects', cause, {
        component: 'useProjects',
        action: 'refresh',
      })
    } finally {
      if (isCurrent()) setLoading(false)
    }
  }, [api, keyReady])
  useEffect(() => {
    if (autoLoad) void refresh()
    const changed = () => {
      void refresh()
    }
    window.addEventListener(PROJECTS_CHANGED, changed)
    return () => window.removeEventListener(PROJECTS_CHANGED, changed)
  }, [autoLoad, refresh])
  return { projects, loading, error, refresh, loadProjects: refresh }
}
