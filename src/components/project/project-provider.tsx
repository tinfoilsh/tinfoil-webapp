import { OptimisticStore } from '@/services/harness/optimistic-store'
import { useHarness } from '@/services/harness/provider'
import type {
  Project,
  ProjectContextUsage,
  ProjectDocument,
} from '@/types/project'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
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
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null)
  const projects = useSyncExternalStore(
    api.projects.subscribe,
    api.projects.getSnapshot,
    api.projects.getSnapshot,
  )
  const activeProject =
    projects.find((project) => project.id === activeProjectId) ?? null
  const documents = useMemo(
    () => new OptimisticStore<ProjectDocument[]>([]),
    // Keep documents and pending edits scoped to this account.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api],
  )
  const projectDocuments = useSyncExternalStore(
    documents.subscribe,
    documents.getSnapshot,
    documents.getSnapshot,
  )
  const [usage, setUsage] = useState(emptyUsage)
  const [loadingProject, setLoadingProject] = useState<LoadingProject | null>(
    null,
  )
  const [error, setError] = useState<string | null>(null)
  const [uploadingFiles, setUploadingFiles] = useState<UploadingFile[]>([])
  const generation = useRef(0)
  const select = useRef<string | null>(null)
  const readProject = useCallback(
    async (id: string, isCurrent: () => boolean) => {
      let loaded!: Project & {
        documents: ProjectDocument[]
        contextUsage: ProjectContextUsage
      }
      await api.projects.read(
        async () => {
          loaded = await api.post('/v1/projects/get', { id })
          if (!isCurrent())
            throw new DOMException('Project changed', 'AbortError')
          return [loaded]
        },
        api.signal(),
        (all, [project]) =>
          all.some((item) => item.id === id)
            ? all.map((item) => (item.id === id ? project : item))
            : [...all, project],
      )
      return loaded
    },
    [api],
  )
  const enterProjectMode = useCallback<ProjectContextValue['enterProjectMode']>(
    async (id, name, options) => {
      const version = ++generation.current
      select.current = id
      setActiveProjectId(id)
      documents.reset([])
      setLoadingProject({ id, name: name ?? 'Loading…' })
      try {
        const project = await readProject(
          id,
          () =>
            version === generation.current && options?.isCurrent?.() !== false,
        )
        if (version !== generation.current || options?.isCurrent?.() === false)
          return false
        documents.set(() => project.documents)
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
    [documents, readProject],
  )
  const exitProjectMode = useCallback(() => {
    generation.current++
    select.current = null
    setActiveProjectId(null)
    documents.reset([])
    setLoadingProject(null)
    setUploadingFiles([])
    setUsage(emptyUsage)
  }, [documents])
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
    if (!activeProject) return
    const id = activeProject.id
    const version = generation.current
    await documents.read(async () => {
      const project = await readProject(
        id,
        () => version === generation.current && select.current === id,
      )
      if (version !== generation.current || select.current !== id)
        throw new DOMException('Project changed', 'AbortError')
      setUsage(project.contextUsage)
      return project.documents
    }, api.signal())
  }
  const saveMemory = (id: string, facts: Project['memory']) =>
    api.projects.mutate(
      (all) =>
        all.map((project) =>
          project.id === id ? { ...project, memory: facts } : project,
        ),
      () =>
        api.post<{ facts: Project['memory'] }>('/v1/projects/memory/update', {
          projectId: id,
          facts,
        }),
      api.signal(),
      (all, saved) =>
        all.map((project) =>
          project.id === id ? { ...project, memory: saved.facts } : project,
        ),
    )
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
      setLoadingProject({ id: '', name: data.name })
      const version = generation.current
      try {
        return await api.projects.mutate(
          (all) => all,
          () =>
            api.post<Project>(
              '/v1/projects/create',
              data as unknown as Record<string, unknown>,
            ),
          api.signal(),
          (all, project) => [
            project,
            ...all.filter((item) => item.id !== project.id),
          ],
        )
      } finally {
        if (version === generation.current) setLoadingProject(null)
      }
    },
    updateProject: async (id, data) => {
      const { memory, ...patch } = data
      const saving = api.projects.mutate(
        (all) =>
          all.map((project) =>
            project.id === id ? { ...project, ...patch } : project,
          ),
        () => api.post<Project>('/v1/projects/update', { id, ...patch }),
        api.signal(),
        (all, saved) =>
          all.map((project) =>
            project.id === id ? { ...project, ...saved } : project,
          ),
      )
      await Promise.all([saving, memory ? saveMemory(id, memory) : undefined])
    },
    deleteProject: async (id) => {
      await api.projects.mutate(
        (all) => all.filter((project) => project.id !== id),
        () => api.post('/v1/projects/delete', { id }),
        api.signal(),
      )
      if (select.current === id) exitProjectMode()
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
      await documents.mutate(
        (all) => all.filter((document) => document.id !== documentId),
        () =>
          api.post('/v1/projects/documents/delete', {
            projectId: activeProject.id,
            documentId,
          }),
        api.signal(),
      )
      await refreshDocuments()
    },
    refreshDocuments,
    updateProjectMemory: async (facts) => {
      if (!activeProject) return
      await saveMemory(activeProject.id, facts)
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
