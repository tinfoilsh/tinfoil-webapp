import { PROJECTS_CHANGED } from '@/hooks/use-projects'
import { useHarness } from '@/services/harness/provider'
import type {
  Project,
  ProjectContextUsage,
  ProjectDocument,
} from '@/types/project'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  ProjectContext,
  type LoadingProject,
  type ProjectContextValue,
  type UploadingFile,
} from './project-context'
const emptyUsage: ProjectContextUsage = {
  systemInstructions: 0,
  documents: [],
  memory: 0,
  totalUsed: 0,
  modelLimit: 0,
  availableForChat: 0,
}
export function ProjectProvider({
  children,
  initialProjectId,
}: {
  children: ReactNode
  initialProjectId?: string | null
}) {
  const { api, keyReady } = useHarness()
  const [activeProject, setActiveProject] = useState<Project | null>(null)
  const [projectDocuments, setProjectDocuments] = useState<ProjectDocument[]>(
    [],
  )
  const [usage, setUsage] = useState(emptyUsage)
  const [loadingProject, setLoadingProject] = useState<LoadingProject | null>(
    null,
  )
  const [error, setError] = useState<string | null>(null)
  const [uploadingFiles, setUploadingFiles] = useState<UploadingFile[]>([])
  const generation = useRef(0)
  const changed = () => window.dispatchEvent(new Event(PROJECTS_CHANGED))
  const enterProjectMode = useCallback<ProjectContextValue['enterProjectMode']>(
    async (id, name, options) => {
      const version = ++generation.current
      setLoadingProject({ id, name: name ?? 'Loading…' })
      try {
        const project = await api.post<
          Project & {
            documents: ProjectDocument[]
            contextUsage: ProjectContextUsage
          }
        >('/v1/projects/get', { id })
        if (version !== generation.current || options?.isCurrent?.() === false)
          return false
        setActiveProject(project)
        setProjectDocuments(project.documents)
        setUsage(project.contextUsage)
        setError(null)
        return true
      } catch (cause) {
        if (version === generation.current)
          setError(
            cause instanceof Error ? cause.message : 'Unable to load project.',
          )
        return false
      } finally {
        if (version === generation.current) setLoadingProject(null)
      }
    },
    [api],
  )
  const exitProjectMode = useCallback(() => {
    generation.current++
    setActiveProject(null)
    setProjectDocuments([])
    setLoadingProject(null)
    setUploadingFiles([])
    setUsage(emptyUsage)
  }, [])
  useEffect(() => {
    if (initialProjectId && keyReady) void enterProjectMode(initialProjectId)
  }, [initialProjectId, keyReady, enterProjectMode])
  useEffect(() => {
    if (!keyReady) exitProjectMode()
    const tracker = generation
    return () => {
      tracker.current++
    }
  }, [keyReady, exitProjectMode])
  const refreshDocuments = async () => {
    if (activeProject) await enterProjectMode(activeProject.id)
  }
  const value: ProjectContextValue = {
    activeProject,
    isProjectMode: !!activeProject,
    projectDocuments,
    loading: !!loadingProject,
    loadingProject,
    error,
    uploadingFiles,
    enterProjectMode,
    exitProjectMode,
    createProject: async (data) => {
      const project = await api.post<Project>(
        '/v1/projects/create',
        data as unknown as Record<string, unknown>,
      )
      changed()
      return project
    },
    updateProject: async (id, data) => {
      const { memory, ...patch } = data
      await api.post('/v1/projects/update', { id, ...patch })
      if (memory)
        await api.post('/v1/projects/memory/update', {
          projectId: id,
          facts: memory,
        })
      if (id === activeProject?.id) await enterProjectMode(id)
      changed()
    },
    deleteProject: async (id) => {
      await api.post('/v1/projects/delete', { id })
      if (activeProject?.id === id) exitProjectMode()
      changed()
    },
    uploadDocument: async (file) => {
      if (!activeProject) throw new Error('Select a project first.')
      const doc = await api.upload<ProjectDocument>(
        '/v1/projects/documents/upload',
        file,
        { projectId: activeProject.id },
      )
      await refreshDocuments()
      return doc
    },
    removeDocument: async (documentId) => {
      if (!activeProject) return
      await api.post('/v1/projects/documents/delete', {
        projectId: activeProject.id,
        documentId,
      })
      await refreshDocuments()
    },
    refreshDocuments,
    updateProjectMemory: async (facts) => {
      if (!activeProject) return
      const result = await api.post<{ facts: Project['memory'] }>(
        '/v1/projects/memory/update',
        { projectId: activeProject.id, facts },
      )
      setActiveProject({ ...activeProject, memory: result.facts })
    },
    addUploadingFile: (file) =>
      setUploadingFiles((previous) => [...previous, file]),
    removeUploadingFile: (id) =>
      setUploadingFiles((previous) =>
        previous.filter((file) => file.id !== id),
      ),
    getContextUsage: () => usage,
  }
  return (
    <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>
  )
}
