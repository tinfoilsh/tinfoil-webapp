import { SettingsModal } from '@/components/chat/settings-modal'
import {
  SETTINGS_CLOUD_SYNC_ENABLED,
  SETTINGS_CLOUD_SYNC_EXPLICITLY_DISABLED,
  SETTINGS_LOCAL_ONLY_MODE_ENABLED,
} from '@/constants/storage-keys'
import { getView, publish } from '@/services/harness/runtime'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const authState = vi.hoisted(() => ({ isSignedIn: false }))
const toasts = vi.hoisted(() => vi.fn())

vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: toasts }),
}))

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
        onDeleteAllChats={vi.fn()}
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
    toasts.mockReset()
  })

  it.each([false, true])(
    'uses theme-aware blue for active passkeys (dark: %s)',
    async (isDarkMode) => {
      authState.isSignedIn = true
      localStorage.setItem(SETTINGS_CLOUD_SYNC_ENABLED, 'true')
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
      localStorage.setItem(SETTINGS_CLOUD_SYNC_ENABLED, 'true')
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
    localStorage.setItem(SETTINGS_CLOUD_SYNC_ENABLED, 'true')
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

  describe('without cloud sync', () => {
    beforeEach(() => {
      authState.isSignedIn = true
    })

    it('keeps import, export, and project data controls with cloud sync', () => {
      render(
        <Harness
          initialTab="data"
          isSignedIn
          isPremium
          encryptionKey={`key_${'ab'.repeat(32)}`}
        />,
      )
      expect(
        screen.getByRole('button', { name: 'Delete all saved chats' }),
      ).toBeEnabled()
      expect(
        screen.getByText(
          'Permanently delete every chat from this device. This cannot be undone.',
        ),
      ).toBeInTheDocument()
      for (const name of [
        'Delete all projects',
        'Import from ChatGPT',
        'Export Chats',
        'Export Projects for Claude',
      ])
        expect(screen.queryByRole('button', { name })).not.toBeInTheDocument()
      expect(
        screen.getByText(
          /Importing and exporting chats requires end-to-end encrypted cloud sync/,
        ),
      ).toBeInTheDocument()
    })

    it('deletes the chats on this device', async () => {
      const onDeleteAllChats = vi.fn(async () => ({
        cloudDeletionCompleted: false,
      }))
      const onAllChatsDeleted = vi.fn()
      render(
        <Harness
          initialTab="data"
          isSignedIn
          isClient
          onDeleteAllChats={onDeleteAllChats}
          onAllChatsDeleted={onAllChatsDeleted}
        />,
      )
      fireEvent.click(
        screen.getByRole('button', { name: 'Delete all saved chats' }),
      )
      fireEvent.change(screen.getByPlaceholderText('delete all chats'), {
        target: { value: 'delete all chats' },
      })
      fireEvent.click(
        screen.getByRole('button', { name: 'Yes, delete all my chats' }),
      )

      await waitFor(() => expect(onAllChatsDeleted).toHaveBeenCalledOnce())
      expect(onDeleteAllChats).toHaveBeenCalledOnce()
      expect(toasts).toHaveBeenCalledExactlyOnceWith({
        title: 'All chats deleted',
        description: 'Removed all chats from this device.',
      })
    })

    it('opens the key setup instead of turning sync on without a key', async () => {
      const setIsOpen = vi.fn()
      const onCloudSyncSetupClick = vi.fn()
      render(
        <Harness
          initialTab="cloud-sync"
          isSignedIn
          setIsOpen={setIsOpen}
          onCloudSyncSetupClick={onCloudSyncSetupClick}
        />,
      )
      expect(
        screen.queryByRole('checkbox', { name: 'Enable local chats' }),
      ).not.toBeInTheDocument()
      const toggle = screen.getByRole('checkbox', {
        name: 'Encrypted Cloud Sync',
      })
      expect(toggle).not.toBeChecked()

      fireEvent.click(toggle)

      await waitFor(() => expect(onCloudSyncSetupClick).toHaveBeenCalledOnce())
      expect(setIsOpen).toHaveBeenCalledWith(false)
      expect(localStorage.getItem(SETTINGS_CLOUD_SYNC_ENABLED)).toBeNull()
    })

    it('turns sync on and off with a key and offers local chats while on', async () => {
      render(
        <Harness
          initialTab="cloud-sync"
          isSignedIn
          encryptionKey={`key_${'ab'.repeat(32)}`}
        />,
      )
      fireEvent.click(
        screen.getByRole('checkbox', { name: 'Encrypted Cloud Sync' }),
      )
      await waitFor(() =>
        expect(
          screen.getByRole('checkbox', { name: 'Encrypted Cloud Sync' }),
        ).toBeChecked(),
      )
      expect(localStorage.getItem(SETTINGS_CLOUD_SYNC_ENABLED)).toBe('true')

      const localChats = screen.getByRole('checkbox', {
        name: 'Enable local chats',
      })
      expect(localChats).not.toBeChecked()
      fireEvent.click(localChats)
      await waitFor(() => expect(localChats).toBeChecked())
      expect(localStorage.getItem(SETTINGS_LOCAL_ONLY_MODE_ENABLED)).toBe(
        'true',
      )
      expect(
        screen.getByText(
          'Local chats will be permanently erased when you sign out. Treat local chats as temporary.',
        ),
      ).toBeInTheDocument()

      fireEvent.click(
        screen.getByRole('checkbox', { name: 'Encrypted Cloud Sync' }),
      )
      await waitFor(() =>
        expect(
          screen.getByRole('checkbox', { name: 'Encrypted Cloud Sync' }),
        ).not.toBeChecked(),
      )
      expect(localStorage.getItem(SETTINGS_CLOUD_SYNC_ENABLED)).toBe('false')
      expect(
        localStorage.getItem(SETTINGS_CLOUD_SYNC_EXPLICITLY_DISABLED),
      ).toBe('true')
      expect(
        screen.queryByRole('checkbox', { name: 'Enable local chats' }),
      ).not.toBeInTheDocument()
    })
  })
})
