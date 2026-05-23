import { projectStorage } from '@/services/cloud/project-storage'
import { ENCRYPTION_KEY_CHANGED_EVENT } from '@/services/encryption/encryption-service'
import type { Project, ProjectListResponse } from '@/types/project'
import { logError, logInfo } from '@/utils/error-handling'
import { useAuth } from '@clerk/nextjs'
import { useCallback, useEffect, useRef, useState } from 'react'

const PROJECT_PAGE_LIMIT = 20

interface UseProjectsOptions {
  autoLoad?: boolean
}

interface UseProjectsReturn {
  projects: Project[]
  loading: boolean
  error: string | null
  hasMore: boolean
  loadProjects: () => Promise<void>
  loadMore: () => Promise<void>
  refresh: () => Promise<void>
}

type ProjectListItem = ProjectListResponse['projects'][number]

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

export function useProjects(
  options: UseProjectsOptions = {},
): UseProjectsReturn {
  const { autoLoad = true } = options
  const { isSignedIn } = useAuth()
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [continuationToken, setContinuationToken] = useState<
    string | undefined
  >()
  const initializedRef = useRef(false)
  const isSignedInRef = useRef(isSignedIn)

  useEffect(() => {
    isSignedInRef.current = isSignedIn
  }, [isSignedIn])

  const loadProjects = useCallback(async () => {
    if (!isSignedIn) {
      setProjects([])
      return
    }

    setLoading(true)
    setError(null)

    try {
      const { response, projects: decryptedProjects } = await loadProjectPage()

      // Re-check auth state after async operations - user may have logged out
      if (!isSignedInRef.current) {
        return
      }

      setProjects(decryptedProjects)
      setHasMore(response.hasMore)
      setContinuationToken(response.nextContinuationToken)

      logInfo('Loaded projects', {
        component: 'useProjects',
        action: 'loadProjects',
        metadata: {
          count: decryptedProjects.length,
          hasMore: response.hasMore,
        },
      })
    } catch (err) {
      // Don't set error state if user logged out during the request
      if (!isSignedInRef.current) {
        return
      }
      const message =
        err instanceof Error ? err.message : 'Failed to load projects'
      setError(message)
      logError('Failed to load projects', err, {
        component: 'useProjects',
        action: 'loadProjects',
      })
    } finally {
      setLoading(false)
    }
  }, [isSignedIn])

  const loadMore = useCallback(async () => {
    if (!isSignedIn || !hasMore || loading || !continuationToken) return

    setLoading(true)
    setError(null)

    try {
      const { response, projects: decryptedProjects } =
        await loadProjectPage(continuationToken)

      // Re-check auth state after async operations - user may have logged out
      if (!isSignedInRef.current) {
        return
      }

      setProjects((prev) => [...prev, ...decryptedProjects])
      setHasMore(response.hasMore)
      setContinuationToken(response.nextContinuationToken)
    } catch (err) {
      // Don't set error state if user logged out during the request
      if (!isSignedInRef.current) {
        return
      }
      const message =
        err instanceof Error ? err.message : 'Failed to load more projects'
      setError(message)
      logError('Failed to load more projects', err, {
        component: 'useProjects',
        action: 'loadMore',
      })
    } finally {
      setLoading(false)
    }
  }, [isSignedIn, hasMore, loading, continuationToken])

  const refresh = useCallback(async () => {
    setContinuationToken(undefined)
    await loadProjects()
  }, [loadProjects])

  useEffect(() => {
    if (autoLoad && isSignedIn && !initializedRef.current) {
      initializedRef.current = true
      loadProjects()
    }
  }, [autoLoad, isSignedIn, loadProjects])

  useEffect(() => {
    if (!isSignedIn) {
      initializedRef.current = false
      setProjects([])
      setContinuationToken(undefined)
      setHasMore(false)
    }
  }, [isSignedIn])

  // Listen for encryption key changes to retry decryption
  useEffect(() => {
    const handleKeyChange = () => {
      // Only refresh if we have projects that failed decryption
      const hasFailedDecryption = projects.some((p) => p.decryptionFailed)
      if (hasFailedDecryption && isSignedIn) {
        logInfo('Encryption key changed, refreshing projects', {
          component: 'useProjects',
          action: 'encryptionKeyChanged',
        })
        refresh()
      }
    }

    window.addEventListener(ENCRYPTION_KEY_CHANGED_EVENT, handleKeyChange)
    return () => {
      window.removeEventListener(ENCRYPTION_KEY_CHANGED_EVENT, handleKeyChange)
    }
  }, [projects, isSignedIn, refresh])

  return {
    projects,
    loading,
    error,
    hasMore,
    loadProjects,
    loadMore,
    refresh,
  }
}
