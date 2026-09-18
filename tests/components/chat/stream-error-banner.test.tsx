import type { StreamErrorInfo } from '@/components/chat/hooks/use-chat-streams'
import { StreamErrorBanner } from '@/components/chat/stream-error-banner'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const CONNECTION_ERROR: StreamErrorInfo = {
  code: 'FETCH_ERROR',
  message: 'Connection failure details',
}

afterEach(() => vi.restoreAllMocks())

describe('StreamErrorBanner', () => {
  it.each([false, true])(
    'supports resend, details, and dismissal in dark mode: %s',
    (isDarkMode) => {
      const onRetry = vi.fn()
      const onDismiss = vi.fn()
      render(
        <StreamErrorBanner
          error={CONNECTION_ERROR}
          isDarkMode={isDarkMode}
          onRetry={onRetry}
          onDismiss={onDismiss}
        />,
      )

      expect(screen.getByRole('alert')).toHaveTextContent('Connection problem')
      const retry = screen.getByRole('button', { name: 'Resend message' })
      expect(retry).toHaveClass('rounded-site-control')
      fireEvent.click(retry)
      expect(onRetry).toHaveBeenCalledOnce()
      expect(onDismiss).not.toHaveBeenCalled()

      const expand = screen.getByRole('button', {
        name: 'Expand error details',
      })
      expect(expand).toHaveAttribute('aria-expanded', 'false')
      expect(
        screen.queryByText(CONNECTION_ERROR.message),
      ).not.toBeInTheDocument()
      fireEvent.click(expand)
      expect(screen.getByText(CONNECTION_ERROR.message)).toBeVisible()
      const collapse = screen.getByRole('button', {
        name: 'Collapse error details',
      })
      expect(collapse).toHaveAttribute('aria-expanded', 'true')
      fireEvent.click(collapse)
      expect(
        screen.queryByText(CONNECTION_ERROR.message),
      ).not.toBeInTheDocument()

      fireEvent.click(screen.getByRole('button', { name: 'Dismiss error' }))
      expect(onDismiss).toHaveBeenCalledOnce()
      expect(onRetry).toHaveBeenCalledOnce()
    },
  )

  it('disables resend offline and enables it when connectivity returns', () => {
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    const onRetry = vi.fn()
    render(
      <StreamErrorBanner
        error={CONNECTION_ERROR}
        isDarkMode={false}
        onRetry={onRetry}
        onDismiss={vi.fn()}
      />,
    )
    const retry = screen.getByRole('button', { name: 'Offline' })
    expect(retry).toBeDisabled()
    fireEvent.click(retry)
    expect(onRetry).not.toHaveBeenCalled()

    online.mockReturnValue(true)
    act(() => window.dispatchEvent(new Event('online')))
    expect(screen.getByRole('button', { name: 'Resend message' })).toBeEnabled()
    fireEvent.click(retry)
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it.each<StreamErrorInfo['code']>([
    'RATE_LIMIT',
    'HOURLY_LIMIT',
    'FETCH_ERROR',
  ])(
    'keeps details and dismiss available without a retry action for %s',
    (code) => {
      render(
        <StreamErrorBanner
          error={{ ...CONNECTION_ERROR, code }}
          isDarkMode={false}
          onDismiss={vi.fn()}
          onRetry={code === 'FETCH_ERROR' ? undefined : vi.fn()}
        />,
      )
      expect(screen.getAllByRole('button')).toHaveLength(2)
      fireEvent.click(
        screen.getByRole('button', { name: 'Expand error details' }),
      )
      expect(screen.getByText(CONNECTION_ERROR.message)).toBeVisible()
      expect(
        screen.getByRole('button', { name: 'Dismiss error' }),
      ).toBeEnabled()
    },
  )
})
