import { AUTH_ACTIVE_USER_CHANGED_EVENT } from '@/constants/auth-events'
import { authTokenManager } from '@/services/auth'
import {
  ENCRYPTION_KEY_CHANGED_EVENT,
  encryptionService,
} from '@/services/encryption/encryption-service'
import { useAuth } from '@clerk/nextjs'
import {
  createContext,
  useContext,
  useEffect,
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

export function HarnessProvider({ children }: { children: ReactNode }) {
  const { isLoaded, userId, getToken } = useAuth()
  const identity = useRef(userId)
  identity.current = userId
  const token = useRef(getToken)
  token.current = getToken
  const [account, setAccount] = useState<string>()
  const [sessionAPI, setSessionAPI] = useState<HarnessAPI | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!isLoaded) return
    const url = process.env.NEXT_PUBLIC_HARNESS_ENCLAVE_URL
    if (!url) {
      setError('Configure NEXT_PUBLIC_HARNESS_ENCLAVE_URL to connect to chat.')
      return
    }
    let release: (() => void) | undefined
    try {
      const getter = async (options?: { skipCache?: boolean }) => {
        if (identity.current !== userId)
          throw new DOMException('Account changed', 'AbortError')
        const jwt = userId ? await token.current(options) : null
        if (identity.current !== userId)
          throw new DOMException('Account changed', 'AbortError')
        return jwt
      }
      authTokenManager.initialize(getter)
      const api = new HarnessAPI(new HarnessClient(url, getter), userId ?? null)
      release = activateAPI(api)
      setSessionAPI(api)
      const unlock = () => {
        api.invalidateKey()
        void encryptionService
          .initialize()
          .then(() => api.refresh())
          .catch(reportHarnessError)
      }
      const keyChanged = () => {
        api.invalidateKey()
        void api.refreshProfile().catch(reportHarnessError)
      }
      window.addEventListener(AUTH_ACTIVE_USER_CHANGED_EVENT, unlock)
      void encryptionService
        .initialize()
        .then(() => api.refresh())
        .catch(reportHarnessError)
      window.addEventListener(ENCRYPTION_KEY_CHANGED_EVENT, keyChanged)
      setAccount(userId ?? 'anonymous')
      return () => {
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
  }, [isLoaded, userId])
  if (error)
    return (
      <main
        role="alert"
        className="flex h-screen items-center justify-center bg-surface-chat-background p-8 text-content-primary"
      >
        {error}
      </main>
    )
  if (!isLoaded || account !== (userId ?? 'anonymous'))
    return (
      <main
        role="status"
        className="flex h-screen items-center justify-center bg-surface-chat-background text-content-primary"
      >
        Loading your session…
      </main>
    )
  return (
    <HarnessContext.Provider key={account} value={sessionAPI}>
      {children}
    </HarnessContext.Provider>
  )
}
export function useHarness() {
  const view = useSyncExternalStore(subscribe, getView, getServerView)
  const api = useContext(HarnessContext)
  return { ...view, api: api ?? harnessAPI() }
}
export function useProfileSetting<T>(
  field: string,
  fallback: T,
): [T, (value: T) => void] {
  const { profile, api } = useHarness()
  return [
    profile[field] ?? fallback,
    (value) => {
      void api.updateProfile({ [field]: value }).catch(reportHarnessError)
    },
  ]
}
