import { MfaSettingsCard } from '@/components/chat/mfa-settings-card'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const user = {
    id: 'user_123',
    totpEnabled: false,
    createTOTP: vi.fn(),
    verifyTOTP: vi.fn(),
    disableTOTP: vi.fn(),
    reload: vi.fn(),
  }

  return {
    user,
    logError: vi.fn(),
    logWarning: vi.fn(),
    createObjectURL: vi.fn(),
    revokeObjectURL: vi.fn(),
  }
})

vi.mock('@clerk/nextjs', () => ({
  useUser: () => ({
    isLoaded: true,
    user: mocks.user,
  }),
  useReverification: (operation: (...args: unknown[]) => unknown) => operation,
}))

vi.mock('@clerk/nextjs/errors', () => ({
  isReverificationCancelledError: () => false,
}))

vi.mock('@/utils/error-handling', () => ({
  logError: mocks.logError,
  logWarning: mocks.logWarning,
}))

beforeEach(() => {
  vi.resetAllMocks()
  mocks.user.totpEnabled = false
  mocks.user.reload.mockResolvedValue(mocks.user)
  mocks.createObjectURL.mockReturnValue('blob:backup-codes')
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: mocks.createObjectURL,
  })
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: mocks.revokeObjectURL,
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('MfaSettingsCard', () => {
  it('enrolls an authenticator app and displays new backup codes', async () => {
    mocks.user.createTOTP.mockResolvedValue({
      uri: 'otpauth://totp/Tinfoil:user@example.com?secret=SETUPKEY',
      secret: 'SETUPKEY',
    })
    mocks.user.verifyTOTP.mockResolvedValue({
      verified: true,
      backupCodes: ['backup-one', 'backup-two'],
    })
    mocks.user.reload.mockImplementation(async () => {
      mocks.user.totpEnabled = true
      return mocks.user
    })

    render(<MfaSettingsCard isDarkMode />)

    fireEvent.click(screen.getByRole('button', { name: 'Set up' }))

    expect(await screen.findByTestId('totp-qr-code')).toBeInTheDocument()
    expect(screen.getByText('SETUPKEY')).toBeInTheDocument()
    expect(mocks.user.createTOTP).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Copy setup key' }))
    expect(
      await screen.findByRole('button', { name: 'Setup key copied' }),
    ).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Enter the 6-digit code'), {
      target: { value: '12a3456' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Verify and enable' }))

    await waitFor(() => {
      expect(mocks.user.verifyTOTP).toHaveBeenCalledWith({ code: '123456' })
    })
    expect(
      await screen.findByText('Authenticator app enabled'),
    ).toBeInTheDocument()
    expect(screen.getByText('backup-one')).toBeInTheDocument()
    expect(screen.getByText('backup-two')).toBeInTheDocument()
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    await waitFor(() => {
      expect(dialog).toContainElement(document.activeElement as HTMLElement)
    })
    expect(mocks.user.reload).toHaveBeenCalledTimes(1)

    const appendChild = vi.spyOn(document.body, 'appendChild')
    const anchorClick = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {})

    fireEvent.click(screen.getByRole('button', { name: 'Download .txt' }))

    const anchor = appendChild.mock.calls[0][0] as HTMLAnchorElement
    expect(anchor.download).toBe('tinfoil-backup-codes.txt')
    expect(anchor.href).toBe('blob:backup-codes')
    expect(anchorClick).toHaveBeenCalledTimes(1)
    expect(mocks.revokeObjectURL).toHaveBeenCalledWith('blob:backup-codes')
    const backupCodesFile = mocks.createObjectURL.mock.calls[0][0] as Blob
    expect(await backupCodesFile.text()).toBe(
      'Tinfoil backup codes\n\nbackup-one\nbackup-two\n',
    )

    fireEvent.keyDown(document, { key: 'Escape' })

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: 'Turn off' })).toHaveFocus()
  })

  it('requires confirmation before disabling authenticator MFA', async () => {
    mocks.user.totpEnabled = true
    mocks.user.disableTOTP.mockResolvedValue({})
    mocks.user.reload.mockImplementation(async () => {
      mocks.user.totpEnabled = false
      return mocks.user
    })

    render(<MfaSettingsCard isDarkMode={false} />)

    fireEvent.click(screen.getByRole('button', { name: 'Turn off' }))

    expect(
      screen.getByRole('heading', {
        name: 'Turn off authenticator MFA?',
      }),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Turn off' }))

    await waitFor(() => {
      expect(mocks.user.disableTOTP).toHaveBeenCalledTimes(1)
    })
    expect(mocks.user.reload).toHaveBeenCalledTimes(1)
    expect(
      await screen.findByRole('button', { name: 'Set up' }),
    ).toBeInTheDocument()
  })

  it('keeps the enabled status when refreshing Clerk fails', async () => {
    mocks.user.createTOTP.mockResolvedValue({
      uri: 'otpauth://totp/Tinfoil:user@example.com?secret=SETUPKEY',
      secret: 'SETUPKEY',
    })
    mocks.user.verifyTOTP.mockResolvedValue({
      verified: true,
      backupCodes: [],
    })
    mocks.user.reload.mockRejectedValue(new Error('Refresh failed'))

    render(<MfaSettingsCard isDarkMode />)

    fireEvent.click(screen.getByRole('button', { name: 'Set up' }))
    await screen.findByTestId('totp-qr-code')
    fireEvent.change(screen.getByLabelText('Enter the 6-digit code'), {
      target: { value: '123456' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Verify and enable' }))

    await screen.findByRole('dialog')
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))

    expect(screen.getByText('On')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Turn off' })).toBeInTheDocument()
    expect(mocks.logWarning).toHaveBeenCalledTimes(1)
  })

  it('shows Clerk verification errors without completing setup', async () => {
    mocks.user.createTOTP.mockResolvedValue({
      uri: 'otpauth://totp/Tinfoil:user@example.com?secret=SETUPKEY',
      secret: 'SETUPKEY',
    })
    mocks.user.verifyTOTP.mockRejectedValue({
      errors: [{ longMessage: 'The code is incorrect.' }],
    })

    render(<MfaSettingsCard isDarkMode />)

    fireEvent.click(screen.getByRole('button', { name: 'Set up' }))
    await screen.findByTestId('totp-qr-code')
    fireEvent.change(screen.getByLabelText('Enter the 6-digit code'), {
      target: { value: '123456' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Verify and enable' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The code is incorrect.',
    )
    expect(screen.getByTestId('totp-qr-code')).toBeInTheDocument()
    expect(mocks.logError).toHaveBeenCalledTimes(1)
  })
})
