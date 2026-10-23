import { ChatInterface } from '@/components/chat/chat-interface'
import { ProjectProvider } from '@/components/project/project-provider'
import { UI_SIDEBAR_OPEN } from '@/constants/storage-keys'
import { encryptionService } from '@/services/encryption/encryption-service'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { signIn } from '../../harness-fixture'
import { resetChatStoresAroundEachTest } from '../../services/harness/thread-fixture'
import { refuseFetch } from './chat-interface-fixture'
import { chatPage } from './chat-page-mocks'

// The passkey hook as the page reads it: its state and the actions the page
// calls, which each test scripts.
const passkey = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  showPasskeyRecoveryPrompt: vi.fn(),
  showFirstTimePasskeyPrompt: vi.fn(),
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
    setupPasskey: vi.fn(),
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
    ...passkey.state,
  }),
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
