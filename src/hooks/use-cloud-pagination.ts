import { PAGINATION } from '@/config'
import { cloudSync, type ChatPageResult } from '@/services/cloud/cloud-sync'
import {
  CLOUD_SYNC_SETTING_CHANGED_EVENT,
  isCloudSyncEnabled,
} from '@/utils/cloud-sync-settings'
import { logError } from '@/utils/error-handling'
import { useCallback, useEffect, useRef, useState } from 'react'

interface UseCloudPaginationOptions {
  isSignedIn: boolean
  userId?: string
  pageSize?: number
  isInitialPageReady?: boolean
}

interface UseCloudPaginationReturn {
  hasMore: boolean
  isLoading: boolean
  hasAttempted: boolean
  isInitialized: boolean
  canRetryInitialization: boolean
  loadMore: () => Promise<ChatPageResult | undefined>
}

export function useCloudPagination(
  options: UseCloudPaginationOptions,
): UseCloudPaginationReturn {
  const {
    isSignedIn,
    userId,
    pageSize = PAGINATION.CHATS_PER_PAGE,
    isInitialPageReady = false,
  } = options

  const [nextToken, setNextToken] = useState<string | undefined>(undefined)
  const [hasMore, setHasMore] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [hasAttempted, setHasAttempted] = useState(false)
  const [isInitialized, setIsInitialized] = useState(false)
  const [canRetryInitialization, setCanRetryInitialization] = useState(false)
  const loadingGenerationRef = useRef<number | null>(null)
  const requestGenerationRef = useRef(0)
  const [cloudSyncEnabled, setCloudSyncEnabled] = useState(isCloudSyncEnabled())

  useEffect(() => {
    const checkCloudSyncStatus = () => {
      setCloudSyncEnabled(isCloudSyncEnabled())
    }

    checkCloudSyncStatus()

    window.addEventListener('storage', checkCloudSyncStatus)
    window.addEventListener(
      CLOUD_SYNC_SETTING_CHANGED_EVENT,
      checkCloudSyncStatus,
    )

    return () => {
      window.removeEventListener('storage', checkCloudSyncStatus)
      window.removeEventListener(
        CLOUD_SYNC_SETTING_CHANGED_EVENT,
        checkCloudSyncStatus,
      )
    }
  }, [])

  const initializeCursor = useCallback(async (requestGeneration: number) => {
    try {
      const result = await cloudSync.initializeChatPaginationCursor()
      if (requestGeneration !== requestGenerationRef.current) return
      setNextToken(result.nextToken)
      setHasMore(result.hasMore && Boolean(result.nextToken))
      setIsInitialized(true)
      setCanRetryInitialization(false)
      return result
    } catch (error) {
      if (requestGeneration !== requestGenerationRef.current) return
      setCanRetryInitialization(true)
      logError('Failed to initialize chat pagination', error, {
        component: 'useCloudPagination',
        action: 'initialize',
      })
    }
  }, [])

  useEffect(() => {
    const requestGeneration = ++requestGenerationRef.current
    loadingGenerationRef.current = null
    setIsLoading(false)
    setNextToken(undefined)
    setHasMore(false)
    setHasAttempted(false)
    setIsInitialized(false)
    setCanRetryInitialization(false)
    if (!isSignedIn || !userId || !cloudSyncEnabled || !isInitialPageReady) {
      return
    }

    // Note: We intentionally do NOT delete local chats here.
    // IndexedDB can hold gigabytes of data, so keeping all synced chats
    // locally provides better offline access. Users can fetch older chats
    // from the cloud on demand via loadMore().
    loadingGenerationRef.current = requestGeneration
    void initializeCursor(requestGeneration).finally(() => {
      if (loadingGenerationRef.current === requestGeneration) {
        loadingGenerationRef.current = null
      }
    })
  }, [
    isSignedIn,
    userId,
    cloudSyncEnabled,
    isInitialPageReady,
    initializeCursor,
  ])

  const loadMore = useCallback(async () => {
    if (
      !isSignedIn ||
      !userId ||
      isLoading ||
      !cloudSyncEnabled ||
      (!isInitialized && !canRetryInitialization) ||
      loadingGenerationRef.current !== null
    )
      return

    const requestGeneration = requestGenerationRef.current
    loadingGenerationRef.current = requestGeneration
    // Save current state in case we need to rollback
    let token = nextToken
    let previousToken = token
    let previousHasMore = hasMore

    setIsLoading(true)
    setHasAttempted(true)

    try {
      if (!isInitialized) {
        setCanRetryInitialization(false)
        const initialized = await initializeCursor(requestGeneration)
        if (
          requestGeneration !== requestGenerationRef.current ||
          !initialized
        ) {
          return
        }
        token = initialized.nextToken
        previousToken = token
        previousHasMore = initialized.hasMore && Boolean(token)
      }

      if (!token) {
        if (requestGeneration === requestGenerationRef.current) {
          setHasMore(false)
        }
        return
      }

      const result = await cloudSync.fetchAndStorePage({
        limit: pageSize,
        continuationToken: token,
      })
      if (requestGeneration !== requestGenerationRef.current) return

      setNextToken(result.nextToken)
      setHasMore(!!result.nextToken)
      return result
    } catch (error) {
      if (requestGeneration !== requestGenerationRef.current) return
      // Rollback state on error
      setNextToken(previousToken)
      setHasMore(previousHasMore)

      logError('Failed to load more chats', error, {
        component: 'useCloudPagination',
        action: 'loadMore',
        metadata: {
          hadToken: !!previousToken,
          wasInitialized: isInitialized,
        },
      })
      return undefined
    } finally {
      if (loadingGenerationRef.current === requestGeneration) {
        loadingGenerationRef.current = null
        if (requestGeneration === requestGenerationRef.current) {
          setIsLoading(false)
        }
      }
    }
  }, [
    isSignedIn,
    userId,
    isLoading,
    nextToken,
    pageSize,
    hasMore,
    cloudSyncEnabled,
    isInitialized,
    canRetryInitialization,
    initializeCursor,
  ])

  return {
    hasMore,
    isLoading,
    hasAttempted,
    isInitialized,
    canRetryInitialization,
    loadMore,
  }
}
