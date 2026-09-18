import { VerifierSidebar } from '@/components/verification-sidebar'
import { act, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getCachedVerificationDocument: vi.fn(),
  getVerificationDocument: vi.fn(),
}))

vi.mock('@/services/inference/tinfoil-client', () => ({
  getCachedVerificationDocument: mocks.getCachedVerificationDocument,
  getVerificationDocument: mocks.getVerificationDocument,
}))

vi.mock('@/utils/error-handling', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
}))

vi.mock('@/components/chat/constants', async (importOriginal) => {
  const original = await importOriginal<{
    CONSTANTS: Record<string, unknown>
  }>()
  return {
    CONSTANTS: {
      ...original.CONSTANTS,
      VERIFICATION_MAX_RETRIES: 0,
      VERIFICATION_RETRY_DELAY_MS: 0,
    },
  }
})

const VERIFICATION_CENTER_ORIGIN = 'https://verification-center.tinfoil.sh'

function renderSidebar(onVerificationComplete: (success: boolean) => void) {
  return render(
    <VerifierSidebar
      isOpen={false}
      setIsOpen={vi.fn()}
      onVerificationComplete={onVerificationComplete}
      isDarkMode={false}
      isClient={true}
    />,
  )
}

function requestVerificationDocument() {
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: VERIFICATION_CENTER_ORIGIN,
        data: { type: 'TINFOIL_REQUEST_VERIFICATION_DOCUMENT' },
      }),
    )
  })
}

describe('VerifierSidebar', () => {
  let onLineSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    mocks.getCachedVerificationDocument.mockReset()
    mocks.getCachedVerificationDocument.mockReturnValue(null)
    mocks.getVerificationDocument.mockReset()
    onLineSpy = vi.spyOn(window.navigator, 'onLine', 'get')
    // The browser regression covers the remote page; unit tests keep frames local.
    vi.spyOn(HTMLIFrameElement.prototype, 'src', 'get').mockReturnValue(
      'about:blank',
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('preloads on the client while closed and reuses the iframe when opened', async () => {
    const props = {
      isOpen: false,
      setIsOpen: vi.fn(),
      onVerificationComplete: vi.fn(),
      isDarkMode: false,
      isClient: false,
    }
    const { queryByTitle, getByTitle, rerender } = render(
      <VerifierSidebar {...props} />,
    )
    expect(queryByTitle('Tinfoil Verification Center')).not.toBeInTheDocument()

    rerender(<VerifierSidebar {...props} isClient />)
    const iframe = getByTitle(
      'Tinfoil Verification Center',
    ) as HTMLIFrameElement
    const source = iframe.getAttribute('src')
    expect(source).toContain(VERIFICATION_CENTER_ORIGIN)
    expect(iframe).toHaveAttribute('loading', 'eager')
    expect(iframe.parentElement).toHaveAttribute('inert')
    expect(mocks.getVerificationDocument).not.toHaveBeenCalled()
    expect(mocks.getCachedVerificationDocument).not.toHaveBeenCalled()

    const postMessage = vi
      .spyOn(iframe.contentWindow!, 'postMessage')
      .mockImplementation(() => {})
    fireEvent.load(iframe)
    expect(postMessage).toHaveBeenCalledWith(
      { type: 'TINFOIL_VERIFICATION_CENTER_CLOSE' },
      VERIFICATION_CENTER_ORIGIN,
    )

    const document = { securityVerified: true }
    mocks.getCachedVerificationDocument.mockReturnValue(document)
    rerender(<VerifierSidebar {...props} isClient isOpen />)
    expect(getByTitle('Tinfoil Verification Center')).toBe(iframe)
    expect(iframe.getAttribute('src')).toBe(source)
    expect(iframe.parentElement).not.toHaveAttribute('inert')
    await waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith(
        { type: 'TINFOIL_VERIFICATION_DOCUMENT', document },
        VERIFICATION_CENTER_ORIGIN,
      ),
    )
    expect(props.onVerificationComplete).toHaveBeenCalledWith(true)
    expect(mocks.getVerificationDocument).not.toHaveBeenCalled()

    rerender(<VerifierSidebar {...props} isClient />)
    expect(iframe.parentElement).toHaveAttribute('inert')
    rerender(<VerifierSidebar {...props} isClient isOpen />)
    expect(getByTitle('Tinfoil Verification Center')).toBe(iframe)
    expect(iframe.getAttribute('src')).toBe(source)
  })

  it('keeps a previously successful verification when fetching offline', async () => {
    // Offline: retry attempts short-circuit, but the cached attestation from
    // startup verification is still available without network work.
    onLineSpy.mockReturnValue(false)
    mocks.getCachedVerificationDocument.mockReturnValue({
      securityVerified: true,
    })
    const onVerificationComplete = vi.fn()

    renderSidebar(onVerificationComplete)
    requestVerificationDocument()

    expect(onVerificationComplete).toHaveBeenCalled()
    expect(onVerificationComplete).toHaveBeenCalledWith(true)
    expect(onVerificationComplete).not.toHaveBeenCalledWith(false)
    expect(mocks.getVerificationDocument).not.toHaveBeenCalled()
  })

  it('reports offline exhaustion without starting initialization', async () => {
    onLineSpy.mockReturnValue(false)
    const onVerificationComplete = vi.fn()

    renderSidebar(onVerificationComplete)
    requestVerificationDocument()

    await waitFor(() =>
      expect(onVerificationComplete).toHaveBeenCalledWith(false),
    )
    expect(mocks.getVerificationDocument).not.toHaveBeenCalled()
    expect(mocks.getCachedVerificationDocument).toHaveBeenCalledTimes(2)
  })

  it('keeps the retry lock through the cache fallback', async () => {
    onLineSpy.mockReturnValue(true)
    mocks.getVerificationDocument.mockResolvedValue(null)
    mocks.getCachedVerificationDocument.mockImplementation(() => {
      requestVerificationDocument()
      return null
    })
    const onVerificationComplete = vi.fn()

    renderSidebar(onVerificationComplete)
    requestVerificationDocument()

    await waitFor(() =>
      expect(onVerificationComplete).toHaveBeenCalledWith(false),
    )
    expect(mocks.getVerificationDocument).toHaveBeenCalledOnce()
    expect(onVerificationComplete).toHaveBeenCalledOnce()
  })
})
