import { CONSTANTS } from '@/components/chat/constants'
import { useManualSync } from '@/components/chat/hooks/use-manual-sync'
import { logError } from '@/utils/error-handling'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/utils/error-handling', () => ({
  logError: vi.fn(),
}))

describe('useManualSync', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.mocked(logError).mockClear()
  })

  it('holds the spinner for a minimum duration, then shows success briefly', async () => {
    const onSync = vi.fn().mockResolvedValue(true)
    const { result } = renderHook(() =>
      useManualSync({ isSyncing: false, syncFailed: false, onSync }),
    )

    let syncPromise: Promise<void> | undefined
    act(() => {
      syncPromise = result.current.sync()
    })
    expect(result.current.statusLabel).toBe('Syncing')
    expect(result.current.isDisabled).toBe(true)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        CONSTANTS.SIDEBAR_SYNC_MIN_SPINNER_MS - 1,
      )
    })
    expect(result.current.statusLabel).toBe('Syncing')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(result.current.showSuccess).toBe(true)
    expect(result.current.statusLabel).toBe('Synced')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        CONSTANTS.SIDEBAR_SYNC_SUCCESS_FEEDBACK_MS,
      )
      await syncPromise
    })
    expect(result.current.statusLabel).toBe('Sync healthy')
    expect(result.current.isDisabled).toBe(false)
  })

  it('reports a failure without showing success feedback', async () => {
    const onSync = vi.fn().mockResolvedValue(false)
    const { result } = renderHook(() =>
      useManualSync({ isSyncing: false, syncFailed: false, onSync }),
    )

    let syncPromise: Promise<void> | undefined
    act(() => {
      syncPromise = result.current.sync()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CONSTANTS.SIDEBAR_SYNC_MIN_SPINNER_MS)
      await syncPromise
    })

    expect(result.current.showSuccess).toBe(false)
    expect(result.current.hasSyncFailure).toBe(true)
    expect(result.current.statusLabel).toBe('Sync failed')
  })

  it('lets a new failure override the success-feedback window', async () => {
    const onSync = vi.fn().mockResolvedValue(true)
    const { result, rerender } = renderHook(
      ({ syncFailed }) =>
        useManualSync({ isSyncing: false, syncFailed, onSync }),
      { initialProps: { syncFailed: false } },
    )
    let pending: Promise<void> | undefined
    act(() => {
      pending = result.current.sync()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CONSTANTS.SIDEBAR_SYNC_MIN_SPINNER_MS)
    })
    expect(result.current.showSuccess).toBe(true)
    rerender({ syncFailed: true })
    expect(result.current.statusLabel).toBe('Sync failed')
    expect(result.current.showSuccess).toBe(false)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        CONSTANTS.SIDEBAR_SYNC_SUCCESS_FEEDBACK_MS,
      )
      await pending
    })
  })

  it('clears a previous manual failure once a sync succeeds', async () => {
    const failure = new Error('offline')
    const onSync = vi
      .fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(true)
    const { result } = renderHook(() =>
      useManualSync({ isSyncing: false, syncFailed: false, onSync }),
    )

    await act(async () => {
      const first = result.current.sync()
      await vi.advanceTimersByTimeAsync(CONSTANTS.SIDEBAR_SYNC_MIN_SPINNER_MS)
      await first
    })
    expect(result.current.hasSyncFailure).toBe(true)
    expect(logError).toHaveBeenCalledExactlyOnceWith(
      'Manual sync failed',
      failure,
      expect.objectContaining({ component: 'useManualSync' }),
    )

    let retry: Promise<void> = Promise.resolve()
    act(() => {
      retry = result.current.sync()
    })
    expect(result.current.showSpinner).toBe(true)
    expect(result.current.hasSyncFailure).toBe(true)
    expect(result.current.statusLabel).toBe('Retrying failed sync')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        CONSTANTS.SIDEBAR_SYNC_MIN_SPINNER_MS +
          CONSTANTS.SIDEBAR_SYNC_SUCCESS_FEEDBACK_MS,
      )
      await retry
    })
    expect(result.current.hasSyncFailure).toBe(false)
  })

  it.each([false, true])(
    'updates a manual failure after a background cycle (failed: %s)',
    async (failed) => {
      const onSync = vi.fn().mockResolvedValue(false)
      const { result, rerender } = renderHook(
        (props) => useManualSync({ ...props, onSync }),
        {
          initialProps: { isSyncing: false, syncFailed: false },
        },
      )
      await act(async () => {
        const pending = result.current.sync()
        await vi.advanceTimersByTimeAsync(CONSTANTS.SIDEBAR_SYNC_MIN_SPINNER_MS)
        await pending
      })
      expect(result.current.hasSyncFailure).toBe(true)
      rerender({ isSyncing: true, syncFailed: false })
      expect(result.current.statusLabel).toBe('Retrying failed sync')
      rerender({ isSyncing: false, syncFailed: failed })
      expect(result.current.hasSyncFailure).toBe(failed)
      expect(result.current.statusLabel).toBe(
        failed ? 'Sync failed' : 'Sync healthy',
      )
    },
  )
})
