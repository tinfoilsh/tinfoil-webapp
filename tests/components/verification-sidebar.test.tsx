import { CONSTANTS } from '@/components/chat/constants'
import { VerifierSidebar } from '@/components/verification-sidebar'
import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { client, signIn } from '../harness-fixture'

vi.mock('@/utils/error-handling', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
}))

beforeEach(() => {
  // The verification center's page is not loaded.
  const setAttribute = HTMLIFrameElement.prototype.setAttribute
  vi.spyOn(HTMLIFrameElement.prototype, 'setAttribute').mockImplementation(
    function (this: HTMLIFrameElement, name, value) {
      if (name !== 'src') setAttribute.call(this, name, value)
    },
  )
  vi.spyOn(HTMLIFrameElement.prototype, 'contentWindow', 'get').mockReturnValue(
    null,
  )
  vi.useFakeTimers()
  signIn()
})

afterEach(() => {
  vi.useRealTimers()
})

function renderOpen(onVerificationComplete: (success: boolean) => void) {
  render(
    <VerifierSidebar
      isOpen
      setIsOpen={vi.fn()}
      onVerificationComplete={onVerificationComplete}
      isDarkMode={false}
      isClient
    />,
  )
}

// Waits out the retry that follows the given failed attempt.
async function waitForRetry(attempt: number) {
  await act(() =>
    vi.advanceTimersByTimeAsync(
      CONSTANTS.VERIFICATION_RETRY_DELAY_MS *
        CONSTANTS.VERIFICATION_RETRY_BACKOFF_FACTOR ** attempt,
    ),
  )
}

it('retries a verification that fails while the connection drops', async () => {
  client.ready
    .mockRejectedValueOnce(new TypeError('Network unavailable'))
    .mockResolvedValue(undefined)
  const onVerificationComplete = vi.fn()
  renderOpen(onVerificationComplete)
  await act(async () => {})
  expect(client.ready).toHaveBeenCalledTimes(1)
  expect(onVerificationComplete).not.toHaveBeenCalled()

  await waitForRetry(0)
  expect(client.ready).toHaveBeenCalledTimes(2)
  expect(onVerificationComplete.mock.calls).toEqual([[true]])
})

it('reports a failure once every retry has failed', async () => {
  client.ready.mockRejectedValue(new TypeError('Network unavailable'))
  const onVerificationComplete = vi.fn()
  renderOpen(onVerificationComplete)
  await act(async () => {})
  for (let attempt = 0; attempt < CONSTANTS.VERIFICATION_MAX_RETRIES; attempt++)
    await waitForRetry(attempt)
  expect(client.ready).toHaveBeenCalledTimes(
    CONSTANTS.VERIFICATION_MAX_RETRIES + 1,
  )
  expect(onVerificationComplete.mock.calls).toEqual([[false]])
})
