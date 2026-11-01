import { SettingsModal } from '@/components/chat/settings-modal'
import { publish } from '@/services/harness/runtime'
import { HarnessError } from '@/services/harness/sse'
import { act, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { client, signIn } from '../../harness-fixture'

vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: vi.fn() }),
}))
vi.mock('@clerk/react', () => ({
  useReverification: (callback: unknown) => callback,
  useAuth: () => ({ getToken: async () => null, signOut: vi.fn() }),
  useUser: () => ({ user: { id: 'alice' } }),
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
    canWrite: false,
    remoteState: 'unknown',
    message: 'No encryption key is currently loaded.',
  }),
}))
vi.mock('@/utils/error-handling', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarning: vi.fn(),
}))

const UNLOCK_COPY = 'Unlock your encryption key to access your saved chats.'
const UNLOCKED_COPY =
  'End-to-end encrypted. Only you can access your chats and data.'

function renderCloudSync(encryptionKey: string | null = null) {
  render(
    <SettingsModal
      isOpen
      setIsOpen={vi.fn()}
      isDarkMode={false}
      themeMode="light"
      setThemeMode={vi.fn()}
      isClient
      onOpenPromptLibrary={vi.fn()}
      onCloudSyncSetupClick={vi.fn()}
      onDeleteAllChats={vi.fn()}
      encryptionKey={encryptionKey}
      initialTab="cloud-sync"
      isSignedIn
    />,
  )
}

// The harness answers each profile request with the next scripted outcome.
function scriptProfiles(...outcomes: (() => Promise<unknown>)[]) {
  client.post.mockImplementation(async (path: string) => {
    if (path === '/v1/profile/get') return outcomes.shift()!()
    throw new Error(`Unexpected harness request: ${path}`)
  })
}

it('asks to recover the key only after the chat service refuses it', async () => {
  let fail!: (cause: Error) => void
  const api = signIn({ cloud: true })
  scriptProfiles(
    () =>
      new Promise((_, reject) => {
        fail = reject
      }),
    async () => {
      throw new HarnessError(
        { code: 'KEY_MISMATCH', message: 'Another key is required' },
        409,
      )
    },
    async () => ({}),
  )
  // The page has opened and the account's profile has not loaded yet.
  publish({ profile: {}, keyReady: false, profileReady: false })
  renderCloudSync()
  const loading = act(() => api.refreshProfile())
  expect(screen.queryByText(UNLOCK_COPY)).not.toBeInTheDocument()
  expect(
    screen.queryByRole('button', { name: 'Recover Key' }),
  ).not.toBeInTheDocument()

  fail(new TypeError('Network unavailable'))
  await loading
  expect(screen.queryByText(UNLOCK_COPY)).not.toBeInTheDocument()
  expect(
    screen.queryByRole('button', { name: 'Recover Key' }),
  ).not.toBeInTheDocument()

  await act(() => api.refreshProfile())
  expect(screen.getByText(UNLOCK_COPY)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Recover Key' })).toBeEnabled()

  await act(() => api.refreshProfile())
  expect(screen.getByText(UNLOCKED_COPY)).toBeInTheDocument()
  expect(
    screen.queryByRole('button', { name: 'Recover Key' }),
  ).not.toBeInTheDocument()
  expect(
    screen.queryByRole('button', { name: 'Manage key' }),
  ).not.toBeInTheDocument()
})

it.each([
  [null, 'Sync is paused because your encryption key needs to be recovered.'],
  [
    `key_${'ar'.repeat(32)}`,
    "This device's encryption key is out of date and needs to be recovered.",
  ],
])('explains why a key is needed (key on this device: %s)', (key, reason) => {
  signIn({ cloud: true, locked: true })
  renderCloudSync(key)
  expect(screen.getByText('Action needed')).toBeInTheDocument()
  expect(screen.getByText(reason)).toBeInTheDocument()
})
