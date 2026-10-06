import { AuthTokenSync } from '@/components/auth-token-sync'
import {
  AUTH_ACTIVE_USER_ID,
  USER_ENCRYPTION_KEY,
} from '@/constants/storage-keys'
import { authTokenManager, AuthTokenUnavailableError } from '@/services/auth'
import {
  getCachedVerificationDocument,
  getSessionToken,
  getVerificationDocument,
  resetTinfoilClient,
} from '@/services/inference/tinfoil-client'
import { act, cleanup, render } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { auth, ready } = vi.hoisted(() => ({
  auth: {
    isLoaded: true,
    isSignedIn: false,
    userId: null as string | null,
    sessionId: null as string | null,
    getToken: vi.fn<() => Promise<string | null>>(),
  },
  ready: vi.fn(async () => {}),
}))

vi.mock('@clerk/react', () => ({ useAuth: () => auth }))
vi.mock('@/config', () => ({
  API_BASE_URL: 'https://api.example.com',
  DEV_API_KEY: '',
  IS_DEV: false,
}))
vi.mock('@/utils/error-handling', () => ({ logError: vi.fn() }))
vi.mock('tinfoil', () => ({
  AuthenticationError: class AuthenticationError extends Error {},
  SecureClient: class SecureClient {
    document = { securityVerified: true }
    ready = ready
    getVerificationDocument = () => this.document
    getBaseURL = () => 'https://enclave.example.com'
    fetch = vi.fn()
  },
}))

const FREE_KEY_URL = 'https://api.example.com/api/keys/chat'
const CHAT_TOKEN_URL = 'https://api.example.com/api/chat/token'
const SLOW_AUTH_MS = 4000

describe('AuthTokenSync', () => {
  const fetchMock = vi.fn<typeof fetch>()

  beforeEach(() => {
    authTokenManager.reset()
    resetTinfoilClient()
    auth.isLoaded = true
    auth.isSignedIn = false
    auth.userId = null
    auth.sessionId = null
    auth.getToken.mockReset().mockResolvedValue('clerk-token')
    ready.mockClear()
    fetchMock.mockReset().mockImplementation(async (url) =>
      Response.json({
        key: url === CHAT_TOKEN_URL ? 'subscriber-key' : 'free-key',
        expires_at: '2099-01-01T00:00:00Z',
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    cleanup()
    authTokenManager.reset()
    resetTinfoilClient()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('initializes verification after reloading with an expired session and retained local data', async () => {
    localStorage.setItem(AUTH_ACTIVE_USER_ID, 'previous-user')
    localStorage.setItem(USER_ENCRYPTION_KEY, 'preserved-key')
    render(<AuthTokenSync />)

    await expect(getVerificationDocument()).resolves.toEqual({
      securityVerified: true,
    })
    await expect(getSessionToken()).resolves.toBe('free-key')
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(FREE_KEY_URL, {
      headers: {},
      signal: expect.any(AbortSignal),
    })
    expect(auth.getToken).not.toHaveBeenCalled()
    expect(localStorage.getItem(AUTH_ACTIVE_USER_ID)).toBe('previous-user')
    expect(localStorage.getItem(USER_ENCRYPTION_KEY)).toBe('preserved-key')
  })

  it.each([false, true])(
    'waits for slow Clerk loading before resolving signed-in: %s',
    async (signedIn) => {
      vi.useFakeTimers()
      auth.isLoaded = false
      const { rerender } = render(<AuthTokenSync />)
      const token = getSessionToken()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(SLOW_AUTH_MS)
      })
      expect(fetchMock).not.toHaveBeenCalled()

      auth.isLoaded = true
      auth.isSignedIn = signedIn
      auth.userId = signedIn ? 'user-a' : null
      auth.sessionId = signedIn ? 'session-a' : null
      rerender(<AuthTokenSync />)

      await expect(token).resolves.toBe(
        signedIn ? 'subscriber-key' : 'free-key',
      )
      expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
        signedIn ? CHAT_TOKEN_URL : FREE_KEY_URL,
      ])
    },
  )

  it('drops subscriber credentials on sign-out and remains usable after remounting', async () => {
    auth.isSignedIn = true
    auth.userId = 'user-a'
    auth.sessionId = 'session-a'
    const { rerender, unmount } = render(<AuthTokenSync />)
    await expect(getSessionToken()).resolves.toBe('subscriber-key')

    auth.isSignedIn = false
    auth.userId = null
    auth.sessionId = null
    rerender(<AuthTokenSync />)
    await expect(getSessionToken()).resolves.toBe('free-key')
    expect(fetchMock).toHaveBeenLastCalledWith(FREE_KEY_URL, {
      headers: {},
      signal: undefined,
    })

    unmount()
    render(<AuthTokenSync />)
    await expect(getVerificationDocument()).resolves.toEqual({
      securityVerified: true,
    })
  })

  it('fails closed when a signed-in session cannot supply a token', async () => {
    auth.isSignedIn = true
    auth.userId = 'user-a'
    auth.sessionId = 'session-a'
    auth.getToken.mockResolvedValue(null)
    render(<AuthTokenSync />)

    await expect(getVerificationDocument()).rejects.toBeInstanceOf(
      AuthTokenUnavailableError,
    )
    expect(fetchMock).not.toHaveBeenCalled()
    expect(ready).not.toHaveBeenCalled()
  })

  it('rejects a pending token read when the session signs out', async () => {
    auth.isSignedIn = true
    auth.userId = 'user-a'
    auth.sessionId = 'session-a'
    let resolveToken!: (token: string) => void
    auth.getToken.mockImplementationOnce(
      () => new Promise((resolve) => (resolveToken = resolve)),
    )
    const { rerender } = render(<AuthTokenSync />)
    const token = getSessionToken()
    const rejection = expect(token).rejects.toBeInstanceOf(
      AuthTokenUnavailableError,
    )

    auth.isSignedIn = false
    auth.userId = null
    auth.sessionId = null
    rerender(<AuthTokenSync />)
    resolveToken('old-account-token')

    await rejection
    expect(fetchMock).not.toHaveBeenCalled()
    await expect(getSessionToken()).resolves.toBe('free-key')
  })

  it('does not reuse cached credentials when the account changes', async () => {
    auth.isSignedIn = true
    auth.userId = 'user-a'
    auth.sessionId = 'session-a'
    const { rerender } = render(<AuthTokenSync />)
    await getSessionToken()

    auth.userId = 'user-b'
    auth.sessionId = 'session-b'
    auth.getToken.mockResolvedValue('account-b-token')
    rerender(<AuthTokenSync />)
    await getSessionToken()

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock).toHaveBeenLastCalledWith(CHAT_TOKEN_URL, {
      headers: { Authorization: 'Bearer account-b-token' },
      signal: expect.any(AbortSignal),
    })
  })

  it('keeps verification cached across unchanged renders in Strict Mode', async () => {
    const { rerender } = render(
      <StrictMode>
        <AuthTokenSync />
      </StrictMode>,
    )
    const document = await getVerificationDocument()

    rerender(
      <StrictMode>
        <AuthTokenSync />
      </StrictMode>,
    )

    expect(getCachedVerificationDocument()).toBe(document)
    await expect(getVerificationDocument()).resolves.toBe(document)
    expect(ready).toHaveBeenCalledTimes(1)
  })
})
