import { LogoLoading } from '@/components/ui/logo-loading'
import { AUTH_ACTIVE_USER_CHANGED_EVENT } from '@/constants/auth-events'
import { toast } from '@/hooks/use-toast'
import { authTokenManager, AuthTokenUnavailableError } from '@/services/auth'
import {
  ENCRYPTION_KEY_CHANGED_EVENT,
  encryptionService,
} from '@/services/encryption/encryption-service'
import { enableCloudSyncForExistingKey } from '@/utils/cloud-sync-settings'
import { logError } from '@/utils/error-handling'
import { useAuth } from '@clerk/react'
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import { HarnessClient } from './client'
import {
  activateAPI,
  getServerView,
  getView,
  HarnessAPI,
  harnessAPI,
  reportHarnessError,
  subscribe,
} from './runtime'

const HarnessContext = createContext<HarnessAPI | null>(null)
// Whose session the harness serves: an account, a signed-out account, or a
// visitor whose account is not asked for. A visitor's session shares nothing
// with a signed-out account's.
const SIGNED_OUT_ACCOUNT = 'anonymous'
const VISITOR_ACCOUNT = 'visitor'

export function HarnessProvider({
  children,
  anonymous = false,
}: {
  children: ReactNode
  // The page opens as a visitor without waiting for the account to load, as
  // a shared chat does: every request it makes is anonymous.
  anonymous?: boolean
}) {
  const auth = useAuth()
  const isLoaded = anonymous || auth.isLoaded
  const userId = anonymous ? null : auth.userId
  const getToken = auth.getToken
  const owner = anonymous ? VISITOR_ACCOUNT : (userId ?? SIGNED_OUT_ACCOUNT)
  const identity = useRef(userId)
  identity.current = userId
  const token = useRef(getToken)
  token.current = getToken
  const [account, setAccount] = useState<string>()
  const [sessionAPI, setSessionAPI] = useState<HarnessAPI | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!isLoaded) return
    const url =
      process.env.NEXT_PUBLIC_HARNESS_ENCLAVE_URL ||
      'https://chat-api.tinfoil.sh'
    let release: (() => void) | undefined
    try {
      const getter = async (options?: { skipCache?: boolean }) => {
        if (identity.current !== userId)
          throw new DOMException('Account changed', 'AbortError')
        const jwt = userId ? await token.current(options) : null
        if (identity.current !== userId)
          throw new DOMException('Account changed', 'AbortError')
        if (userId && !jwt) throw new AuthTokenUnavailableError('unavailable')
        return jwt
      }
      // A null getter records a confirmed signed-out session for account
      // APIs, which a visitor's page does not know.
      if (!anonymous) authTokenManager.initialize(userId ? getter : null)
      const api = new HarnessAPI(new HarnessClient(url, getter), userId ?? null)
      release = activateAPI(api)
      setSessionAPI(api)
      const refresh = () => {
        const initialization = userId
          ? encryptionService.initialize().then(enableCloudSyncForExistingKey)
          : Promise.resolve()
        void initialization
          .then(() => api.refresh({ credentials: true }))
          .catch(reportHarnessError)
      }
      const unlock = () => {
        api.invalidateKey()
        refresh()
      }
      const keyChanged = () => {
        api.invalidateKey()
        void api.refreshProfile().catch(reportHarnessError)
      }
      const stopChanges = api.watchChanges()
      window.addEventListener(AUTH_ACTIVE_USER_CHANGED_EVENT, unlock)
      refresh()
      window.addEventListener(ENCRYPTION_KEY_CHANGED_EVENT, keyChanged)
      setAccount(owner)
      return () => {
        stopChanges()
        window.removeEventListener(ENCRYPTION_KEY_CHANGED_EVENT, keyChanged)
        window.removeEventListener(AUTH_ACTIVE_USER_CHANGED_EVENT, unlock)
        release?.()
        authTokenManager.reset()
      }
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Unable to connect to chat.',
      )
      release?.()
    }
  }, [isLoaded, userId, anonymous, owner])
  if (error)
    return (
      <main
        role="alert"
        className="flex h-screen items-center justify-center bg-surface-chat-background p-8 text-content-primary"
      >
        {error}
      </main>
    )
  if (!isLoaded || account !== owner)
    return (
      <div role="status" aria-label="Loading your session">
        <LogoLoading />
      </div>
    )
  return (
    <HarnessContext.Provider key={account} value={sessionAPI}>
      {children}
    </HarnessContext.Provider>
  )
}
// The harness's view, with the profile's unset fields shown at the
// defaults the session names.
export function useHarness() {
  const view = useSyncExternalStore(subscribe, getView, getServerView)
  const api = useContext(HarnessContext)
  const defaults = view.session?.profileDefaults
  const profile = useMemo(
    () => (defaults ? { ...defaults, ...view.profile } : view.profile),
    [defaults, view.profile],
  )
  return { ...view, profile, api: api ?? harnessAPI() }
}
// Whether the harness's session offers a feature. Features are off while
// the harness cannot reach the service behind them, and until the session
// loads unless `whileLoading` says otherwise.
export function useSessionFeature(
  feature: string,
  whileLoading = false,
): boolean {
  return useSyncExternalStore(
    subscribe,
    () => {
      const session = getView().session
      return session ? session.features[feature] === true : whileLoading
    },
    () => whileLoading,
  )
}
// A setting the harness did not save returns to its saved value, and the
// user is told.
export function reportProfileError(cause: unknown) {
  if (cause instanceof DOMException && cause.name === 'AbortError') return
  logError('Failed to save settings', cause, {
    component: 'HarnessProvider',
    action: 'updateProfile',
  })
  toast({
    title: 'Failed to save settings',
    description: 'Please try again.',
    variant: 'destructive',
  })
}
export function useProfileSetting<T>(
  field: string,
  fallback: T,
): [T, (value: T) => void] {
  const { profile, api } = useHarness()
  return [
    profile[field] ?? fallback,
    (value) => {
      void api.updateProfile({ [field]: value }).catch(reportProfileError)
    },
  ]
}
