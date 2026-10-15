import { SettingsModal } from '@/components/chat/settings-modal'
import { getView, publish } from '@/services/harness/runtime'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const authState = vi.hoisted(() => ({ isSignedIn: false }))

vi.mock('@clerk/react', () => ({
  useAuth: () => ({
    getToken: async () => null,
    signOut: vi.fn(),
    isSignedIn: authState.isSignedIn,
  }),
  useUser: () => ({
    user: authState.isSignedIn ? { id: 'settings-user' } : null,
  }),
}))

vi.mock('@/services/passkey', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/passkey')>()),
  loadPasskeyCredentials: vi.fn().mockResolvedValue([]),
}))

vi.mock('@/services/keys/cloud-key-preflight', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@/services/keys/cloud-key-preflight')
  >()),
  validateCurrentPrimaryKey: vi.fn().mockResolvedValue({
    canWrite: true,
    remoteState: 'exists',
  }),
}))

function Harness(props: Partial<Parameters<typeof SettingsModal>[0]> = {}) {
  return (
    <div
      data-testid="welcome"
      style={{ transform: 'translateY(20px)', overflow: 'hidden' }}
    >
      <h1>Welcome</h1>
      <SettingsModal
        isOpen
        setIsOpen={vi.fn()}
        isDarkMode
        themeMode="dark"
        setThemeMode={vi.fn()}
        isClient={false}
        onOpenPromptLibrary={vi.fn()}
        encryptionKey={null}
        initialTab="general"
        {...props}
      />
    </div>
  )
}

describe('settings opening', () => {
  beforeEach(() => {
    localStorage.clear()
    authState.isSignedIn = false
  })

  it.each([false, true])(
    'uses theme-aware blue for active passkeys (dark: %s)',
    async (isDarkMode) => {
      authState.isSignedIn = true
      render(
        <Harness
          initialTab="cloud-sync"
          isSignedIn
          passkeyActive
          isClient
          isDarkMode={isDarkMode}
          themeMode={isDarkMode ? 'dark' : 'light'}
        />,
      )

      const status = await screen.findByText('Passkey active')
      expect(status).toHaveClass(
        'text-tinfoil-accent-blue',
        'dark:text-blue-400',
      )
      const icon = status.parentElement?.querySelector('svg')
      expect(icon).toHaveClass('text-tinfoil-accent-blue', 'dark:text-blue-400')
      expect(icon?.style.color).toBe('')
    },
  )

  it('keeps account data controls out of the signed-out settings', () => {
    render(
      <Harness
        initialTab="data"
        isSignedIn={false}
        encryptionKey={`key_${'ab'.repeat(32)}`}
      />,
    )
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument()
    for (const name of [
      'Delete all saved chats',
      'Import from Claude',
      'Cloud Sync',
      'Data',
    ])
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument()
  })

  it.each([false, true])(
    'gates project transfers in settings (premium: %s)',
    (isPremium) => {
      authState.isSignedIn = true
      render(
        <Harness
          initialTab="data"
          isSignedIn
          isPremium={isPremium}
          encryptionKey={`key_${'ab'.repeat(32)}`}
        />,
      )
      expect(
        screen.getByRole('button', { name: 'Delete all saved chats' }),
      ).toBeEnabled()
      expect(
        screen.getByRole('button', { name: 'Delete all projects' }),
      ).toBeInTheDocument()
      fireEvent.click(
        screen.getByRole('button', { name: 'Import from Claude' }),
      )
      expect(Boolean(screen.queryByRole('button', { name: 'Projects' }))).toBe(
        isPremium,
      )
      expect(
        Boolean(
          screen.queryByRole('button', { name: 'Export Projects for Claude' }),
        ),
      ).toBe(isPremium)
      fireEvent.click(screen.getAllByRole('button', { name: 'Cloud Sync' })[0])
      expect(
        Boolean(
          screen.queryByRole('button', { name: 'Create Tinfoil Backup' }),
        ),
      ).toBe(isPremium)
      expect(
        Boolean(
          screen.queryByRole('button', { name: 'Restore Tinfoil Backup' }),
        ),
      ).toBe(isPremium)
    },
  )

  it.each([
    { saved: undefined, enabled: false },
    { saved: true, enabled: true },
    { saved: false, enabled: false },
  ])(
    'defaults title redaction to off and respects saved preference $saved',
    async ({ saved, enabled }) => {
      if (saved !== undefined)
        publish({ profile: { pixelateSidebarChatTitlesEnabled: saved } })
      render(<Harness isClient />)
      const toggle = screen.getByRole('checkbox', {
        name: 'Redact sidebar chat titles',
      })
      expect(toggle).toHaveProperty('checked', enabled)

      fireEvent.click(toggle)
      await waitFor(() =>
        expect(getView().profile.pixelateSidebarChatTitlesEnabled).toBe(
          !enabled,
        ),
      )
      expect(toggle).toHaveProperty('checked', !enabled)

      act(() => {
        publish({
          profile: {
            ...getView().profile,
            pixelateSidebarChatTitlesEnabled: enabled,
          },
        })
      })
      expect(toggle).toHaveProperty('checked', enabled)
    },
  )

  it('uses headings around the import buttons and associates each expanded panel', () => {
    authState.isSignedIn = true
    render(<Harness initialTab="data" isSignedIn />)
    for (const provider of ['ChatGPT', 'Claude', 'Tinfoil']) {
      const name = `Import from ${provider}`
      const button = screen.getByRole('button', { name })
      expect(screen.getByRole('heading', { name, level: 3 })).toContainElement(
        button,
      )
      expect(button.querySelector('h3')).toBeNull()
      expect(button).toHaveAttribute('aria-expanded', 'false')
      fireEvent.click(button)
      expect(button).toHaveAttribute('aria-expanded', 'true')
      expect(
        document.getElementById(button.getAttribute('aria-controls')!),
      ).toBeInTheDocument()
    }
  })
  it('opens outside the welcome layout without transparent or scaled frames', () => {
    render(<Harness />)
    const dialog = screen.getByRole('dialog', { name: 'Settings' })
    const panel = dialog.querySelector<HTMLElement>('[data-settings-panel]')!
    expect(screen.getByTestId('welcome')).not.toContainElement(dialog)
    expect(panel.style.opacity).toBe('')
    expect(panel.style.transform).toBe('')
    expect(dialog.querySelector('[data-settings-panel]')).toHaveClass(
      'bg-surface-sidebar',
    )
    expect(document.body).toContainElement(dialog)
  })

  it('focuses the dialog, dismisses with Escape, and restores the opener', async () => {
    function KeyboardHarness() {
      const [isOpen, setIsOpen] = useState(false)
      return (
        <>
          <button onClick={() => setIsOpen(true)}>Open settings</button>
          <Harness isOpen={isOpen} setIsOpen={setIsOpen} />
        </>
      )
    }
    render(<KeyboardHarness />)
    const opener = screen.getByRole('button', { name: 'Open settings' })
    opener.focus()
    fireEvent.click(opener)
    const dialog = await screen.findByRole('dialog', { name: 'Settings' })
    await waitFor(() =>
      expect(dialog).toContainElement(document.activeElement as HTMLElement),
    )
    fireEvent.keyDown(document.activeElement!, {
      key: 'Escape',
      code: 'Escape',
      bubbles: true,
    })
    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', { name: 'Settings' }),
      ).not.toBeInTheDocument(),
    )
    await waitFor(() => expect(opener).toHaveFocus())
  })

  it('keeps the same opaque card through settings updates and closes normally', () => {
    const setIsOpen = vi.fn()
    const { rerender } = render(<Harness setIsOpen={setIsOpen} />)
    const dialog = screen.getByRole('dialog', { name: 'Settings' })
    const panel = dialog.querySelector<HTMLElement>('[data-settings-panel]')!
    rerender(<Harness setIsOpen={setIsOpen} initialTab="chat" />)
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBe(dialog)
    expect(dialog.querySelector('[data-settings-panel]')).toBe(panel)
    expect(panel.style.opacity).toBe('')
    expect(panel.style.transform).toBe('')
    fireEvent.click(
      screen.getAllByRole('button', { name: 'Close settings' })[0],
    )
    expect(setIsOpen).toHaveBeenCalledWith(false)
    rerender(<Harness isOpen={false} />)
    expect(
      screen.queryByRole('dialog', { name: 'Settings' }),
    ).not.toBeInTheDocument()
  })
})
