import { CloudSyncSetupModal } from '@/components/modals/cloud-sync-setup-modal'
import { encryptionService } from '@/services/encryption/encryption-service'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  logError: vi.fn(),
}))

vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: mocks.toast }),
}))

vi.mock('@/utils/error-handling', () => ({
  logError: mocks.logError,
  logInfo: vi.fn(),
}))

const baseProps = {
  isOpen: true,
  onClose: vi.fn(),
  onSetupComplete: vi.fn(),
  isDarkMode: false,
}

afterEach(() => {
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

describe('CloudSyncSetupModal onboarding', () => {
  it('starts passkey setup directly from the intro card', () => {
    const onSetupWithPasskey = vi.fn(async () => {})
    render(
      <CloudSyncSetupModal
        {...baseProps}
        prfSupported
        onSetupWithPasskey={onSetupWithPasskey}
      />,
    )

    expect(
      screen.getByRole('heading', { name: 'Encrypted Backups & Sync' }),
    ).toBeInTheDocument()
    expect(
      document.querySelector('[class*="bg-[#F9F8F6]"]'),
    ).toBeInTheDocument()
    expect(document.querySelector('svg[class*="h-20"]')).toBeInTheDocument()
    expect(
      document.querySelector('[class*="max-h-[40rem]"]'),
    ).toBeInTheDocument()
    expect(document.querySelector('.backdrop-blur-md')).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: 'Encrypted Backups & Sync' }),
    ).toHaveClass('text-center')

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    expect(
      screen.getByRole('heading', { name: 'Encrypted Backups & Sync' }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Enable with Passkey' }),
    ).not.toBeInTheDocument()
    expect(onSetupWithPasskey).toHaveBeenCalledTimes(1)
  })

  it('reports unexpected passkey setup failures', async () => {
    const error = new Error('Passkey unavailable')
    render(
      <CloudSyncSetupModal
        {...baseProps}
        prfSupported
        onSetupWithPasskey={vi.fn().mockRejectedValue(error)}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    await waitFor(() => {
      expect(mocks.logError).toHaveBeenCalledWith(
        'Could not start passkey setup',
        error,
        {
          component: 'CloudSyncSetupModal',
          action: 'handleContinue',
        },
      )
    })
    expect(
      await screen.findByRole('heading', { name: 'Setup Failed' }),
    ).toBeInTheDocument()
  })

  it('shows the intro before manual key setup', async () => {
    render(<CloudSyncSetupModal {...baseProps} />)

    expect(
      screen.getByRole('heading', { name: 'Encrypted Backups & Sync' }),
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    expect(
      await screen.findByRole('heading', { name: 'Encryption Key' }),
    ).toBeInTheDocument()
    expect(
      document.querySelector('[class*="bg-[#F9F8F6]"]'),
    ).toBeInTheDocument()
    expect(document.querySelector('svg[class*="h-20"]')).toBeInTheDocument()
    expect(
      screen.getByText(
        'This device does not have a passkey. You can generate a new personal encryption key or restore an existing one from another device. Your chats will be encrypted and synced with this personal key.',
      ),
    ).toHaveClass('text-balance', 'text-center', 'leading-relaxed')
    const restoreKeyButton = screen.getByRole('button', {
      name: 'Restore Encryption Key',
    })
    expect(restoreKeyButton).toHaveClass(
      'bg-brand-accent-dark-darker',
      'h-auto',
      'py-3.5',
      'rounded',
      'font-aeonik-fono',
    )
    expect(restoreKeyButton.parentElement?.parentElement).toHaveClass(
      'mt-auto',
      'pt-4',
      'grid',
      'w-full',
      'max-w-full',
      'sm:grid-cols-2',
    )
    expect(screen.getByText('Have an existing key?')).toHaveClass('text-center')
    expect(screen.getByText('First time set up?')).toHaveClass('text-center')
    expect(
      screen.getByRole('button', { name: 'Generate Encryption Key' }),
    ).toHaveClass(
      'border-border-subtle',
      'bg-surface-card',
      'font-aeonik-fono',
      'h-auto',
      'py-3.5',
      'w-full',
    )
    expect(
      screen.queryByRole('button', { name: 'Back' }),
    ).not.toBeInTheDocument()
  })

  it('closes from the top-right button on the intro step', () => {
    const onClose = vi.fn()
    render(<CloudSyncSetupModal {...baseProps} onClose={onClose} />)

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('shows a spinner while generating an encryption key', async () => {
    vi.spyOn(encryptionService, 'generateKey').mockReturnValue(
      new Promise<string>(() => {}),
    )
    render(<CloudSyncSetupModal {...baseProps} />)

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByRole('heading', { name: 'Encryption Key' })
    fireEvent.click(
      screen.getByRole('button', { name: 'Generate Encryption Key' }),
    )

    expect(screen.getByRole('button', { name: 'Generating...' })).toBeDisabled()
    expect(screen.getByTestId('generate-key-spinner')).toHaveClass(
      'animate-spin',
    )
  })

  it('disables intro actions while passkey setup is in progress', () => {
    render(
      <CloudSyncSetupModal
        {...baseProps}
        onSetupWithPasskey={vi.fn(async () => {})}
        isPasskeySetupBusy
      />,
    )

    expect(screen.getByRole('button', { name: 'Setting up...' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Maybe later' })).toBeDisabled()
  })

  it('bypasses the intro for passkey recovery', () => {
    render(
      <CloudSyncSetupModal
        {...baseProps}
        passkeyRecoveryNeeded
        onRecoverWithPasskey={vi.fn()}
        onSetupNewKey={vi.fn()}
      />,
    )

    expect(
      screen.getByRole('heading', { name: 'Unlock Your Chats' }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('heading', { name: 'Encrypted Backups & Sync' }),
    ).not.toBeInTheDocument()
    expect(document.querySelector('svg[class*="h-20"]')).toBeInTheDocument()
    const unlockButton = screen.getByRole('button', {
      name: 'Unlock with Passkey',
    })
    const enterKeyButton = screen.getByRole('button', {
      name: 'Enter Key Manually',
    })
    const startFreshButton = screen.getByRole('button', {
      name: 'Start Fresh',
    })
    expect(unlockButton.querySelector('svg')).toBeInTheDocument()
    expect(unlockButton.parentElement).toHaveClass(
      'flex',
      'flex-1',
      'flex-col',
      'items-center',
      'justify-center',
    )
    expect(enterKeyButton.parentElement).toHaveClass(
      'grid',
      'w-fit',
      'grid-cols-1',
      'sm:grid-cols-2',
    )
    expect(startFreshButton.parentElement).toBe(enterKeyButton.parentElement)
    expect(enterKeyButton).toHaveClass('w-full', 'font-aeonik-fono')
    expect(startFreshButton).toHaveClass('w-full', 'font-aeonik-fono')
    screen.getAllByRole('button').forEach((button) => {
      expect(button).toHaveClass('inline-flex')
    })
  })

  it('bypasses the intro for manual recovery', () => {
    render(<CloudSyncSetupModal {...baseProps} manualRecoveryNeeded />)

    expect(
      screen.getByRole('heading', { name: 'Encryption Key' }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('heading', { name: 'Encrypted Backups & Sync' }),
    ).not.toBeInTheDocument()
  })
})
