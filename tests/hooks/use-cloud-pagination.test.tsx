import { useCloudPagination } from '@/hooks/use-cloud-pagination'
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { cloudSyncState, fetchAndStorePage, initializeChatPaginationCursor } =
  vi.hoisted(() => ({
    cloudSyncState: { enabled: true },
    fetchAndStorePage: vi.fn(),
    initializeChatPaginationCursor: vi.fn(),
  }))

vi.mock('@/services/cloud/cloud-sync', () => ({
  cloudSync: { fetchAndStorePage, initializeChatPaginationCursor },
}))

vi.mock('@/utils/cloud-sync-settings', () => ({
  CLOUD_SYNC_SETTING_CHANGED_EVENT: 'cloudSyncSettingChanged',
  isCloudSyncEnabled: () => cloudSyncState.enabled,
}))

describe('useCloudPagination', () => {
  beforeEach(() => {
    cloudSyncState.enabled = true
    initializeChatPaginationCursor.mockReset().mockResolvedValue({
      hasMore: true,
      nextToken: 'page-2',
    })
    fetchAndStorePage.mockReset().mockResolvedValue({
      hasMore: true,
      nextToken: 'page-3',
      saved: 20,
    })
  })

  it('initializes and uses the cursor after revision sync readiness', async () => {
    const { result } = renderHook(() =>
      useCloudPagination({
        isSignedIn: true,
        userId: 'user-1',
        isInitialPageReady: true,
      }),
    )

    await waitFor(() => expect(result.current.isInitialized).toBe(true))
    await act(() => result.current.loadMore())

    expect(initializeChatPaginationCursor).toHaveBeenCalledOnce()
    expect(fetchAndStorePage).toHaveBeenCalledWith({
      limit: 20,
      continuationToken: 'page-2',
    })
  })

  it('does not request a page when initialization returns no cursor', async () => {
    initializeChatPaginationCursor.mockResolvedValue({ hasMore: false })
    const { result } = renderHook(() =>
      useCloudPagination({
        isSignedIn: true,
        userId: 'user-1',
        isInitialPageReady: true,
      }),
    )

    await waitFor(() => expect(result.current.isInitialized).toBe(true))
    await act(() => result.current.loadMore())

    expect(result.current.hasMore).toBe(false)
    expect(fetchAndStorePage).not.toHaveBeenCalled()
  })

  it('retries failed cursor initialization from load more', async () => {
    initializeChatPaginationCursor
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce({ hasMore: true, nextToken: 'page-2' })
    const { result } = renderHook(() =>
      useCloudPagination({
        isSignedIn: true,
        userId: 'user-1',
        isInitialPageReady: true,
      }),
    )

    await waitFor(() =>
      expect(result.current.canRetryInitialization).toBe(true),
    )
    await act(() => result.current.loadMore())

    expect(initializeChatPaginationCursor).toHaveBeenCalledTimes(2)
    expect(fetchAndStorePage).toHaveBeenCalledWith({
      limit: 20,
      continuationToken: 'page-2',
    })
    expect(result.current.isInitialized).toBe(true)
  })

  it('waits for initial revision sync readiness before initializing', async () => {
    const { result, rerender } = renderHook(
      ({ isReady }: { isReady: boolean }) =>
        useCloudPagination({
          isSignedIn: true,
          userId: 'user-1',
          isInitialPageReady: isReady,
        }),
      { initialProps: { isReady: false } },
    )

    expect(result.current.isInitialized).toBe(false)
    expect(initializeChatPaginationCursor).not.toHaveBeenCalled()

    rerender({ isReady: true })
    await waitFor(() => expect(result.current.isInitialized).toBe(true))
    expect(initializeChatPaginationCursor).toHaveBeenCalledOnce()
  })

  it('ignores a cursor response from a stale account', async () => {
    let resolveOldCursor!: (value: {
      hasMore: boolean
      nextToken?: string
    }) => void
    initializeChatPaginationCursor
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveOldCursor = resolve
        }),
      )
      .mockResolvedValueOnce({ hasMore: true, nextToken: 'user-2-page-2' })
    const { result, rerender } = renderHook(
      ({ userId }: { userId: string }) =>
        useCloudPagination({
          isSignedIn: true,
          userId,
          isInitialPageReady: true,
        }),
      { initialProps: { userId: 'user-1' } },
    )

    await waitFor(() =>
      expect(initializeChatPaginationCursor).toHaveBeenCalled(),
    )
    rerender({ userId: 'user-2' })
    await waitFor(() => expect(result.current.isInitialized).toBe(true))
    resolveOldCursor({ hasMore: true, nextToken: 'user-1-page-2' })
    await act(async () => Promise.resolve())
    await act(() => result.current.loadMore())

    expect(fetchAndStorePage).toHaveBeenCalledWith({
      limit: 20,
      continuationToken: 'user-2-page-2',
    })
  })

  it('discards cursor initialization when cloud sync is disabled', async () => {
    let resolveCursor!: (value: {
      hasMore: boolean
      nextToken?: string
    }) => void
    initializeChatPaginationCursor.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveCursor = resolve
      }),
    )
    const { result } = renderHook(() =>
      useCloudPagination({
        isSignedIn: true,
        userId: 'user-1',
        isInitialPageReady: true,
      }),
    )
    await waitFor(() =>
      expect(initializeChatPaginationCursor).toHaveBeenCalled(),
    )

    cloudSyncState.enabled = false
    act(() => window.dispatchEvent(new Event('cloudSyncSettingChanged')))
    resolveCursor({ hasMore: true, nextToken: 'page-2' })
    await act(async () => Promise.resolve())

    expect(result.current.isInitialized).toBe(false)
    expect(result.current.hasMore).toBe(false)
  })

  it('deduplicates concurrent requests for the same page', async () => {
    let resolvePage!: (value: {
      hasMore: boolean
      nextToken?: string
      saved: number
    }) => void
    fetchAndStorePage.mockReturnValueOnce(
      new Promise((resolve) => {
        resolvePage = resolve
      }),
    )
    const { result } = renderHook(() =>
      useCloudPagination({
        isSignedIn: true,
        userId: 'user-1',
        isInitialPageReady: true,
      }),
    )
    await waitFor(() => expect(result.current.isInitialized).toBe(true))

    await act(async () => {
      const first = result.current.loadMore()
      const second = result.current.loadMore()
      expect(fetchAndStorePage).toHaveBeenCalledOnce()
      resolvePage({ hasMore: false, saved: 20 })
      await Promise.all([first, second])
    })
  })

  it('retries an incomplete page with the previous cursor', async () => {
    fetchAndStorePage
      .mockRejectedValueOnce(new Error('incomplete page'))
      .mockResolvedValueOnce({ hasMore: true, nextToken: 'page-3', saved: 20 })
    const { result } = renderHook(() =>
      useCloudPagination({
        isSignedIn: true,
        userId: 'user-1',
        isInitialPageReady: true,
      }),
    )
    await waitFor(() => expect(result.current.isInitialized).toBe(true))

    await act(() => result.current.loadMore())
    expect(result.current.hasMore).toBe(true)
    await act(() => result.current.loadMore())

    expect(fetchAndStorePage).toHaveBeenNthCalledWith(1, {
      limit: 20,
      continuationToken: 'page-2',
    })
    expect(fetchAndStorePage).toHaveBeenNthCalledWith(2, {
      limit: 20,
      continuationToken: 'page-2',
    })
  })

  it('does not let an obsolete page request unlock a newer request', async () => {
    initializeChatPaginationCursor
      .mockResolvedValueOnce({ hasMore: true, nextToken: 'user-1-page-2' })
      .mockResolvedValueOnce({ hasMore: true, nextToken: 'user-2-page-2' })
    let resolveOldPage!: (value: {
      hasMore: boolean
      nextToken?: string
      saved: number
    }) => void
    let resolveNewPage!: typeof resolveOldPage
    fetchAndStorePage
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveOldPage = resolve
        }),
      )
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveNewPage = resolve
        }),
      )
    const { result, rerender } = renderHook(
      ({ userId }: { userId: string }) =>
        useCloudPagination({
          isSignedIn: true,
          userId,
          isInitialPageReady: true,
        }),
      { initialProps: { userId: 'user-1' } },
    )
    await waitFor(() => expect(result.current.isInitialized).toBe(true))

    let oldRequest!: ReturnType<typeof result.current.loadMore>
    act(() => {
      oldRequest = result.current.loadMore()
    })
    rerender({ userId: 'user-2' })
    await waitFor(() => expect(result.current.isInitialized).toBe(true))

    let newRequest!: ReturnType<typeof result.current.loadMore>
    act(() => {
      newRequest = result.current.loadMore()
    })
    expect(result.current.isLoading).toBe(true)
    await act(async () => {
      resolveOldPage({ hasMore: false, saved: 20 })
      await oldRequest
    })

    expect(result.current.isLoading).toBe(true)
    expect(result.current.hasMore).toBe(true)
    await act(() => result.current.loadMore())

    expect(fetchAndStorePage).toHaveBeenCalledTimes(2)
    expect(fetchAndStorePage).toHaveBeenLastCalledWith({
      limit: 20,
      continuationToken: 'user-2-page-2',
    })
    await act(async () => {
      resolveNewPage({ hasMore: true, nextToken: 'user-2-page-3', saved: 20 })
      await newRequest
    })
    expect(result.current.isLoading).toBe(false)
    await act(() => result.current.loadMore())
    expect(fetchAndStorePage).toHaveBeenCalledTimes(3)
    expect(fetchAndStorePage).toHaveBeenLastCalledWith({
      limit: 20,
      continuationToken: 'user-2-page-3',
    })
  })
})
