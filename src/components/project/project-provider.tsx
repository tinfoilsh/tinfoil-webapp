import { PROJECTS_CHANGED } from '@/hooks/use-projects'
import { useSubscriptionStatus } from '@/hooks/use-subscription-status'
import { checkUploadSize } from '@/services/harness/composer'
import * as projects from '@/services/harness/projects'
import { useHarness } from '@/services/harness/provider'
import type { Project, ProjectDocument } from '@/types/project'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  ProjectContext,
  type LoadingProject,
  type ProjectContextValue,
  type UploadingFile,
} from './project-context'
export function ProjectProvider({
  children,
  initialProjectId,
}: {
  children: ReactNode
  initialProjectId?: string | null
}) {
  const { api, keyReady, session } = useHarness()
  const { isLoading: isSubscriptionLoading, chat_subscription_active } =
    useSubscriptionStatus()
  const hasPremiumAccess = !isSubscriptionLoading && chat_subscription_active
  const hasPremiumAccessRef = useRef(hasPremiumAccess)
  hasPremiumAccessRef.current = hasPremiumAccess
  const [activeProject, setActiveProject] = useState<Project | null>(null)
  const [projectDocuments, setProjectDocuments] = useState<ProjectDocument[]>(
    [],
  )
  const [loadingProject, setLoadingProject] = useState<LoadingProject | null>(
    null,
  )
  const [error, setError] = useState<string | null>(null)
  const [uploadingFiles, setUploadingFiles] = useState<UploadingFile[]>([])
  const generation = useRef(0)
  // The project the user opened last. A change to another project that
  // finishes later must not reopen that one.
  const openProjectId = useRef<string | null>(null)
  const changed = () => window.dispatchEvent(new Event(PROJECTS_CHANGED))
  const requirePremiumAccess = useCallback(() => {
    if (!hasPremiumAccessRef.current) {
      throw new Error('Premium project access is required')
    }
  }, [])
  const enterProjectMode = useCallback<ProjectContextValue['enterProjectMode']>(
    async (id, name, options) => {
      if (!hasPremiumAccessRef.current) return false
      openProjectId.current = id
      const version = ++generation.current
      setLoadingProject({ id, name: name ?? 'Loading…' })
      try {
        const project = await projects.getProject(api, id)
        if (
          version !== generation.current ||
          !hasPremiumAccessRef.current ||
          options?.isCurrent?.() === false
        )
          return false
        setActiveProject(project)
        setProjectDocuments(project.documents)
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
    openProjectId.current = null
    setActiveProject(null)
    setProjectDocuments([])
    setLoadingProject(null)
    setUploadingFiles([])
  }, [])
  useEffect(() => {
    if (initialProjectId && keyReady && hasPremiumAccess)
      void enterProjectMode(initialProjectId)
  }, [initialProjectId, keyReady, hasPremiumAccess, enterProjectMode])
  useEffect(() => {
    if (!isSubscriptionLoading && !chat_subscription_active) exitProjectMode()
  }, [chat_subscription_active, isSubscriptionLoading, exitProjectMode])
  useEffect(() => {
    if (!keyReady) exitProjectMode()
    const tracker = generation
    return () => {
      tracker.current++
    }
  }, [keyReady, exitProjectMode])
  // Reloads a changed project, unless the user has opened another since.
  const reloadProject = async (id: string) => {
    if (openProjectId.current === id) await enterProjectMode(id)
  }
  const refreshDocuments = useCallback(async () => {
    requirePremiumAccess()
    if (openProjectId.current) await enterProjectMode(openProjectId.current)
  }, [enterProjectMode, requirePremiumAccess])
  const value: ProjectContextValue = {
    activeProject: hasPremiumAccess ? activeProject : null,
    isProjectMode: hasPremiumAccess && !!activeProject,
    projectDocuments: hasPremiumAccess ? projectDocuments : [],
    loading: !!loadingProject,
    loadingProject,
    error,
    uploadingFiles,
    enterProjectMode,
    exitProjectMode,
    createProject: async (data) => {
      requirePremiumAccess()
      const project = await projects.createProject(api, data)
      changed()
      return project
    },
    updateProject: async (id, data) => {
      requirePremiumAccess()
      await projects.updateProject(api, id, data)
      await reloadProject(id)
      changed()
    },
    deleteProject: async (id) => {
      requirePremiumAccess()
      await projects.deleteProject(api, id)
      if (activeProject?.id === id) exitProjectMode()
      changed()
    },
    uploadDocument: async (file) => {
      requirePremiumAccess()
      if (!activeProject) throw new Error('Select a project first.')
      if (session)
        checkUploadSize(file, session.composer.projectDocuments.maxBytes)
      const projectId = activeProject.id
      const doc = await projects.uploadProjectDocument(api, projectId, file)
      await reloadProject(projectId)
      return doc
    },
    removeDocument: async (documentId) => {
      requirePremiumAccess()
      if (!activeProject) return
      const projectId = activeProject.id
      await projects.deleteProjectDocument(api, projectId, documentId)
      await reloadProject(projectId)
    },
    refreshDocuments,
    addUploadingFile: (file) =>
      setUploadingFiles((previous) => [...previous, file]),
    removeUploadingFile: (id) =>
      setUploadingFiles((previous) =>
        previous.filter((file) => file.id !== id),
      ),
  }
  return (
    <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>
  )
}
