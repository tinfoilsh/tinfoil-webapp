import { CloudSyncSetupModal } from '@/components/modals/cloud-sync-setup-modal'
import * as setupMode from '@/components/modals/cloud-sync-setup-mode'
import { SETTINGS_HAS_SEEN_CLOUD_SYNC_MODAL } from '@/constants/storage-keys'
import { encryptionService } from '@/services/encryption/encryption-service'
import { PasskeyTimeoutError, PrfNotSupportedError } from '@/services/passkey'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
}))

vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: mocks.toast }),
}))

vi.mock('@/utils/error-handling', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
}))

const baseProps = {
  isOpen: true,
  onClose: vi.fn(),
  onSetupComplete:
    vi.fn<
      (
        key: string,
        mode: setupMode.CloudKeySetupMode,
      ) => Promise<setupMode.CloudKeySetupResult>
    >(),
  isDarkMode: false,
}

beforeEach(() => {
  baseProps.onSetupComplete
    .mockReset()
    .mockRejectedValue(new Error('Unexpected key activation'))
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('CloudSyncSetupModal onboarding', () => {
  it('starts passkey setup directly from the intro card', async () => {
    const onSetupWithPasskey = vi.fn(async () => true)
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
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    expect(
      await screen.findByRole('heading', { name: 'Success!' }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('heading', { name: 'Encryption Key' }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('heading', { name: 'Setup Failed' }),
    ).not.toBeInTheDocument()
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

    expect(
      await screen.findByRole('heading', { name: 'Setup Failed' }),
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        'Could not create passkey backup. You can try again later.',
      ),
    ).toBeInTheDocument()
  })

  it.each([
    ['Passkey Provider Not Supported', new PrfNotSupportedError()],
    ['Passkey Setup Timed Out', new PasskeyTimeoutError()],
  ])('explains a passkey setup failure: %s', async (title, error) => {
    render(
      <CloudSyncSetupModal
        {...baseProps}
        prfSupported
        onSetupWithPasskey={vi.fn().mockRejectedValue(error)}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    expect(
      await screen.findByRole('heading', { name: title }),
    ).toBeInTheDocument()
    expect(screen.getByText(error.message)).toBeInTheDocument()
  })

  it('remembers the intro was seen when dismissed with Maybe later', () => {
    const onClose = vi.fn()
    render(<CloudSyncSetupModal {...baseProps} onClose={onClose} />)

    fireEvent.click(screen.getByRole('button', { name: 'Maybe later' }))

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem(SETTINGS_HAS_SEEN_CLOUD_SYNC_MODAL)).toBe(
      'true',
    )
  })

  it('shows a generated encryption key before activating it', async () => {
    let finishGeneration!: (key: string) => void
    const generateKey = vi
      .spyOn(encryptionService, 'generateKey')
      .mockReturnValue(
        new Promise<string>((resolve) => {
          finishGeneration = resolve
        }),
      )
    vi.spyOn(setupMode, 'determineGeneratedKeySetupMode').mockResolvedValue(
      'recoverExisting',
    )
    baseProps.onSetupComplete.mockResolvedValue({ ok: true })
    render(<CloudSyncSetupModal {...baseProps} />)

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByRole('heading', { name: 'Encryption Key' })
    fireEvent.click(
      screen.getByRole('button', { name: 'Generate Encryption Key' }),
    )

    expect(screen.getByRole('button', { name: 'Generating...' })).toBeDisabled()
    expect(generateKey).toHaveBeenCalledTimes(1)
    const generatedKey = 'key_generated-for-setup'
    await act(async () => {
      finishGeneration(generatedKey)
    })
    expect(await screen.findByText(generatedKey)).toBeInTheDocument()
    const complete = screen.getByRole('button', { name: "Let's go!" })
    expect(complete).toBeEnabled()
    expect(baseProps.onSetupComplete).not.toHaveBeenCalled()
    fireEvent.click(complete)
    await waitFor(() =>
      expect(baseProps.onSetupComplete).toHaveBeenCalledExactlyOnceWith(
        generatedKey,
        'recoverExisting',
      ),
    )
    await waitFor(() => expect(baseProps.onClose).toHaveBeenCalledTimes(1))
  })

  it('disables intro actions while passkey setup is in progress', () => {
    render(
      <CloudSyncSetupModal
        {...baseProps}
        onSetupWithPasskey={vi.fn(async () => true)}
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

  it('explains passkey failures while starting fresh', async () => {
    const error = new PasskeyTimeoutError()
    render(
      <CloudSyncSetupModal
        {...baseProps}
        passkeyRecoveryNeeded
        onRecoverWithPasskey={vi.fn()}
        onSetupNewKey={vi.fn().mockRejectedValue(error)}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Start Fresh' }))
    fireEvent.click(
      await screen.findByRole('button', { name: 'Yes, start fresh' }),
    )

    expect(
      await screen.findByRole('heading', { name: 'Passkey Setup Timed Out' }),
    ).toBeInTheDocument()
    expect(screen.getByText(error.message)).toBeInTheDocument()
  })

  it('does not restrict the native recovery-key file picker', async () => {
    render(<CloudSyncSetupModal {...baseProps} manualRecoveryNeeded />)

    fireEvent.click(
      screen.getByRole('button', { name: 'Restore Encryption Key' }),
    )
    await screen.findByRole('heading', { name: 'Restore Encryption Key' })

    const fileInput =
      document.querySelector<HTMLInputElement>('input[type="file"]')
    expect(fileInput?.accept).toBe('')
  })
})
