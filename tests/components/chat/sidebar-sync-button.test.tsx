import { CONSTANTS } from '@/components/chat/constants'
import { SidebarSyncButton } from '@/components/chat/sidebar-sync-button'
import { Cog6ToothIcon } from '@heroicons/react/24/outline'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

describe('SidebarSyncButton', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('matches the settings icon size, view box, and stroke weight', () => {
    const { container } = render(
      <>
        <Cog6ToothIcon className="h-5 w-5" data-testid="settings-icon" />
        <SidebarSyncButton
          isSyncing={false}
          syncFailed={false}
          onSync={vi.fn()}
        />
      </>,
    )
    const settingsIcon = screen.getByTestId('settings-icon')
    const syncIcon = container.querySelector('button svg')

    expect(syncIcon).toHaveClass('h-5', 'w-5')
    for (const attribute of ['viewBox', 'stroke-width', 'stroke', 'fill']) {
      expect(syncIcon).toHaveAttribute(
        attribute,
        settingsIcon.getAttribute(attribute),
      )
    }
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
