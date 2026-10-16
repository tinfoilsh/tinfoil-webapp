import { SettingsModal } from '@/components/chat/settings-modal'
import {
  SETTINGS_CLOUD_SYNC_ENABLED,
  SETTINGS_CLOUD_SYNC_EXPLICITLY_DISABLED,
  SETTINGS_LOCAL_ONLY_MODE_ENABLED,
} from '@/constants/storage-keys'
import { getView, harnessAPI, publish } from '@/services/harness/runtime'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { testSession } from '../../harness-fixture'

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
  )
}

describe('settings opening', () => {
  beforeEach(() => {
    localStorage.clear()
    authState.isSignedIn = false
    toasts.mockReset()
  })

  it("offers a signed-out visitor this browser's chats but no account data", () => {
    render(
      <Harness
        initialTab="data"
        isSignedIn={false}
        isPremium
        encryptionKey={`key_${'ab'.repeat(32)}`}
      />,
    )
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument()
    expect(
      screen.getAllByRole('button', { name: 'Data' }).length,
    ).toBeGreaterThan(0)
    expect(
      screen.getByRole('button', { name: 'Delete all saved chats' }),
    ).toBeEnabled()
    expect(
      screen.getByText(
        'Permanently delete every chat from this browser. This cannot be undone.',
      ),
    ).toBeInTheDocument()
    for (const name of [
      'Import from ChatGPT',
      'Import from Claude',
      'Import from Tinfoil',
      'Export Chats',
    ])
      expect(screen.getByRole('button', { name })).toBeEnabled()
    for (const name of [
      'Cloud Sync',
      'Delete all projects',
      'Export Projects for Claude',
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

  describe('without cloud sync', () => {
    beforeEach(() => {
      authState.isSignedIn = true
    })

    it('keeps project data controls with cloud sync', () => {
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
        'Import from ChatGPT',
        'Import from Claude',
        'Import from Tinfoil',
        'Export Chats',
      ])
        expect(screen.getByRole('button', { name })).toBeEnabled()
      for (const name of ['Delete all projects', 'Export Projects for Claude'])
        expect(screen.queryByRole('button', { name })).not.toBeInTheDocument()
      expect(
        screen.queryByText(/requires end-to-end encrypted cloud sync/),
      ).not.toBeInTheDocument()
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

    it.each([
      { key: true, available: true },
      { key: false, available: false },
    ])(
      'offers native backups with a key, as on main (key: $key)',
      ({ key, available }) => {
        render(
          <Harness
            initialTab="cloud-sync"
            isSignedIn
            isPremium
            encryptionKey={key ? `key_${'ab'.repeat(32)}` : null}
          />,
        )
        for (const name of ['Create Tinfoil Backup', 'Restore Tinfoil Backup'])
          expect(Boolean(screen.queryByRole('button', { name }))).toBe(
            available,
          )
        if (available)
          expect(
            screen.getByText(
              'Export your cloud and local data as a portable ZIP archive.',
            ),
          ).toBeInTheDocument()
      },
    )

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

describe('settings prompts', () => {
  beforeEach(() => {
    localStorage.clear()
    authState.isSignedIn = false
  })

  it('chooses the prompt new chats start with', async () => {
    const profile = {
      customPromptPresets: [
        {
          id: 'user:quiet',
          name: 'Quiet',
          description: '',
          systemPrompt: 'Be brief.',
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    }
    localStorage.setItem(
      'tinfoil-user-prefs-local-profile',
      JSON.stringify(profile),
    )
    publish({
      session: {
        ...testSession,
        presets: [
          {
            id: 'builtin:tutor',
            name: 'Tutor',
            description: 'Teaches',
            systemPrompt: 'Teach.',
            builtIn: true,
          },
        ],
      },
      profile,
    })
    render(<Harness initialTab="prompts" />)

    const picker = screen.getByRole('combobox', {
      name: 'Default prompt for new chats',
    })
    expect(picker).toHaveValue('')

    fireEvent.change(picker, { target: { value: 'user:quiet' } })

    await waitFor(() =>
      expect(getView().profile.defaultPromptPresetId).toBe('user:quiet'),
    )
    expect(picker).toHaveValue('user:quiet')
  })
})

describe('settings imports', () => {
  beforeEach(() => {
    localStorage.clear()
    authState.isSignedIn = true
    toasts.mockReset()
    localStorage.setItem(SETTINGS_CLOUD_SYNC_ENABLED, 'true')
  })

  const exportFile = (name: string, size: number) =>
    new File([new Uint8Array(size)], name, { type: 'application/json' })

  it('imports the files of a split export one after another from a reviewed list', async () => {
    const client = harnessAPI().client
    const uploaded: string[] = []
    vi.mocked(client.upload).mockImplementation(async (_path, file) => {
      uploaded.push(file.name)
      return { jobId: `job-${uploaded.length}` }
    })
    const statuses: Record<string, object> = {
      'job-1': { status: 'completed', imported: 3, failed: 0, total: 3 },
      'job-2': { status: 'running', imported: 0, failed: 0, total: 0 },
    }
    vi.mocked(client.post).mockImplementation(async (path, input) =>
      path === '/v1/import/status'
        ? statuses[(input as { jobId: string }).jobId]
        : path === '/v1/projects/list'
          ? { projects: [], nextCursor: null }
          : {},
    )
    const onChatsUpdated = vi.fn()
    render(
      <Harness initialTab="data" isSignedIn onChatsUpdated={onChatsUpdated} />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Import from ChatGPT' }))
    const picker = document.querySelector<HTMLInputElement>(
      'input[type="file"][multiple][accept=".json,.zip"]',
    )!
    fireEvent.change(picker, {
      target: {
        files: [
          exportFile('conversations-000.json', 2048),
          exportFile('user.json', 10),
        ],
      },
    })
    fireEvent.change(picker, {
      target: { files: [exportFile('conversations-001.json', 1024)] },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Remove user.json' }))
    expect(
      screen
        .getAllByText(/^conversations-00\d\.json$/)
        .map((n) => n.textContent),
    ).toEqual(['conversations-000.json', 'conversations-001.json'])
    expect(uploaded).toEqual([])

    fireEvent.click(
      screen.getByRole('button', { name: 'Import conversations' }),
    )

    expect(await screen.findByText('Import in progress')).toBeInTheDocument()
    expect(uploaded).toEqual([
      'conversations-000.json',
      'conversations-001.json',
    ])
    expect(screen.getByText('3 chats imported')).toBeInTheDocument()
    expect(toasts).toHaveBeenCalledWith({
      title: 'Import started',
      description:
        "Your ChatGPT export is being imported securely. We'll email you when it's done.",
    })
    expect(onChatsUpdated).toHaveBeenCalled()
  })

  it('names the file that failed and the files never started', async () => {
    const client = harnessAPI().client
    vi.mocked(client.upload).mockResolvedValue({ jobId: 'job-1' })
    vi.mocked(client.post).mockImplementation(async (path) =>
      path === '/v1/import/status'
        ? {
            status: 'failed',
            imported: 0,
            failed: 0,
            total: 0,
            failureReason: 'invalid_archive',
            failureDetail: 'unexpected_json',
          }
        : path === '/v1/projects/list'
          ? { projects: [], nextCursor: null }
          : {},
    )
    render(<Harness initialTab="data" isSignedIn />)
    fireEvent.click(screen.getByRole('button', { name: 'Import from ChatGPT' }))
    fireEvent.change(
      document.querySelector(
        'input[type="file"][multiple][accept=".json,.zip"]',
      )!,
      {
        target: {
          files: [
            exportFile('user.json', 10),
            exportFile('conversations-000.json', 10),
          ],
        },
      },
    )

    fireEvent.click(
      screen.getByRole('button', { name: 'Import conversations' }),
    )

    expect(await screen.findByText('Import failed')).toBeInTheDocument()
    expect(
      screen.getByText(
        'user.json: This file is from the export but does not contain conversations. Select the conversations JSON files, such as conversations.json or conversations-000.json, not files like user.json.',
      ),
    ).toBeInTheDocument()
    expect(
      screen.getByText('1 remaining file was not imported.'),
    ).toBeInTheDocument()
    expect(client.upload).toHaveBeenCalledOnce()
  })
})
