import { SettingsModal } from '@/components/chat/settings-modal'
import { publish } from '@/services/harness/runtime'
import { HarnessError } from '@/services/harness/sse'
import { act, render, screen } from '@testing-library/react'
import { expect, it, onTestFinished, vi } from 'vitest'
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
        {
          code: 'KEY_MISMATCH',
          message: 'Another key is required',
          action: 'unlock',
        },
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

it('shows when the cloud was last reached, and keeps it while sync is paused', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
  onTestFinished(() => {
    vi.useRealTimers()
  })
  const api = signIn({ cloud: true })
  let reachable = true
  client.post.mockImplementation(async (path: string) => {
    if (path === '/v1/profile/get') return {}
    if (path !== '/v1/changes')
      throw new Error(`Unexpected harness request: ${path}`)
    if (!reachable) throw new TypeError('Network unavailable')
    return { chats: 'c1', profile: 'p1', projects: 'j1' }
  })
  onTestFinished(api.watchChanges())
  renderCloudSync()
  expect(screen.getByText('Checking sync...')).toBeInTheDocument()

  // A check runs as the window gains focus.
  await act(async () => {
    window.dispatchEvent(new Event('focus'))
  })
  expect(await screen.findByText('Synced just now')).toBeInTheDocument()

  // The checks every few seconds fail for over a minute.
  reachable = false
  await act(() => vi.advanceTimersByTimeAsync(75_000))
  expect(screen.getByText('Sync paused')).toBeInTheDocument()
  expect(
    screen.getByText(
      'Having trouble reaching the cloud. Retrying automatically. Last synced 1m ago.',
    ),
  ).toBeInTheDocument()

  reachable = true
  await act(async () => {
    window.dispatchEvent(new Event('focus'))
  })
  expect(await screen.findByText('Synced just now')).toBeInTheDocument()
  expect(screen.queryByText('Sync paused')).not.toBeInTheDocument()
})

it('shows sync as paused while the account cannot load from the cloud', async () => {
  const api = signIn({ cloud: true })
  scriptProfiles(
    async () => {
      throw new TypeError('Network unavailable')
    },
    async () => ({}),
  )
  // The page has opened and the account's profile has not loaded yet.
  publish({ profile: {}, keyReady: false, profileReady: false })
  renderCloudSync()
  expect(screen.getByText('Checking sync...')).toBeInTheDocument()

  await act(() => api.refreshProfile())
  expect(screen.getByText('Sync paused')).toBeInTheDocument()
  // Nothing checks again until the account is loaded again.
  expect(
    screen.getByText('Having trouble reaching the cloud.'),
  ).toBeInTheDocument()

  await act(() => api.refreshProfile())
  expect(screen.queryByText('Sync paused')).not.toBeInTheDocument()
  expect(screen.getByText('Checking sync...')).toBeInTheDocument()
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
