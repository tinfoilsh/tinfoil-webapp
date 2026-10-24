import { ChatInterface } from '@/components/chat/chat-interface'
import { ProjectProvider } from '@/components/project/project-provider'
import {
  SECRET_PASSKEY_BACKED_UP,
  UI_SIDEBAR_OPEN,
  USER_ENCRYPTION_KEY,
} from '@/constants/storage-keys'
import { encryptionService } from '@/services/encryption/encryption-service'
import { base64ToBytes } from '@/services/harness/keys'
import { HarnessError } from '@/services/harness/sse'
import { deriveTinfoilKeyIdHex } from '@/services/keys/tinfoil-key-id'
import { PasskeyTimeoutError, PrfNotSupportedError } from '@/services/passkey'
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { client, signIn, testSession } from '../../harness-fixture'
import { resetChatStoresAroundEachTest } from '../../services/harness/thread-fixture'
import { refuseFetch } from './chat-interface-fixture'
import { chatPage, errorHandling } from './chat-page-mocks'

// The passkey hook as the page reads it: its state and the actions the page
// calls, which each test scripts.
const passkey = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  showPasskeyRecoveryPrompt: vi.fn(),
  showFirstTimePasskeyPrompt: vi.fn(),
  updatePasskeyBackup: vi.fn(),
  setupPasskey: vi.fn(),
  isPrfSupported: vi.fn(),
}))

vi.mock('@clerk/react', async () => ({
  ...(await import('./chat-page-mocks')).clerk,
  useReverification: (callback: unknown) => callback,
}))
vi.mock('next/router', async () => (await import('./chat-page-mocks')).router)
vi.mock('next/head', async () => (await import('./chat-page-mocks')).head)
vi.mock('next/dynamic', async () => {
  const { lazy, Suspense } = await import('react')
  return {
    default: (
      load: () => Promise<React.ComponentType<Record<string, unknown>>>,
    ) => {
      const Component = lazy(async () => ({ default: await load() }))
      return function Loaded(props: Record<string, unknown>) {
        return (
          <Suspense fallback={null}>
            <Component {...props} />
          </Suspense>
        )
      }
    },
  }
})
vi.mock(
  '@/components/ui/logo-loading',
  async () => (await import('./chat-page-mocks')).logoLoading,
)
vi.mock(
  '@/hooks/use-subscription-status',
  async () => (await import('./chat-page-mocks')).subscription,
)
vi.mock('@/hooks/use-passkey-backup', () => ({
  usePasskeyBackup: () => ({
    passkeyActive: false,
    passkeyRecoveryNeeded: false,
    manualRecoveryNeeded: false,
    passkeySetupAvailable: false,
    passkeyAddDeviceAvailable: false,
    passkeySetupFailed: false,
    passkeyRecoveryFailure: null,
    passkeyFirstTimePromptAvailable: false,
    setupPasskey: passkey.setupPasskey,
    setupFirstTimePasskey: vi.fn(),
    dismissFirstTimePasskeyPrompt: vi.fn(),
    recoverWithPasskey: vi.fn(),
    setupNewKeySplit: vi.fn(),
    dismissBackupWarning: vi.fn(),
    skipPasskeyRecovery: vi.fn(),
    addPasskeyToThisDevice: vi.fn(),
    refreshBundleState: vi.fn(),
    showPasskeyRecoveryPrompt: passkey.showPasskeyRecoveryPrompt,
    showFirstTimePasskeyPrompt: passkey.showFirstTimePasskeyPrompt,
    updatePasskeyBackup: passkey.updatePasskeyBackup,
    ...passkey.state,
  }),
}))
vi.mock('@/services/passkey', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/passkey')>()),
  isPrfSupported: passkey.isPrfSupported,
}))
vi.mock('@/hooks/use-upgrade-to-pro', () => ({
  useUpgradeToPro: () => ({ startUpgrade: vi.fn() }),
}))
vi.mock(
  '@/utils/error-handling',
  async () => (await import('./chat-page-mocks')).errorHandling,
)

function held<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

resetChatStoresAroundEachTest()
beforeEach(() => {
  const setAttribute = HTMLIFrameElement.prototype.setAttribute
  vi.spyOn(HTMLIFrameElement.prototype, 'setAttribute').mockImplementation(
    function (this: HTMLIFrameElement, name, value) {
      if (name !== 'src') setAttribute.call(this, name, value)
    },
  )
  vi.spyOn(HTMLIFrameElement.prototype, 'contentWindow', 'get').mockReturnValue(
    null,
  )
  vi.stubGlobal('innerWidth', 1440)
  chatPage.premium = false
  chatPage.router.pathname = '/'
  chatPage.router.query = {}
  passkey.state = {}
  passkey.showPasskeyRecoveryPrompt
    .mockReset()
    .mockRejectedValue(new Error('Unexpected passkey recovery check'))
  passkey.showFirstTimePasskeyPrompt
    .mockReset()
    .mockRejectedValue(new Error('Unexpected first passkey check'))
  passkey.updatePasskeyBackup
    .mockReset()
    .mockRejectedValue(new Error('Unexpected passkey backup update'))
  passkey.setupPasskey
    .mockReset()
    .mockRejectedValue(new Error('Unexpected passkey setup'))
  passkey.isPrfSupported.mockReset().mockResolvedValue(true)
  errorHandling.logError.mockClear()
  encryptionService.clearKey({ persist: false })
  sessionStorage.setItem(UI_SIDEBAR_OPEN, 'true')
  refuseFetch()
  signIn()
})

function view() {
  return (
    <ProjectProvider>
      <ChatInterface suppressIntroModals />
    </ProjectProvider>
  )
}

it('checks for a passkey to recover with, then a first passkey, before setup continues', async () => {
  passkey.state = { passkeySetupFailed: true }
  const recovery = held<boolean>()
  const firstTime = held<boolean>()
  passkey.showPasskeyRecoveryPrompt.mockReturnValue(recovery.promise)
  passkey.showFirstTimePasskeyPrompt.mockReturnValue(firstTime.promise)
  render(view())
  fireEvent.click(
    (await screen.findAllByRole('button', { name: 'Enable Cloud Sync' }))[0],
  )
  const continueButton = await screen.findByRole('button', {
    name: 'Continue',
  })
  expect(continueButton).toBeDisabled()
  expect(passkey.showPasskeyRecoveryPrompt).toHaveBeenCalledTimes(1)
  expect(passkey.showFirstTimePasskeyPrompt).not.toHaveBeenCalled()
  await act(async () => recovery.resolve(false))
  expect(passkey.showFirstTimePasskeyPrompt).toHaveBeenCalledTimes(1)
  expect(continueButton).toBeDisabled()
  await act(async () => firstTime.resolve(true))
  expect(continueButton).toBeEnabled()
})

it('routes to passkey recovery without offering a new passkey', async () => {
  passkey.state = { passkeySetupFailed: true }
  passkey.showPasskeyRecoveryPrompt.mockImplementation(async () => {
    passkey.state = { passkeyRecoveryNeeded: true }
    return true
  })
  render(view())
  fireEvent.click(
    (await screen.findAllByRole('button', { name: 'Enable Cloud Sync' }))[0],
  )
  expect(
    await screen.findByRole('heading', { name: 'Unlock Your Chats' }),
  ).toBeInTheDocument()
  expect(passkey.showFirstTimePasskeyPrompt).not.toHaveBeenCalled()
})

// A key this account registered, which the user enters again on this device.
const RESTORED_KEY = `key_${'ar'.repeat(32)}`
const RESTORED_KEY_B64 = 'ERERERERERERERERERERERERERERERERERERERERERE='

// The harness of a cloud account whose key this device lacks: it answers the
// key the account registered, and once unlocked the profile and empty lists.
function lockedCloudAccount(current: Record<string, unknown>) {
  signIn({ cloud: true, locked: true })
  const registered: unknown[] = []
  client.post.mockImplementation(async (path: string, input: unknown) => {
    if (path === '/v1/session') return structuredClone(testSession)
    if (path === '/v1/keys/current') return current
    if (path === '/v1/keys/register') {
      registered.push(input)
      return { ok: true, key_id: 'fresh-key' }
    }
    if (path === '/v1/profile/get') return { hasSeenOnboarding: true }
    if (path === '/v1/threads/list') return { threads: [], nextCursor: null }
    if (path === '/v1/projects/list') return { projects: [], nextCursor: null }
    throw new Error(`Unexpected harness request: ${path}`)
  })
  passkey.showPasskeyRecoveryPrompt.mockResolvedValue(false)
  passkey.showFirstTimePasskeyPrompt.mockResolvedValue(false)
  return registered
}

async function restoreKey(key: string) {
  fireEvent.click(
    (await screen.findAllByRole('button', { name: 'Enable Cloud Sync' }))[0],
  )
  const continueButton = await screen.findByRole('button', {
    name: 'Continue',
  })
  await waitFor(() => expect(continueButton).toBeEnabled())
  fireEvent.click(continueButton)
  fireEvent.click(
    await screen.findByRole('button', { name: 'Restore Encryption Key' }),
  )
  fireEvent.change(await screen.findByPlaceholderText('Enter encryption key'), {
    target: { value: key },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Restore Key' }))
  await screen.findByRole('heading', { name: 'Success!' })
}

it.each([true, false])(
  'encrypts the passkey backup again after another key is restored (backed up: %s)',
  async (backedUp) => {
    if (backedUp) localStorage.setItem(SECRET_PASSKEY_BACKED_UP, 'true')
    passkey.state = { passkeySetupFailed: true }
    lockedCloudAccount({
      key_id: await deriveTinfoilKeyIdHex(base64ToBytes(RESTORED_KEY_B64)),
      etag: 'etag-1',
      bundles: {},
    })
    const persisted: (string | null)[] = []
    passkey.updatePasskeyBackup.mockImplementation(async () => {
      persisted.push(localStorage.getItem(USER_ENCRYPTION_KEY))
    })
    render(view())
    await restoreKey(RESTORED_KEY)
    expect(encryptionService.getKey()).toBe(RESTORED_KEY)
    expect(persisted).toEqual(backedUp ? [RESTORED_KEY] : [])
  },
)

it('keeps a restored key when the session fails to reload after it', async () => {
  localStorage.setItem(SECRET_PASSKEY_BACKED_UP, 'true')
  passkey.state = { passkeySetupFailed: true }
  lockedCloudAccount({
    key_id: await deriveTinfoilKeyIdHex(base64ToBytes(RESTORED_KEY_B64)),
    etag: 'etag-1',
    bundles: {},
  })
  const answer = client.post.getMockImplementation()!
  let refusedRefreshes = 0
  client.post.mockImplementation(async (path: string, ...rest: unknown[]) => {
    if (path === '/v1/session' && localStorage.getItem(USER_ENCRYPTION_KEY)) {
      refusedRefreshes++
      throw new TypeError('Network unavailable')
    }
    return answer(path, ...rest)
  })
  passkey.updatePasskeyBackup.mockResolvedValue(undefined)
  render(view())

  await restoreKey(RESTORED_KEY)

  expect(refusedRefreshes).toBe(1)
  expect(encryptionService.getKey()).toBe(RESTORED_KEY)
  expect(localStorage.getItem(USER_ENCRYPTION_KEY)).toBe(RESTORED_KEY)
  expect(passkey.updatePasskeyBackup).toHaveBeenCalledOnce()
  expect(screen.queryByText('Invalid key')).not.toBeInTheDocument()
})

// Starts fresh with a generated key over cloud data this device cannot
// open, through the manual recovery screen.
async function startFresh() {
  fireEvent.click(
    (await screen.findAllByRole('button', { name: 'Set Up Cloud Sync' }))[0],
  )
  fireEvent.click(await screen.findByRole('button', { name: /Start Fresh/ }))
  fireEvent.click(
    await screen.findByRole('button', { name: /Yes, start fresh/ }),
  )
  fireEvent.click(await screen.findByRole('button', { name: /Let's go!/ }))
}

it.each([
  ['an active passkey', { passkeyActive: true }, true, 0],
  ['no passkey provider', {}, false, 0],
  ['no passkey yet', {}, true, 1],
])(
  'backs up a fresh key with a new passkey only for an account with %s',
  async (_, state, prfSupported, setups) => {
    passkey.state = { manualRecoveryNeeded: true, ...state }
    passkey.isPrfSupported.mockResolvedValue(prfSupported)
    passkey.setupPasskey.mockResolvedValue(true)
    const registered = lockedCloudAccount({ key_id: null, bundles: {} })
    render(view())
    await startFresh()
    await waitFor(() => expect(registered).toHaveLength(1))
    await waitFor(() =>
      expect(passkey.isPrfSupported).toHaveBeenCalledTimes(
        'passkeyActive' in state ? 0 : 1,
      ),
    )
    await waitFor(() =>
      expect(passkey.setupPasskey).toHaveBeenCalledTimes(setups),
    )
    expect(registered).toEqual([
      expect.objectContaining({ created_via: 'start_fresh', if_match: '*' }),
    ])
  },
)

it.each([
  ['a timed-out passkey', new PasskeyTimeoutError(), 1],
  ['an unsupported provider', new PrfNotSupportedError(), 0],
])(
  'keeps a fresh key when backing it up fails with %s',
  async (_, error, logged) => {
    passkey.state = { manualRecoveryNeeded: true }
    passkey.setupPasskey.mockRejectedValue(error)
    lockedCloudAccount({ key_id: null, bundles: {} })
    render(view())
    await startFresh()
    await waitFor(() => expect(passkey.setupPasskey).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(
        errorHandling.logError.mock.calls.filter(
          ([message]) =>
            message ===
            'Failed to back up new key with passkey after start fresh',
        ),
      ).toHaveLength(logged),
    )
    expect(localStorage.getItem(USER_ENCRYPTION_KEY)).toBe(
      encryptionService.getKey(),
    )
  },
)

const ATTENTION = 'Cloud sync needs attention'

it('points the settings entries to Cloud Sync only while the key is refused', async () => {
  sessionStorage.removeItem(UI_SIDEBAR_OPEN)
  const api = signIn({ cloud: true })
  const profiles: (() => unknown)[] = [
    () => {
      throw new TypeError('Network unavailable')
    },
    () => {
      throw new HarnessError(
        {
          code: 'KEY_MISMATCH',
          message: 'Another key is required',
          action: 'unlock',
        },
        409,
      )
    },
  ]
  client.post.mockImplementation(async (path: string) => {
    if (path === '/v1/session') return structuredClone(testSession)
    if (path === '/v1/profile/get') return profiles.shift()!()
    if (path === '/v1/threads/list') return { threads: [], nextCursor: null }
    if (path === '/v1/projects/list') return { projects: [], nextCursor: null }
    throw new Error(`Unexpected harness request: ${path}`)
  })
  passkey.showPasskeyRecoveryPrompt.mockResolvedValue(false)
  passkey.showFirstTimePasskeyPrompt.mockResolvedValue(false)
  render(view())
  const rail = await screen.findByRole('button', { name: 'Settings' })

  await act(() => api.refreshProfile())
  expect(rail).not.toHaveAccessibleDescription(ATTENTION)

  await act(() => api.refreshProfile())
  expect(rail).toHaveAccessibleDescription(ATTENTION)
  fireEvent.click(rail)
  const dialog = await screen.findByRole('dialog', { name: 'Settings' })
  expect(
    within(dialog).getAllByRole('button', {
      name: 'Cloud Sync (needs attention)',
    }),
  ).not.toHaveLength(0)
  expect(within(dialog).getByText('Action needed')).toBeInTheDocument()
  expect(
    within(dialog).getByText(
      'Sync is paused because your encryption key needs to be recovered.',
    ),
  ).toBeInTheDocument()

  fireEvent.click(within(dialog).getByRole('button', { name: 'Recover Key' }))
  expect(
    await screen.findByRole('heading', { name: 'Encrypted Backups & Sync' }),
  ).toBeInTheDocument()
  expect(
    screen.queryByRole('dialog', { name: 'Settings' }),
  ).not.toBeInTheDocument()
  await waitFor(() =>
    expect(passkey.showFirstTimePasskeyPrompt).toHaveBeenCalledTimes(1),
  )
})
