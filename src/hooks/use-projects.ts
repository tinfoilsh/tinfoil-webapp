import { SYNC_PROJECTS_INVALIDATED } from '@/constants/storage-keys'
import { projectStorage } from '@/services/cloud/project-storage'
import { ENCRYPTION_KEY_CHANGED_EVENT } from '@/services/encryption/encryption-service'
import { projectEvents } from '@/services/project/project-events'
import {
  PROJECT_CACHE_UPDATED_EVENT,
  projectCache,
} from '@/services/storage/project-cache'
import type { Project, ProjectListResponse } from '@/types/project'
import { logError, logInfo } from '@/utils/error-handling'
import { useAuth } from '@clerk/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

const PROJECT_PAGE_LIMIT = 20
const PROJECT_CACHE_FRESHNESS_MS = 5 * 60 * 1000

interface UseProjectsOptions {
  autoLoad?: boolean
}

interface UseProjectsReturn {
  projects: Project[]
  loading: boolean
  error: string | null
  loadProjects: () => Promise<void>
  refresh: () => Promise<void>
}

type ProjectListItem = ProjectListResponse['projects'][number]

const refreshByUser = new Map<
  string,
  { generation: number; promise: Promise<Project[]> }
>()
const freshProjectsByUser = new Map<
  string,
  { generation: number; refreshedAt: number; projects: Project[] }
>()
const projectInvalidationSubscribers = new Set<() => void>()
let unsubscribeProjectInvalidation: (() => void) | null = null

function invalidateProjectLists(): void {
  projectCache.invalidate()
  refreshByUser.clear()
  freshProjectsByUser.clear()
  projectInvalidationSubscribers.forEach((subscriber) => subscriber())
}

function handleProjectInvalidationStorage(event: StorageEvent): void {
  if (event.key === SYNC_PROJECTS_INVALIDATED) invalidateProjectLists()
}

function subscribeToProjectInvalidation(subscriber: () => void): () => void {
  projectInvalidationSubscribers.add(subscriber)
  if (projectInvalidationSubscribers.size === 1) {
    unsubscribeProjectInvalidation = projectEvents.on(
      'projects-invalidated',
      invalidateProjectLists,
    )
    window.addEventListener('storage', handleProjectInvalidationStorage)
  }

  return () => {
    projectInvalidationSubscribers.delete(subscriber)
    if (projectInvalidationSubscribers.size === 0) {
      unsubscribeProjectInvalidation?.()
      unsubscribeProjectInvalidation = null
      window.removeEventListener('storage', handleProjectInvalidationStorage)
    }
  }
}

function projectFromListItem(
  item: ProjectListItem,
  full: Project | undefined,
): Project {
  if (!full) {
    return {
      id: item.id,
      name: 'Encrypted',
      description: '',
      systemInstructions: '',
      memory: [],
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      syncVersion: item.syncVersion,
      decryptionFailed: true,
    }
  }
  return {
    ...full,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    syncVersion: item.syncVersion,
  }
}

async function loadProjectPage(
  continuationToken?: string,
): Promise<{ response: ProjectListResponse; projects: Project[] }> {
  const response = await projectStorage.listProjects({
    limit: PROJECT_PAGE_LIMIT,
    continuationToken,
  })
  const decryptedById = await projectStorage.getProjects(
    response.projects.map((item) => item.id),
  )
  return {
    response,
    projects: response.projects.map((item) =>
      projectFromListItem(item, decryptedById.get(item.id)),
    ),
  }
}

async function fetchAllProjects(): Promise<Project[]> {
  const projects: Project[] = []
  let continuationToken: string | undefined

  do {
    const page = await loadProjectPage(continuationToken)
    projects.push(...page.projects)
    continuationToken = page.response.nextContinuationToken
  } while (continuationToken)

  return projects
}

function revalidateProjects(
  userId: string,
  forceRefresh: boolean,
): Promise<Project[]> {
  const cacheGeneration = projectCache.captureGeneration()
  const refreshGeneration = projectCache.captureRefreshGeneration()
  if (forceRefresh) freshProjectsByUser.delete(userId)
  const freshProjects = freshProjectsByUser.get(userId)
  if (
    !forceRefresh &&
    freshProjects?.generation === refreshGeneration &&
    Date.now() - freshProjects.refreshedAt < PROJECT_CACHE_FRESHNESS_MS
  ) {
    return Promise.resolve(freshProjects.projects)
  }
  const existing = refreshByUser.get(userId)
  if (existing?.generation === refreshGeneration) return existing.promise

  const refresh = fetchAllProjects()
    .then(async (projects) => {
      if (!projectCache.isCurrentRefreshGeneration(refreshGeneration)) {
        return projectCache.getProjects(userId)
      }
      try {
        await projectCache.replaceProjects(userId, projects, cacheGeneration)
      } catch (error) {
        logError('Failed to cache projects', error, {
          component: 'useProjects',
          action: 'cacheProjects',
        })
      }
      freshProjectsByUser.set(userId, {
        generation: refreshGeneration,
        refreshedAt: Date.now(),
        projects,
      })
      return projects
    })
    .finally(() => {
      if (refreshByUser.get(userId)?.promise === refresh) {
        refreshByUser.delete(userId)
      }
    })
  refreshByUser.set(userId, { generation: refreshGeneration, promise: refresh })
  return refresh
}

export function useProjects(
  options: UseProjectsOptions = {},
): UseProjectsReturn {
  const { autoLoad = true } = options
  const { isSignedIn, userId } = useAuth()
  const [projects, setProjects] = useState<Project[]>([])
  const [projectsUserId, setProjectsUserId] = useState<string>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const initializedUserRef = useRef<string | null>(null)
  const currentUserRef = useRef(userId)
  const previousUserRef = useRef(userId)
  const loadGenerationRef = useRef(0)
  currentUserRef.current = userId
  const visibleProjects = useMemo(
    () => (projectsUserId === userId ? projects : []),
    [projectsUserId, userId, projects],
  )
  const visibleLoading =
    loading ||
    Boolean(autoLoad && isSignedIn && userId && projectsUserId !== userId)

  useEffect(() => {
    const previousUserId = previousUserRef.current
    if (previousUserId && previousUserId !== userId) {
      refreshByUser.delete(previousUserId)
      freshProjectsByUser.delete(previousUserId)
    }
    previousUserRef.current = userId
  }, [userId])

  const loadProjects = useCallback(
    async (forceRefresh = false, skipCache = false) => {
      const loadGeneration = loadGenerationRef.current + 1
      loadGenerationRef.current = loadGeneration
      if (!isSignedIn || !userId) {
        setProjects([])
        setProjectsUserId(undefined)
        return
      }

      const requestUserId = userId
      setLoading(skipCache || visibleProjects.length === 0)
      setError(null)
      let remoteApplied = false
      let cacheApplied = false
      const isCurrentLoad = () =>
        currentUserRef.current === requestUserId &&
        loadGenerationRef.current === loadGeneration

      if (!skipCache) {
        void projectCache
          .getProjects(requestUserId)
          .then((cachedProjects) => {
            if (!isCurrentLoad() || remoteApplied) return

            cacheApplied = true
            setProjectsUserId(requestUserId)
            setProjects(cachedProjects)
            if (cachedProjects.length > 0) setLoading(false)
          })
          .catch((cacheError) => {
            logError('Failed to load cached projects', cacheError, {
              component: 'useProjects',
              action: 'loadCachedProjects',
            })
          })
      }

      try {
        const remoteProjects = await revalidateProjects(
          requestUserId,
          forceRefresh,
        )
        if (!isCurrentLoad()) return

        remoteApplied = true
        setProjectsUserId(requestUserId)
        setProjects(remoteProjects)
        logInfo('Loaded projects', {
          component: 'useProjects',
          action: 'loadProjects',
          metadata: { count: remoteProjects.length },
        })
      } catch (err) {
        if (!isCurrentLoad()) return

        const message =
          err instanceof Error ? err.message : 'Failed to load projects'
        setProjectsUserId(requestUserId)
        if (!cacheApplied && projectsUserId !== requestUserId) setProjects([])
        setError(message)
        logError('Failed to load projects', err, {
          component: 'useProjects',
          action: 'loadProjects',
        })
      } finally {
        if (isCurrentLoad()) setLoading(false)
      }
    },
    [isSignedIn, userId, visibleProjects.length, projectsUserId],
  )

  const refresh = useCallback(() => loadProjects(true), [loadProjects])

  useEffect(() => {
    if (!isSignedIn || !userId) return

    return subscribeToProjectInvalidation(() => {
      setProjects([])
      setProjectsUserId(userId)
      setError(null)
      void loadProjects(true, true)
    })
  }, [isSignedIn, userId, loadProjects])

  useEffect(() => {
    if (
      autoLoad &&
      isSignedIn &&
      userId &&
      initializedUserRef.current !== userId
    ) {
      initializedUserRef.current = userId
      void loadProjects()
    }
  }, [autoLoad, isSignedIn, userId, loadProjects])

  useEffect(() => {
    if (!isSignedIn || !userId) {
      initializedUserRef.current = null
      setProjects([])
      setProjectsUserId(undefined)
      setLoading(false)
      return
    }

    const handleCacheUpdate = (event: Event) => {
      const updatedUserId = (event as CustomEvent<{ userId?: string }>).detail
        .userId
      if (updatedUserId && updatedUserId !== userId) return
      if (!updatedUserId) {
        setProjects([])
        setProjectsUserId(userId)
      }

      void projectCache
        .getProjects(userId)
        .then((cachedProjects) => {
          if (currentUserRef.current !== userId) return
          setProjectsUserId(userId)
          setProjects(cachedProjects)
        })
        .catch((cacheError) => {
          logError('Failed to refresh cached projects', cacheError, {
            component: 'useProjects',
            action: 'handleCacheUpdate',
          })
        })
    }

    window.addEventListener(PROJECT_CACHE_UPDATED_EVENT, handleCacheUpdate)
    return () =>
      window.removeEventListener(PROJECT_CACHE_UPDATED_EVENT, handleCacheUpdate)
  }, [isSignedIn, userId])

  useEffect(() => {
    const handleKeyChange = () => {
      if (
        visibleProjects.some((project) => project.decryptionFailed) &&
        isSignedIn
      ) {
        logInfo('Encryption key changed, refreshing projects', {
          component: 'useProjects',
          action: 'encryptionKeyChanged',
        })
        void refresh()
      }
    }

    window.addEventListener(ENCRYPTION_KEY_CHANGED_EVENT, handleKeyChange)
    return () => {
      window.removeEventListener(ENCRYPTION_KEY_CHANGED_EVENT, handleKeyChange)
    }
  }, [visibleProjects, isSignedIn, refresh])

  return {
    projects: visibleProjects,
    loading: visibleLoading,
    error,
    loadProjects,
    refresh,
  }
}
