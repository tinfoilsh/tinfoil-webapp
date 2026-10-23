import { UI_EXPAND_PROJECTS_ON_MOUNT } from '@/constants/storage-keys'
import { PROJECTS_CHANGED } from '@/hooks/use-projects'
import { useSubscriptionStatus } from '@/hooks/use-subscription-status'
import * as projects from '@/services/harness/projects'
import { useHarness } from '@/services/harness/provider'
import type { Project, ProjectDocument } from '@/types/project'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  ProjectContext,
  type EnterProjectModeOptions,
  type LoadingProject,
  type ProjectContextValue,
  type UploadingFile,
} from './project-context'
// The name a project shows until it loads.
const LOADING_PROJECT_NAME = 'Loading...'
export function ProjectProvider({
  children,
  initialProjectId,
}: {
  children: ReactNode
  initialProjectId?: string | null
}) {
  const { api, keyReady, projectRevision } = useHarness()
  const { isLoading: isSubscriptionLoading, chat_subscription_active } =
    useSubscriptionStatus()
  const hasPremiumAccess = !isSubscriptionLoading && chat_subscription_active
  const hasPremiumAccessRef = useRef(hasPremiumAccess)
  hasPremiumAccessRef.current = hasPremiumAccess
  const [activeProject, setActiveProject] = useState<Project | null>(null)
  const [projectDocuments, setProjectDocuments] = useState<ProjectDocument[]>(
    [],
  )
  // A project's route shows it loading until the content key opens it.
  const [loadingProject, setLoadingProject] = useState<LoadingProject | null>(
    initialProjectId
      ? { id: initialProjectId, name: LOADING_PROJECT_NAME }
      : null,
  )
  const [error, setError] = useState<string | null>(null)
  const [uploadingFiles, setUploadingFiles] = useState<UploadingFile[]>([])
  const generation = useRef(0)
  // The project the user opened last. A change to another project that
  // finishes later must not reopen that one.
  const openProjectId = useRef<string | null>(null)
  const committedProjectId = useRef<string | null>(null)
  const previousInitialProjectId = useRef(initialProjectId)
  // Documents being removed, which a project read before their removal
  // finished must not show again.
  const removingDocuments = useRef(new Set<string>())
  const changed = () => window.dispatchEvent(new Event(PROJECTS_CHANGED))
  const requirePremiumAccess = useCallback(() => {
    if (!hasPremiumAccessRef.current) {
      throw new Error('Premium project access is required')
    }
  }, [])
  // Opens a project, or with `refresh` reloads the open one without showing
  // it loading, so its controls stay usable.
  const loadProject = useCallback(
    async (
      id: string,
      {
        name,
        isCurrent,
        refresh = false,
      }: EnterProjectModeOptions & { name?: string; refresh?: boolean } = {},
    ) => {
      if (!hasPremiumAccessRef.current) return false
      openProjectId.current = id
      const version = ++generation.current
      if (!refresh)
        setLoadingProject({ id, name: name ?? LOADING_PROJECT_NAME })
      try {
        const project = await projects.getProject(api, id)
        if (
          version !== generation.current ||
          !hasPremiumAccessRef.current ||
          isCurrent?.() === false
        )
          return false
        committedProjectId.current = project.id
        setActiveProject(project)
        setProjectDocuments(
          project.documents.filter(
            (doc) => !removingDocuments.current.has(doc.id),
          ),
        )
        setError(null)
        return true
      } catch (cause) {
        if (version === generation.current) {
          openProjectId.current = committedProjectId.current
          setError(
            cause instanceof Error ? cause.message : 'Unable to load project.',
          )
        }
        return false
      } finally {
        if (version === generation.current) setLoadingProject(null)
      }
    },
    [api],
  )
  const enterProjectMode = useCallback<ProjectContextValue['enterProjectMode']>(
    (id, name, options) => loadProject(id, { ...options, name }),
    [loadProject],
  )
  const closeProject = useCallback(() => {
    generation.current++
    openProjectId.current = null
    committedProjectId.current = null
    setActiveProject(null)
    setProjectDocuments([])
    setLoadingProject(null)
    setUploadingFiles([])
  }, [])
  // Leaving a project opens the project list in the chat sidebar.
  const exitProjectMode = useCallback(() => {
    if (activeProject || loadingProject)
      sessionStorage.setItem(UI_EXPAND_PROJECTS_ON_MOUNT, 'true')
    closeProject()
  }, [activeProject, loadingProject, closeProject])
  useEffect(() => {
    const left = previousInitialProjectId.current
    const routeChanged = left !== initialProjectId
    // Leaving a project's route closes it, unless another project has been
    // opened since.
    const exited =
      left && !initialProjectId && (openProjectId.current ?? left) === left
    previousInitialProjectId.current = initialProjectId
    if (exited) closeProject()
    if (
      initialProjectId &&
      keyReady &&
      hasPremiumAccess &&
      !(
        routeChanged &&
        committedProjectId.current === initialProjectId &&
        openProjectId.current === initialProjectId
      )
    )
      void enterProjectMode(initialProjectId)
  }, [
    initialProjectId,
    keyReady,
    hasPremiumAccess,
    enterProjectMode,
    closeProject,
  ])
  useEffect(() => {
    if (
      projectRevision &&
      keyReady &&
      hasPremiumAccess &&
      committedProjectId.current &&
      openProjectId.current === committedProjectId.current
    ) {
      void loadProject(committedProjectId.current, { refresh: true })
    }
  }, [projectRevision, keyReady, hasPremiumAccess, loadProject])
  useEffect(() => {
    if (!isSubscriptionLoading && !chat_subscription_active) closeProject()
  }, [chat_subscription_active, isSubscriptionLoading, closeProject])
  const keyWasReady = useRef(keyReady)
  useEffect(() => {
    // A project closes once the key is lost; the route's project waits for
    // the key to arrive.
    if (!keyReady && keyWasReady.current) closeProject()
    keyWasReady.current = keyReady
    const tracker = generation
    return () => {
      tracker.current++
    }
  }, [keyReady, closeProject])
  // Reloads a changed project, unless the user has opened another since.
  const reloadProject = async (id: string) => {
    if (openProjectId.current === id) await loadProject(id, { refresh: true })
  }
  const refreshDocuments = useCallback(async () => {
    requirePremiumAccess()
    if (openProjectId.current)
      await loadProject(openProjectId.current, { refresh: true })
  }, [loadProject, requirePremiumAccess])
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
      const projectId = activeProject.id
      const doc = await projects.uploadProjectDocument(api, projectId, file)
      await reloadProject(projectId)
      return doc
    },
    // The document leaves the list at once, and returns if its removal fails.
    removeDocument: async (documentId) => {
      requirePremiumAccess()
      if (!activeProject || removingDocuments.current.has(documentId)) return
      const projectId = activeProject.id
      const removed = projectDocuments.find((doc) => doc.id === documentId)
      removingDocuments.current.add(documentId)
      setProjectDocuments((previous) =>
        previous.filter((doc) => doc.id !== documentId),
      )
      try {
        await projects.deleteProjectDocument(api, projectId, documentId)
      } catch (cause) {
        if (removed && committedProjectId.current === projectId)
          setProjectDocuments((previous) =>
            previous.some((doc) => doc.id === documentId)
              ? previous
              : [...previous, removed],
          )
        throw cause
      } finally {
        removingDocuments.current.delete(documentId)
      }
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
