import { SettingsModal } from '@/components/chat/settings-modal'
import { SETTINGS_PIXELATE_SIDEBAR_CHAT_TITLES_ENABLED } from '@/constants/storage-keys'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@clerk/nextjs', () => ({
  useAuth: () => ({
    getToken: async () => null,
    signOut: vi.fn(),
    isSignedIn: false,
  }),
  useUser: () => ({ user: null }),
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
  })

  it.each([
    { saved: null, enabled: false },
    { saved: 'true', enabled: true },
    { saved: 'false', enabled: false },
  ])(
    'defaults title redaction to off and respects saved preference $saved',
    ({ saved, enabled }) => {
      if (saved !== null) {
        localStorage.setItem(
          SETTINGS_PIXELATE_SIDEBAR_CHAT_TITLES_ENABLED,
          saved,
        )
      }
      render(<Harness isClient />)
      const toggle = screen.getByRole('checkbox', {
        name: 'Redact sidebar chat titles',
      })
      expect(toggle).toHaveProperty('checked', enabled)

      fireEvent.click(toggle)
      expect(
        localStorage.getItem(SETTINGS_PIXELATE_SIDEBAR_CHAT_TITLES_ENABLED),
      ).toBe(String(!enabled))

      act(() => {
        localStorage.removeItem(SETTINGS_PIXELATE_SIDEBAR_CHAT_TITLES_ENABLED)
        window.dispatchEvent(
          new StorageEvent('storage', {
            key: SETTINGS_PIXELATE_SIDEBAR_CHAT_TITLES_ENABLED,
            newValue: null,
          }),
        )
      })
      expect(toggle).not.toBeChecked()
    },
  )

  it('uses headings around the import buttons and associates each expanded panel', () => {
    render(<Harness initialTab="data" />)
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
