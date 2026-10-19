import { ReportBugModal } from '@/components/modals/report-bug-modal'
import { SUPPORT_EMAIL } from '@/constants/external-links'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/config', () => ({
  APP_VERSION: '1.2.3',
}))

const toast = vi.fn()
vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast }),
}))

function renderModal(selectedModel?: string) {
  return render(
    <ReportBugModal
      isOpen
      onClose={vi.fn()}
      isDarkMode={false}
      selectedModel={selectedModel}
    />,
  )
}

describe('ReportBugModal', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    toast.mockClear()
  })

  it('opens a mailto link with the description and diagnostic context', () => {
    let navigatedTo = ''
    const location = { ...window.location, href: '' }
    Object.defineProperty(location, 'href', {
      get: () =>
        'https://chat.tinfoil.sh/c/123?q=private-prompt#send=private-message',
      set: (value: string) => {
        navigatedTo = value
      },
    })
    vi.spyOn(window, 'location', 'get').mockReturnValue(location as Location)

    renderModal('gpt-oss-120b')

    const send = screen.getByRole('button', { name: 'Open email client' })
    expect(send).toBeDisabled()

    fireEvent.change(screen.getByPlaceholderText(/What went wrong/), {
      target: { value: 'The send button stopped working' },
    })
    fireEvent.click(send)

    const prefix = `mailto:${SUPPORT_EMAIL}?`
    expect(navigatedTo.startsWith(prefix)).toBe(true)
    const params = new URLSearchParams(navigatedTo.slice(prefix.length))
    expect(params.get('subject')).toBe('Tinfoil Chat bug report')
    const body = params.get('body') ?? ''
    expect(body).toContain('The send button stopped working')
    expect(body).toContain('App version: 1.2.3')
    expect(body).toContain('Model: gpt-oss-120b')
    expect(body).toContain(`Browser: ${navigator.userAgent}`)
    expect(body).not.toContain('chat.tinfoil.sh')
    expect(body).not.toContain('/c/123')
    expect(body).not.toContain('private-prompt')
    expect(body).not.toContain('private-message')
    expect(body).not.toContain('?q=')
    expect(body).not.toContain('#send=')
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({
        description: expect.stringContaining(SUPPORT_EMAIL),
      }),
    )
  })

  it('copies the support address as a fallback', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })

    renderModal()
    fireEvent.click(
      screen.getByRole('button', { name: `Copy ${SUPPORT_EMAIL}` }),
    )

    expect(writeText).toHaveBeenCalledWith(SUPPORT_EMAIL)
    expect(
      await screen.findByRole('button', { name: 'Email address copied' }),
    ).toBeInTheDocument()
  })

  it('shows the email fallback when copying is rejected', async () => {
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: {
        writeText: vi.fn().mockRejectedValue(new Error('Permission denied')),
      },
    })
    renderModal()
    fireEvent.click(
      screen.getByRole('button', { name: `Copy ${SUPPORT_EMAIL}` }),
    )
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith({
        title: 'Copy failed',
        description: `Email us at ${SUPPORT_EMAIL}.`,
        variant: 'destructive',
      }),
    )
    expect(
      screen.queryByRole('button', { name: 'Email address copied' }),
    ).not.toBeInTheDocument()
  })

  it('clears the draft when the parent closes the modal directly', () => {
    const { rerender } = renderModal()
    fireEvent.change(screen.getByRole('textbox', { name: 'Bug description' }), {
      target: { value: 'Unsubmitted report' },
    })
    rerender(
      <ReportBugModal isOpen={false} onClose={vi.fn()} isDarkMode={false} />,
    )
    rerender(<ReportBugModal isOpen onClose={vi.fn()} isDarkMode={false} />)
    expect(
      screen.getByRole('textbox', { name: 'Bug description' }),
    ).toHaveValue('')
    expect(
      screen.getByRole('button', { name: 'Open email client' }),
    ).toBeDisabled()
  })
})
