import {
  StreamErrorBanner,
  type StreamErrorInfo,
} from '@/components/chat/stream-error-banner'
import { REQUEST_UPGRADE_EVENT } from '@/constants/chat-events'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const CONNECTION_ERROR: StreamErrorInfo = {
  code: 'STREAM_INTERRUPTED',
  message: 'Connection failure details',
}

afterEach(() => vi.restoreAllMocks())

describe('StreamErrorBanner', () => {
  it('explains an authentication failure without blaming connectivity', () => {
    render(
      <StreamErrorBanner
        error={{
          code: 'UNAUTHENTICATED',
          message: 'Authentication is not initialized',
        }}
        isDarkMode={false}
        onRetry={vi.fn()}
        onDismiss={vi.fn()}
      />,
    )

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Unable to confirm your sign-in',
    )
    expect(screen.getByRole('alert')).toHaveTextContent('Sign in again')
    expect(screen.getByRole('alert')).not.toHaveTextContent(
      'Check your internet connection',
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'Expand error details' }),
    )
    expect(screen.getByText('Authentication is not initialized')).toBeVisible()
  })

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

  it.each([
    { code: 'QUOTA_EXHAUSTED', title: 'Usage limit reached' },
    {
      code: 'CONTEXT_TOO_LARGE',
      title: 'This conversation is too long for the model',
    },
    {
      code: 'MODEL_UNAVAILABLE',
      title: 'This model is unavailable right now',
    },
    {
      code: 'UPSTREAM_REFUSED',
      title: 'The service is having trouble right now',
    },
  ])('explains $code with its own copy', ({ code, title }) => {
    render(
      <StreamErrorBanner
        error={{ ...CONNECTION_ERROR, code }}
        isDarkMode={false}
        onDismiss={vi.fn()}
        onRetry={vi.fn()}
      />,
    )
    expect(screen.getByRole('alert')).toHaveTextContent(title)
    expect(screen.getByRole('alert')).not.toHaveTextContent(
      'Check your internet connection',
    )
  })

  it.each([
    { code: 'QUOTA_EXHAUSTED', withRetry: true },
    { code: 'THREAD_TOO_LARGE', withRetry: true },
    { code: 'STREAM_INTERRUPTED', withRetry: false },
  ])(
    'keeps details and dismiss available without a retry action for $code',
    ({ code, withRetry }) => {
      render(
        <StreamErrorBanner
          error={{ ...CONNECTION_ERROR, code }}
          isDarkMode={false}
          onDismiss={vi.fn()}
          onRetry={withRetry ? vi.fn() : undefined}
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

  it('counts down a requested wait before allowing a resend', async () => {
    vi.useFakeTimers()
    try {
      const onRetry = vi.fn()
      render(
        <StreamErrorBanner
          error={{
            code: 'RATE_LIMITED',
            message: 'Chat access is busy; retry shortly',
            retryAfter: 3,
            timestamp: Date.now(),
          }}
          isDarkMode={false}
          onDismiss={vi.fn()}
          onRetry={onRetry}
        />,
      )
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Too many requests right now',
      )
      const retry = screen.getByRole('button', { name: 'Resend in 3s' })
      expect(retry).toBeDisabled()
      fireEvent.click(retry)
      expect(onRetry).not.toHaveBeenCalled()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000)
      })
      expect(
        screen.getByRole('button', { name: 'Resend in 2s' }),
      ).toBeDisabled()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000)
      })
      const ready = screen.getByRole('button', { name: 'Resend message' })
      expect(ready).toBeEnabled()
      fireEvent.click(ready)
      expect(onRetry).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('names when an hourly cap resets and offers no retry', () => {
    const resetsAt = '2026-07-24T11:00:00Z'
    const label = new Date(resetsAt).toLocaleTimeString([], {
      hour: 'numeric',
      minute: '2-digit',
    })
    render(
      <StreamErrorBanner
        error={{
          code: 'QUOTA_EXHAUSTED',
          kind: 'hourly',
          resetsAt,
          message: 'The hourly usage limit is reached',
        }}
        isDarkMode={false}
        onDismiss={vi.fn()}
        onRetry={vi.fn()}
      />,
    )
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Hourly usage limit reached',
    )
    expect(screen.getByRole('alert')).toHaveTextContent(
      `Your limit resets at ${label}.`,
    )
    expect(
      screen.queryByRole('button', { name: /Resend|Try again/ }),
    ).not.toBeInTheDocument()
  })

  it('offers an upgrade for an exhausted free daily quota', () => {
    const upgrade = vi.fn()
    window.addEventListener(REQUEST_UPGRADE_EVENT, upgrade)
    try {
      render(
        <StreamErrorBanner
          error={{
            code: 'QUOTA_EXHAUSTED',
            kind: 'free_daily',
            message: 'The daily quota is exhausted',
          }}
          isDarkMode={false}
          onDismiss={vi.fn()}
          onRetry={vi.fn()}
        />,
      )
      expect(screen.getByRole('alert')).toHaveTextContent('Daily limit reached')
      fireEvent.click(
        screen.getByRole('button', { name: 'Upgrade to Premium' }),
      )
      expect(upgrade).toHaveBeenCalledOnce()
    } finally {
      window.removeEventListener(REQUEST_UPGRADE_EVENT, upgrade)
    }
  })

  it("shows a document failure's own explanation", () => {
    const message =
      'Could not extract content from the document. Try exporting it again or uploading a text version.'
    render(
      <StreamErrorBanner
        error={{
          code: 'UPSTREAM_REFUSED',
          upstreamCode: 'document_extraction_failed',
          message,
        }}
        isDarkMode={false}
        onDismiss={vi.fn()}
        onRetry={vi.fn()}
      />,
    )
    expect(screen.getByRole('alert')).toHaveTextContent(
      'A document could not be processed',
    )
    expect(screen.getByRole('alert')).toHaveTextContent(message)
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled()
  })
})
