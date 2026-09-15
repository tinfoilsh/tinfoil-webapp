import { CONSTANTS } from '@/components/chat/constants'
import { SidebarSyncButton } from '@/components/chat/sidebar-sync-button'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

describe('SidebarSyncButton', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows the spinner for at least one second before success feedback', async () => {
    vi.useFakeTimers()
    const onSync = vi.fn().mockResolvedValue(true)
    render(
      <SidebarSyncButton
        isSyncing={false}
        syncFailed={false}
        onSync={onSync}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /sync cloud data/i }))
    expect(screen.getByRole('button')).toHaveAccessibleName(
      'Sync cloud data. Syncing',
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        CONSTANTS.SIDEBAR_SYNC_MIN_SPINNER_MS - 1,
      )
    })
    expect(screen.getByRole('button')).toHaveAccessibleName(
      'Sync cloud data. Syncing',
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(screen.getByRole('button')).toHaveAccessibleName(
      'Sync cloud data. Synced',
    )
    expect(screen.getByText('Synced')).toBeInTheDocument()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        CONSTANTS.SIDEBAR_SYNC_SUCCESS_FEEDBACK_MS,
      )
    })
    expect(screen.getByRole('button')).toHaveAccessibleName(
      'Sync cloud data. Sync healthy',
    )
  })

  it('returns to the failure dot without showing success feedback', async () => {
    vi.useFakeTimers()
    const onSync = vi.fn().mockResolvedValue(false)
    render(
      <SidebarSyncButton
        isSyncing={false}
        syncFailed={false}
        onSync={onSync}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /sync cloud data/i }))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(CONSTANTS.SIDEBAR_SYNC_MIN_SPINNER_MS)
    })

    expect(screen.getByRole('button')).toHaveAccessibleName(
      'Sync cloud data. Sync failed',
    )
    expect(screen.getByText('Sync failed')).toBeInTheDocument()
  })
})
