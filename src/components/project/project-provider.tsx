'use client'

import {
  SYNC_PROJECTS_INVALIDATED,
  UI_EXPAND_PROJECTS_ON_MOUNT,
} from '@/constants/storage-keys'
import { useMemory } from '@/hooks/use-memory'
import { useSubscriptionStatus } from '@/hooks/use-subscription-status'
import { projectStorage } from '@/services/cloud/project-storage'
import { projectEvents } from '@/services/project/project-events'
import { projectCache } from '@/services/storage/project-cache'
import type { Fact, MemoryState } from '@/types/memory'
import type {
  CreateProjectData,
  Project,
  ProjectContextUsage,
  ProjectDocument,
  UpdateProjectData,
} from '@/types/project'
import { logError, logInfo } from '@/utils/error-handling'
import { useAuth } from '@clerk/nextjs'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  buildProjectContext,
  estimateTokenCount,
  ProjectContext,
  type EnterProjectModeOptions,
  type LoadingProject,
  type ProjectContextValue,
  type UploadingFile,
} from './project-context'
import { hydrateProjectDocuments } from './project-document-hydration'
import { canCommitProjectLoad } from './project-load-validity'

interface ProjectProviderProps {
  children: React.ReactNode
  initialProjectId?: string | null
}

export function ProjectProvider({
  children,
  initialProjectId,
}: ProjectProviderProps) {
  const { isSignedIn, isLoaded, userId } = useAuth()
  const { isLoading: isSubscriptionLoading, chat_subscription_active } =
    useSubscriptionStatus()
  const hasPremiumAccess = !isSubscriptionLoading && chat_subscription_active
  const hasPremiumAccessRef = useRef(hasPremiumAccess)
  hasPremiumAccessRef.current = hasPremiumAccess
  const [activeProject, setActiveProject] = useState<Project | null>(null)
  const [projectDocuments, setProjectDocuments] = useState<ProjectDocument[]>(
    [],
  )
  const [loading, setLoading] = useState(Boolean(initialProjectId))
  const [loadingProject, setLoadingProject] = useState<LoadingProject | null>(
    initialProjectId ? { id: initialProjectId, name: 'Loading...' } : null,
  )
  const [error, setError] = useState<string | null>(null)
  const [uploadingFiles, setUploadingFiles] = useState<UploadingFile[]>([])
  const initializingRef = useRef(false)
  const initialProjectLoadedRef = useRef(false)
  const pendingProjectIdRef = useRef<string | null>(null)
  const committedProjectIdRef = useRef<string | null>(null)
  const projectLoadGenerationRef = useRef(0)
  const documentRefreshGenerationRef = useRef(0)
  const documentMutationGenerationRef = useRef(0)

  const isProjectMode = activeProject !== null

  const requirePremiumAccess = useCallback(() => {
    if (!hasPremiumAccessRef.current) {
      throw new Error('Premium project access is required')
    }
  }, [])

  const resetProjectSessionState = useCallback(() => {
    projectLoadGenerationRef.current += 1
    documentRefreshGenerationRef.current += 1
    documentMutationGenerationRef.current += 1
    pendingProjectIdRef.current = null
    committedProjectIdRef.current = null
    setActiveProject(null)
    setProjectDocuments([])
    setUploadingFiles([])
    setError(null)
    setLoading(false)
    setLoadingProject(null)
  }, [])

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key === SYNC_PROJECTS_INVALIDATED) {
        resetProjectSessionState()
      }
    }
    const unsubscribe = projectEvents.on('projects-invalidated', () => {
      resetProjectSessionState()
    })
    window.addEventListener('storage', handleStorage)
    return () => {
      unsubscribe()
      window.removeEventListener('storage', handleStorage)
    }
  }, [resetProjectSessionState])

  useEffect(() => {
    if (isSignedIn && !initializingRef.current) {
      initializingRef.current = true
    } else if (isLoaded && !isSignedIn) {
      initializingRef.current = false
      initialProjectLoadedRef.current = false
      // Clear all user-specific state on logout to prevent data leaking across sessions
      resetProjectSessionState()
    }
  }, [isLoaded, isSignedIn, resetProjectSessionState])

  useEffect(() => {
    if (!isSubscriptionLoading && !chat_subscription_active) {
      resetProjectSessionState()
    }
  }, [
    chat_subscription_active,
    isSubscriptionLoading,
    resetProjectSessionState,
  ])

  // Memory callbacks for useMemory hook
  const memoryCallbacks = useMemo(
    () => ({
      onSave: async (memory: MemoryState) => {
        requirePremiumAccess()
        if (!activeProject) return
        const cacheSessionGeneration = projectCache.captureGeneration()
        const updatedProjectFromStorage = await projectStorage.updateProject(
          activeProject.id,
          {
            memory: memory.facts,
          },
        )
        const updatedProject = {
          ...updatedProjectFromStorage,
          createdAt: activeProject.createdAt,
        }
        setActiveProject((prev) =>
          prev && prev.id === activeProject.id ? updatedProject : prev,
        )
        const cacheGeneration = projectCache.commitMutation(
          cacheSessionGeneration,
        )
        if (userId && cacheGeneration !== null) {
          void projectCache
            .saveProject(userId, updatedProject, cacheGeneration)
            .catch((error) =>
              logError('Failed to cache updated project', error, {
                component: 'ProjectProvider',
                action: 'cacheProjectMemory',
                metadata: { projectId: activeProject.id },
              }),
            )
        }
      },
      onLoad: async (): Promise<MemoryState> => {
        return {
          facts: activeProject?.memory || [],
          lastProcessedTimestamp: null,
        }
      },
    }),
    [activeProject, requirePremiumAccess, userId],
  )

  const { processMessages, loadMemory } = useMemory({
    callbacks: memoryCallbacks,
    enabled: !!activeProject && hasPremiumAccess,
  })

  // Load memory when project changes
  const activeProjectId = activeProject?.id
  useEffect(() => {
    if (activeProjectId) {
      loadMemory()
    }
  }, [activeProjectId, loadMemory])

  // Listen for memory update events
  useEffect(() => {
    if (!activeProject) return

    const unsubscribe = projectEvents.on(
      'memory-update-needed',
      async (event) => {
        if (event.projectId !== activeProject.id) return

        logInfo('Processing memory update event', {
          component: 'ProjectProvider',
          action: 'memoryUpdateEvent',
          metadata: { projectId: event.projectId },
        })

        await processMessages(event.messages)
      },
    )

    return unsubscribe
  }, [activeProject, processMessages])

  const enterProjectMode = useCallback(
    async (
      projectId: string,
      projectName?: string,
      options?: EnterProjectModeOptions,
    ): Promise<boolean> => {
      if (!hasPremiumAccessRef.current) return false
      const generation = projectLoadGenerationRef.current + 1
      const cacheGeneration = projectCache.captureGeneration()
      projectLoadGenerationRef.current = generation
      documentRefreshGenerationRef.current += 1
      pendingProjectIdRef.current = projectId
      setLoading(true)
      setError(null)
      setUploadingFiles([])
      setLoadingProject({ id: projectId, name: projectName || 'Loading...' })

      try {
        const cachedProjectPromise = userId
          ? projectCache
              .getProjects(userId)
              .then(
                (cachedProjects) =>
                  cachedProjects.find((project) => project.id === projectId) ??
                  null,
              )
              .catch(() => null)
          : Promise.resolve(null)
        const remoteProject = await projectStorage.getProject(projectId)
        if (!remoteProject) {
          throw new Error('Project not found')
        }
        const cachedProject = await cachedProjectPromise
        const project = cachedProject
          ? {
              ...remoteProject,
              createdAt: cachedProject.createdAt,
              updatedAt:
                cachedProject.syncVersion === remoteProject.syncVersion
                  ? cachedProject.updatedAt
                  : remoteProject.updatedAt,
            }
          : remoteProject
        if (userId) {
          void projectCache
            .saveProject(userId, project, cacheGeneration)
            .catch((error) =>
              logError('Failed to cache opened project', error, {
                component: 'ProjectProvider',
                action: 'cacheOpenedProject',
                metadata: { projectId },
              }),
            )
        }

        const documentsResponse = await projectStorage.listDocuments(projectId)

        const fullById = await projectStorage.getDocuments(
          projectId,
          documentsResponse.documents.map((doc) => doc.id),
        )

        const documents = hydrateProjectDocuments(
          documentsResponse.documents,
          fullById,
        )

        if (
          !hasPremiumAccessRef.current ||
          !canCommitProjectLoad(
            generation,
            projectLoadGenerationRef.current,
            projectId,
            pendingProjectIdRef.current,
            options?.isCurrent,
          )
        ) {
          if (projectLoadGenerationRef.current === generation) {
            pendingProjectIdRef.current = committedProjectIdRef.current
          }
          return false
        }

        committedProjectIdRef.current = projectId
        setActiveProject(project)
        setProjectDocuments(documents)

        logInfo('Entered project mode', {
          component: 'ProjectProvider',
          action: 'enterProjectMode',
          metadata: { projectId, documentCount: documents.length },
        })
        return true
      } catch (err) {
        if (projectLoadGenerationRef.current !== generation) return false
        pendingProjectIdRef.current = committedProjectIdRef.current
        if (options?.isCurrent && !options.isCurrent()) return false
        const message =
          err instanceof Error ? err.message : 'Failed to load project'
        setError(message)
        logError('Failed to enter project mode', err, {
          component: 'ProjectProvider',
          action: 'enterProjectMode',
          metadata: { projectId },
        })
        return false
      } finally {
        if (projectLoadGenerationRef.current === generation) {
          setLoading(false)
          setLoadingProject(null)
        }
      }
    },
    [userId],
  )

  // Load initial project from URL if provided
  useEffect(() => {
    if (
      initialProjectId &&
      isSignedIn &&
      hasPremiumAccess &&
      !initialProjectLoadedRef.current &&
      !activeProject
    ) {
      initialProjectLoadedRef.current = true
      enterProjectMode(initialProjectId).then((success) => {
        if (!success) {
          initialProjectLoadedRef.current = false
        }
      })
    }
  }, [
    initialProjectId,
    isSignedIn,
    hasPremiumAccess,
    activeProject,
    enterProjectMode,
  ])

  const exitProjectMode = useCallback(() => {
    resetProjectSessionState()

    // Signal to ChatSidebar that projects should be expanded
    sessionStorage.setItem(UI_EXPAND_PROJECTS_ON_MOUNT, 'true')

    logInfo('Exited project mode', {
      component: 'ProjectProvider',
      action: 'exitProjectMode',
    })
  }, [resetProjectSessionState])

  const createProject = useCallback(
    async (data: CreateProjectData): Promise<Project> => {
      requirePremiumAccess()
      setLoading(true)
      setError(null)
      const cacheSessionGeneration = projectCache.captureGeneration()

      try {
        const project = await projectStorage.createProject(data)
        const cacheGeneration = projectCache.commitMutation(
          cacheSessionGeneration,
        )
        if (userId && cacheGeneration !== null) {
          void projectCache
            .saveProject(userId, project, cacheGeneration)
            .catch((error) =>
              logError('Failed to cache created project', error, {
                component: 'ProjectProvider',
                action: 'cacheCreatedProject',
                metadata: { projectId: project.id },
              }),
            )
        }

        logInfo('Created project', {
          component: 'ProjectProvider',
          action: 'createProject',
          metadata: { projectId: project.id },
        })

        return project
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Failed to create project'
        setError(message)
        throw err
      } finally {
        setLoading(false)
      }
    },
    [requirePremiumAccess, userId],
  )

  const updateProject = useCallback(
    async (id: string, data: UpdateProjectData) => {
      requirePremiumAccess()
      setError(null)
      const cacheSessionGeneration = projectCache.captureGeneration()

      try {
        const updatedProjectFromStorage = await projectStorage.updateProject(
          id,
          data,
        )
        const updatedProject =
          activeProject?.id === id
            ? {
                ...updatedProjectFromStorage,
                createdAt: activeProject.createdAt,
              }
            : updatedProjectFromStorage

        setActiveProject((prev) =>
          prev && prev.id === id ? updatedProject : prev,
        )
        const cacheGeneration = projectCache.commitMutation(
          cacheSessionGeneration,
        )
        if (userId && cacheGeneration !== null) {
          void projectCache
            .saveProject(userId, updatedProject, cacheGeneration)
            .catch((error) =>
              logError('Failed to cache updated project', error, {
                component: 'ProjectProvider',
                action: 'cacheUpdatedProject',
                metadata: { projectId: id },
              }),
            )
        }

        logInfo('Updated project', {
          component: 'ProjectProvider',
          action: 'updateProject',
          metadata: { projectId: id },
        })
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Failed to update project'
        setError(message)
        throw err
      }
    },
    [activeProject, requirePremiumAccess, userId],
  )

  const deleteProject = useCallback(
    async (id: string) => {
      requirePremiumAccess()
      setError(null)
      const cacheSessionGeneration = projectCache.captureGeneration()

      try {
        await projectStorage.deleteProject(id)
        const cacheGeneration = projectCache.commitMutation(
          cacheSessionGeneration,
        )
        if (userId && cacheGeneration !== null) {
          void projectCache
            .deleteProject(userId, id, cacheGeneration)
            .catch((error) =>
              logError('Failed to remove cached project', error, {
                component: 'ProjectProvider',
                action: 'removeCachedProject',
                metadata: { projectId: id },
              }),
            )
        }

        if (activeProject && activeProject.id === id) {
          exitProjectMode()
        }

        logInfo('Deleted project', {
          component: 'ProjectProvider',
          action: 'deleteProject',
          metadata: { projectId: id },
        })
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Failed to delete project'
        setError(message)
        throw err
      }
    },
    [activeProject, exitProjectMode, requirePremiumAccess, userId],
  )

  const uploadDocument = useCallback(
    async (
      file: File,
      content: string,
      thumbnailBase64?: string,
    ): Promise<ProjectDocument> => {
      requirePremiumAccess()
      if (!activeProject) {
        throw new Error('No active project')
      }

      const projectId = activeProject.id
      documentRefreshGenerationRef.current += 1
      setError(null)

      try {
        const document = await projectStorage.uploadDocument(
          projectId,
          file.name,
          file.type || 'text/plain',
          content,
          file.size,
          thumbnailBase64,
        )

        documentMutationGenerationRef.current += 1
        if (committedProjectIdRef.current === projectId) {
          setProjectDocuments((prev) => [
            ...prev.filter((existing) => existing.id !== document.id),
            document,
          ])
        }

        logInfo('Uploaded document', {
          component: 'ProjectProvider',
          action: 'uploadDocument',
          metadata: {
            projectId,
            documentId: document.id,
            contentType: file.type || 'text/plain',
            sizeBytes: file.size,
          },
        })

        return document
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Failed to upload document'
        setError(message)
        throw err
      }
    },
    [activeProject, requirePremiumAccess],
  )

  const removeDocument = useCallback(
    async (docId: string) => {
      requirePremiumAccess()
      if (!activeProject) {
        throw new Error('No active project')
      }

      const projectId = activeProject.id
      documentRefreshGenerationRef.current += 1
      setError(null)

      const removedDoc = projectDocuments.find((doc) => doc.id === docId)

      setProjectDocuments((prev) => prev.filter((doc) => doc.id !== docId))

      try {
        await projectStorage.deleteDocument(projectId, docId)
        documentMutationGenerationRef.current += 1
        if (committedProjectIdRef.current === projectId) {
          setProjectDocuments((prev) =>
            prev.filter((document) => document.id !== docId),
          )
        }

        logInfo('Removed document', {
          component: 'ProjectProvider',
          action: 'removeDocument',
          metadata: { projectId, documentId: docId },
        })
      } catch (err) {
        documentMutationGenerationRef.current += 1
        if (removedDoc && committedProjectIdRef.current === projectId) {
          setProjectDocuments((prev) =>
            prev.some((document) => document.id === removedDoc.id)
              ? prev
              : [...prev, removedDoc],
          )
        }

        const message =
          err instanceof Error ? err.message : 'Failed to remove document'
        setError(message)
        throw err
      }
    },
    [activeProject, projectDocuments, requirePremiumAccess],
  )

  const refreshDocuments = useCallback(async () => {
    requirePremiumAccess()
    if (!activeProject) return
    const projectId = activeProject.id
    const generation = documentRefreshGenerationRef.current + 1
    documentRefreshGenerationRef.current = generation
    const mutationGeneration = documentMutationGenerationRef.current

    try {
      const documentsResponse = await projectStorage.listDocuments(projectId)

      const fullById = await projectStorage.getDocuments(
        projectId,
        documentsResponse.documents.map((doc) => doc.id),
      )

      if (
        documentRefreshGenerationRef.current !== generation ||
        documentMutationGenerationRef.current !== mutationGeneration ||
        committedProjectIdRef.current !== projectId
      ) {
        return
      }

      setProjectDocuments((previous) =>
        hydrateProjectDocuments(
          documentsResponse.documents,
          fullById,
          previous,
        ),
      )
    } catch (err) {
      if (documentRefreshGenerationRef.current !== generation) return
      logError('Failed to refresh documents', err, {
        component: 'ProjectProvider',
        action: 'refreshDocuments',
        metadata: { projectId },
      })
    }
  }, [activeProject, requirePremiumAccess])

  const updateProjectMemory = useCallback(
    async (memory: Fact[]) => {
      requirePremiumAccess()
      if (!activeProject) return

      await updateProject(activeProject.id, { memory })
    },
    [activeProject, requirePremiumAccess, updateProject],
  )

  const addUploadingFile = useCallback((file: UploadingFile) => {
    setUploadingFiles((prev) => [...prev, file])
  }, [])

  const removeUploadingFile = useCallback((id: string) => {
    setUploadingFiles((prev) => prev.filter((f) => f.id !== id))
  }, [])

  const getProjectSystemPrompt = useCallback((): string => {
    if (!hasPremiumAccess || !activeProject) return ''
    return buildProjectContext(activeProject, projectDocuments)
  }, [activeProject, hasPremiumAccess, projectDocuments])

  const getContextUsage = useCallback(
    (modelContextLimit: number): ProjectContextUsage => {
      if (!hasPremiumAccess || !activeProject) {
        return {
          systemInstructions: 0,
          documents: [],
          memory: 0,
          totalUsed: 0,
          modelLimit: modelContextLimit,
          availableForChat: modelContextLimit,
        }
      }

      const instructionsTokens = estimateTokenCount(
        activeProject.systemInstructions,
      )
      const memoryText = activeProject.memory
        ?.map((f) => `${f.category}: ${f.fact}`)
        .join('\n')
      const memoryTokens = estimateTokenCount(memoryText)

      const documentTokens = projectDocuments.map((doc) => ({
        filename: doc.filename,
        tokens: estimateTokenCount(doc.content),
      }))

      const totalDocumentTokens = documentTokens.reduce(
        (sum, d) => sum + d.tokens,
        0,
      )
      const totalUsed = instructionsTokens + totalDocumentTokens + memoryTokens

      return {
        systemInstructions: instructionsTokens,
        documents: documentTokens,
        memory: memoryTokens,
        totalUsed,
        modelLimit: modelContextLimit,
        availableForChat: Math.max(0, modelContextLimit - totalUsed),
      }
    },
    [activeProject, hasPremiumAccess, projectDocuments],
  )

  const contextValue: ProjectContextValue = useMemo(
    () => ({
      activeProject: hasPremiumAccess ? activeProject : null,
      isProjectMode: hasPremiumAccess && isProjectMode,
      projectDocuments: hasPremiumAccess ? projectDocuments : [],
      loading,
      loadingProject,
      error,
      uploadingFiles,
      enterProjectMode,
      exitProjectMode,
      createProject,
      updateProject,
      deleteProject,
      uploadDocument,
      removeDocument,
      refreshDocuments,
      updateProjectMemory,
      addUploadingFile,
      removeUploadingFile,
      getProjectSystemPrompt,
      getContextUsage,
    }),
    [
      activeProject,
      hasPremiumAccess,
      isProjectMode,
      projectDocuments,
      loading,
      loadingProject,
      error,
      uploadingFiles,
      enterProjectMode,
      exitProjectMode,
      createProject,
      updateProject,
      deleteProject,
      uploadDocument,
      removeDocument,
      refreshDocuments,
      updateProjectMemory,
      addUploadingFile,
      removeUploadingFile,
      getProjectSystemPrompt,
      getContextUsage,
    ],
  )

  return (
    <ProjectContext.Provider value={contextValue}>
      {children}
    </ProjectContext.Provider>
  )
}
