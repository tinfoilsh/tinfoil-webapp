import { listArtifacts, withArtifactPage } from '@/services/harness/artifacts'
import { useHarness } from '@/services/harness/provider'
import { HarnessError } from '@/services/harness/sse'
import type { Artifact } from '@/services/harness/types'
import { logError } from '@/utils/error-handling'
import { useCallback, useEffect, useRef, useState } from 'react'

const LIST_FAILED = 'The artifacts could not be loaded.'

// The artifacts of the account's stored chats, or of a project's chats, a
// page at a time. The list is read as it is shown, and again when the
// project it lists changes.
export function useArtifacts(projectId?: string) {
  const { api } = useHarness()
  // The pages read so far, and the cursor of the page after them.
  const [listed, setListed] = useState<{
    artifacts: Artifact[]
    nextCursor: string
  } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  // How many times the user read the list again after it failed.
  const [retries, setRetries] = useState(0)
  // Ends the pages being read once the list they belong to is left.
  const reading = useRef<AbortController | null>(null)

  const failed = useCallback((cause: unknown) => {
    logError('Failed to list artifacts', cause, {
      component: 'useArtifacts',
      action: 'list',
    })
    setError(cause instanceof HarnessError ? cause.message : LIST_FAILED)
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    reading.current = controller
    setListed(null)
    setError(null)
    setLoadingMore(false)
    void listArtifacts(api, { projectId }, controller.signal)
      .then((page) => {
        if (controller.signal.aborted) return
        setListed({
          artifacts: withArtifactPage([], page.artifacts),
          nextCursor: page.nextCursor,
        })
      })
      .catch((cause) => {
        if (!controller.signal.aborted) failed(cause)
      })
    return () => controller.abort()
  }, [api, projectId, retries, failed])

  const nextCursor = listed?.nextCursor
  const loadMore = useCallback(async () => {
    const signal = reading.current?.signal
    if (!nextCursor || loadingMore || !signal) return
    setLoadingMore(true)
    setError(null)
    try {
      const page = await listArtifacts(
        api,
        { projectId, cursor: nextCursor },
        signal,
      )
      if (signal.aborted) return
      setListed(
        (read) =>
          read && {
            artifacts: withArtifactPage(read.artifacts, page.artifacts),
            nextCursor: page.nextCursor,
          },
      )
    } catch (cause) {
      if (!signal.aborted) failed(cause)
    } finally {
      if (!signal.aborted) setLoadingMore(false)
    }
  }, [api, projectId, nextCursor, loadingMore, failed])

  return {
    artifacts: listed?.artifacts ?? [],
    loading: !listed && !error,
    // Why the list, or its next page, could not be read.
    error,
    hasMore: !!nextCursor,
    loadingMore,
    loadMore,
    // Reads the list again once its first page failed.
    retry: () => setRetries((count) => count + 1),
  }
}
