import { MfaSettingsCard } from '@/components/chat/mfa-settings-card'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const user = {
    totpEnabled: false,
    createTOTP: vi.fn(),
    verifyTOTP: vi.fn(),
    disableTOTP: vi.fn(),
  }

  return {
    user,
    logError: vi.fn(),
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
}))

afterEach(() => {
  vi.clearAllMocks()
  mocks.user.totpEnabled = false
})

describe('MfaSettingsCard', () => {
  it('enrolls an authenticator app and displays new backup codes', async () => {
    mocks.user.createTOTP.mockResolvedValue({
      uri: 'otpauth://totp/Tinfoil:user@example.com?secret=SETUPKEY',
      secret: 'SETUPKEY',
    })
    mocks.user.verifyTOTP.mockImplementation(async () => {
      mocks.user.totpEnabled = true
      return {
        verified: true,
        backupCodes: ['backup-one', 'backup-two'],
      }
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
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('requires confirmation before disabling authenticator MFA', async () => {
    mocks.user.totpEnabled = true
    mocks.user.disableTOTP.mockImplementation(async () => {
      mocks.user.totpEnabled = false
      return {}
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
    expect(screen.getByRole('button', { name: 'Set up' })).toBeInTheDocument()
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
