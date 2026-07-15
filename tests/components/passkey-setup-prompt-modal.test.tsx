import { PasskeySetupPromptModal } from '@/components/modals/passkey-setup-prompt-modal'
import { fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'

describe('PasskeySetupPromptModal', () => {
  it('renders the primary heading and passkey copy', () => {
    render(
      createElement(PasskeySetupPromptModal, {
        isOpen: true,
        onEnable: () => {},
        onDismiss: () => {},
      }),
    )

    expect(
      screen.getByRole('heading', { name: /back up your chats/i }),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/encrypt and back up your chats with a passkey/i),
    ).toBeInTheDocument()
  })

  it('invokes onEnable when the user clicks the primary button', () => {
    const onEnable = vi.fn()
    render(
      createElement(PasskeySetupPromptModal, {
        isOpen: true,
        onEnable,
        onDismiss: () => {},
      }),
    )

    fireEvent.click(
      screen.getByRole('button', { name: /enable with passkey/i }),
    )

    expect(onEnable).toHaveBeenCalledTimes(1)
  })

  it('invokes onDismiss when the user clicks not now', () => {
    const onDismiss = vi.fn()
    render(
      createElement(PasskeySetupPromptModal, {
        isOpen: true,
        onEnable: () => {},
        onDismiss,
      }),
    )

    fireEvent.click(screen.getByRole('button', { name: /not now/i }))

    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('disables both buttons while a setup is in progress', () => {
    const onEnable = vi.fn()
    const onDismiss = vi.fn()
    render(
      createElement(PasskeySetupPromptModal, {
        isOpen: true,
        isBusy: true,
        onEnable,
        onDismiss,
      }),
    )

    const enableButton = screen.getByRole('button', { name: /setting up/i })
    const dismissButton = screen.getByRole('button', { name: /not now/i })

    expect(enableButton).toBeDisabled()
    expect(dismissButton).toBeDisabled()

    fireEvent.click(enableButton)
    fireEvent.click(dismissButton)
    expect(onEnable).not.toHaveBeenCalled()
    expect(onDismiss).not.toHaveBeenCalled()
  })

  it('does not render anything when closed', () => {
    render(
      createElement(PasskeySetupPromptModal, {
        isOpen: false,
        onEnable: () => {},
        onDismiss: () => {},
      }),
    )

    expect(
      screen.queryByRole('heading', { name: /back up your chats/i }),
    ).not.toBeInTheDocument()
  })
})
