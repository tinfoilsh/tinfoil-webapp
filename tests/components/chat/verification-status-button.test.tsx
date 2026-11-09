import {
  VERIFIED_LABEL_EXIT_MS,
  VERIFIED_LABEL_SHOWN_MS,
  VerificationStatusButton,
  type VerificationStatus,
} from '@/components/chat/verification-status-button'
import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

const wait = (ms: number) => act(() => vi.advanceTimersByTime(ms))

function renderButton(status: VerificationStatus, announceVerified = true) {
  const onVerifiedAnnounced = vi.fn()
  const props = {
    isPanelOpen: false,
    onTogglePanel: vi.fn(),
    onVerifiedAnnounced,
  }
  const view = render(
    <VerificationStatusButton
      {...props}
      status={status}
      announceVerified={announceVerified}
    />,
  )
  const rerender = (next: VerificationStatus) =>
    view.rerender(
      <VerificationStatusButton
        {...props}
        status={next}
        announceVerified={announceVerified}
      />,
    )
  return { onVerifiedAnnounced, rerender }
}

it('shows the verified label from when verifying succeeds until it folds away', () => {
  const { onVerifiedAnnounced, rerender } = renderButton('pending')
  wait(VERIFIED_LABEL_SHOWN_MS + VERIFIED_LABEL_EXIT_MS)
  expect(screen.queryByText('Privacy verified')).not.toBeInTheDocument()

  rerender('verified')
  const label = screen.getByText('Privacy verified')
  wait(VERIFIED_LABEL_SHOWN_MS)
  expect(label.closest('[data-leaving]')).not.toBeNull()
  wait(VERIFIED_LABEL_EXIT_MS - 1)
  expect(onVerifiedAnnounced).not.toHaveBeenCalled()
  wait(1)

  expect(onVerifiedAnnounced).toHaveBeenCalledOnce()
})

it('shows only the lock once verifying was announced', () => {
  const { onVerifiedAnnounced } = renderButton('verified', false)
  wait(VERIFIED_LABEL_SHOWN_MS + VERIFIED_LABEL_EXIT_MS)

  expect(screen.queryByText('Privacy verified')).not.toBeInTheDocument()
  expect(onVerifiedAnnounced).not.toHaveBeenCalled()
})
