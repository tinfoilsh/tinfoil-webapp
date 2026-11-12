import { AUTH_ACTIVE_USER_CHANGED_EVENT } from '@/constants/auth-events'
import {
  SETTINGS_CLOUD_SYNC_ENABLED,
  SETTINGS_CLOUD_SYNC_EXPLICITLY_DISABLED,
  USER_ENCRYPTION_KEY,
  USER_PREFS_LOCAL_PROFILE,
  USER_PREFS_LOCAL_PROFILE_UPGRADED,
} from '@/constants/storage-keys'
import { authTokenManager } from '@/services/auth'
import { encryptionService } from '@/services/encryption/encryption-service'
import {
  HarnessProvider,
  SESSION_RETRY_DELAYS_MS,
  useHarness,
} from '@/services/harness/provider'
import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeTimeouts, SEALED, testSession } from './harness-fixture'

const { auth, secure, controlplane } = vi.hoisted(() => ({
  auth: {
    isLoaded: true,
    userId: null as string | null,
    getToken: vi.fn<() => Promise<string | null>>(),
  },
  secure: {
    fetch: vi.fn<(url: string, init: RequestInit) => Promise<Response>>(),
    ensureVerified: vi.fn(),
  },
  controlplane: vi.fn<typeof fetch>(),
}))

vi.mock('@clerk/react', () => ({
  useAuth: () => ({ ...auth }),
}))
vi.mock('@/components/ui/logo-loading', () => ({
  LogoLoading: () => <div data-testid="logo-loading" />,
}))
vi.mock('@/services/harness/client', async (importOriginal) => {
  const { HarnessClient } =
    await importOriginal<typeof import('@/services/harness/client')>()
  return {
    HarnessClient: class extends HarnessClient {
      constructor(...args: ConstructorParameters<typeof HarnessClient>) {
        super(
          args[0],
          args[1],
          async () =>
            secure as unknown as Awaited<
              ReturnType<
                NonNullable<ConstructorParameters<typeof HarnessClient>[2]>
              >
            >,
        )
      }
    },
  }
})

// The key and its expiry: the harness reports the key's quota.
function issuance() {
  return Response.json({
    key: 'free_guest',
    is_free_tier: true,
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  })
}

function SessionStatus() {
  const { session, keyReady, error } = useHarness()
  if (error) return <p role="alert">{error}</p>
  return (
    <p>
      {session?.user.anonymous && keyReady
        ? `Anonymous chat ready with ${session.rateLimit.remaining} requests`
        : 'Connecting'}
    </p>
  )
}

beforeEach(() => {
  auth.isLoaded = true
  auth.userId = null
  auth.getToken.mockReset().mockResolvedValue(null)
  secure.ensureVerified.mockReset().mockResolvedValue(undefined)
  secure.fetch.mockReset().mockImplementation(async (_url, init) => {
    if (new Headers(init.headers).get('Authorization') !== 'Bearer free_guest')
      return Response.json(
        {
          error: {
            code: 'UNAUTHENTICATED',
            message: 'An anonymous chat key is required',
            action: 'reauthenticate',
          },
        },
        { status: 401 },
      )
    return Response.json({
      ...testSession,
      rateLimit: {
        kind: 'free_daily',
        maxRequests: 10,
        remaining: 9,
        resetsAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
    })
  })
  controlplane.mockReset().mockImplementation(async () => issuance())
  vi.stubGlobal('fetch', controlplane)
  vi.stubEnv('NEXT_PUBLIC_HARNESS_ENCLAVE_URL', 'https://harness.example')
  vi.spyOn(encryptionService, 'initialize').mockResolvedValue(null)
})
afterEach(() => {
  authTokenManager.reset()
})

it('opens a signed-out session with an issued key without loading saved encryption keys', async () => {
  vi.mocked(encryptionService.initialize).mockRejectedValue(
    new Error('invalid saved key'),
  )
  render(
    <HarnessProvider>
      <SessionStatus />
    </HarnessProvider>,
  )
  await waitFor(() =>
    expect(
      screen.getByText('Anonymous chat ready with 9 requests'),
    ).toBeInTheDocument(),
  )
  expect(controlplane).toHaveBeenCalledTimes(1)
  expect(secure.fetch).toHaveBeenCalledTimes(1)
  expect(secure.fetch.mock.calls[0][0]).toBe(
    'https://harness.example/v1/session',
  )
  expect(encryptionService.initialize).not.toHaveBeenCalled()
  expect(authTokenManager.isSignedOut()).toBe(true)
  await expect(authTokenManager.getValidToken()).rejects.toMatchObject({
    reason: 'unavailable',
  })
})

it('does not request anonymous access when a signed-in account has no JWT', async () => {
  auth.userId = 'signed-in-account'
  render(
    <HarnessProvider>
      <SessionStatus />
    </HarnessProvider>,
  )
  await waitFor(() =>
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Authentication token is unavailable',
    ),
  )
  expect(controlplane).not.toHaveBeenCalled()
  expect(secure.fetch).not.toHaveBeenCalled()
  expect(authTokenManager.isSignedOut()).toBe(false)
  await expect(authTokenManager.getValidToken()).rejects.toMatchObject({
    reason: 'unavailable',
  })
})

it('aborts pending anonymous key issuance when the signed-in account changes', async () => {
  let resolve!: (response: Response) => void
  controlplane.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done
      }),
  )
  const view = render(
    <HarnessProvider>
      <SessionStatus />
    </HarnessProvider>,
  )
  await waitFor(() => expect(controlplane).toHaveBeenCalledTimes(1))
  const signal = controlplane.mock.calls[0][1]?.signal
  auth.userId = 'signed-in-account'
  view.rerender(
    <HarnessProvider>
      <SessionStatus />
    </HarnessProvider>,
  )
  expect(signal?.aborted).toBe(true)
  await act(async () => resolve(issuance()))
  expect(secure.fetch).not.toHaveBeenCalled()
  expect(controlplane).toHaveBeenCalledTimes(1)
})

it('shows the loader without contacting services until Clerk loads', async () => {
  auth.isLoaded = false
  render(
    <HarnessProvider>
      <SessionStatus />
    </HarnessProvider>,
  )
  expect(
    screen.getByRole('status', { name: 'Loading your session' }),
  ).toContainElement(screen.getByTestId('logo-loading'))
  expect(screen.queryByText('Connecting')).not.toBeInTheDocument()
  expect(controlplane).not.toHaveBeenCalled()
  expect(secure.fetch).not.toHaveBeenCalled()
  await expect(authTokenManager.getValidToken()).rejects.toMatchObject({
    reason: 'not-initialized',
  })
})

it('opens a shared chat as a visitor before Clerk loads, and keeps that session until the page is left', async () => {
  auth.isLoaded = false
  // A new element each time, so a rerender reads the auth state again.
  const shared = () => (
    <HarnessProvider anonymous>
      <SessionStatus />
    </HarnessProvider>
  )
  const view = render(shared())
  await waitFor(() =>
    expect(
      screen.getByText('Anonymous chat ready with 9 requests'),
    ).toBeInTheDocument(),
  )
  const sent = () =>
    secure.fetch.mock.calls.map(([url, init]) => [
      url,
      new Headers(init.headers).get('Authorization'),
    ])
  expect(sent()).toEqual([
    ['https://harness.example/v1/session', 'Bearer free_guest'],
  ])

  // Clerk loads a signed-in account, which the shared chat does not use.
  auth.isLoaded = true
  auth.userId = 'alice'
  auth.getToken.mockResolvedValue('alice-jwt')
  view.rerender(shared())
  await act(async () => {})

  expect(
    screen.getByText('Anonymous chat ready with 9 requests'),
  ).toBeInTheDocument()
  expect(sent()).toEqual([
    ['https://harness.example/v1/session', 'Bearer free_guest'],
  ])
  expect(auth.getToken).not.toHaveBeenCalled()
  await expect(authTokenManager.getValidToken()).rejects.toMatchObject({
    reason: 'not-initialized',
  })

  // Another page opens the account's own session.
  secure.fetch.mockImplementation(async () =>
    Response.json({ ...testSession, user: { id: 'alice', anonymous: false } }),
  )
  view.rerender(
    <HarnessProvider>
      <SessionStatus />
    </HarnessProvider>,
  )
  await waitFor(() => expect(secure.fetch).toHaveBeenCalledTimes(2))
  expect(sent()[1]).toEqual([
    'https://harness.example/v1/session',
    'Bearer alice-jwt',
  ])
  await waitFor(() =>
    expect(screen.getByText('Connecting')).toBeInTheDocument(),
  )
})

// A refusal the enclave sealed, as the harness gives one.
function refusal(error: Record<string, unknown>, status: number) {
  return Response.json({ error }, { status, headers: SEALED })
}

// Lets a load do what it does between two waits, without passing a wait.
const settle = () => act(() => vi.advanceTimersByTimeAsync(0))

describe('a session that fails to load', () => {
  it.each([
    {
      failure: 'cannot be reached',
      fail: () =>
        secure.fetch.mockRejectedValueOnce(new TypeError('Failed to fetch')),
      shown: 'Failed to fetch',
      wait: SESSION_RETRY_DELAYS_MS[0],
    },
    {
      failure: 'names a longer wait',
      fail: () =>
        secure.fetch.mockResolvedValueOnce(
          refusal(
            {
              code: 'UPSTREAM_REFUSED',
              message: 'The chat service is starting',
              action: 'retry',
              retryAfter: 5,
            },
            503,
          ),
        ),
      shown: 'The chat service is starting',
      wait: 5_000,
    },
  ])(
    'loads on its own once a chat service that $failure answers',
    async ({ fail, shown, wait }) => {
      fakeTimeouts()
      fail()
      render(
        <HarnessProvider>
          <SessionStatus />
        </HarnessProvider>,
      )
      await settle()
      expect(screen.getByRole('alert')).toHaveTextContent(shown)

      await act(() => vi.advanceTimersByTimeAsync(wait - 1))
      expect(secure.fetch).toHaveBeenCalledTimes(1)
      expect(screen.getByRole('alert')).toHaveTextContent(shown)

      await act(() => vi.advanceTimersByTimeAsync(1))
      expect(secure.fetch).toHaveBeenCalledTimes(2)
      expect(
        screen.getByText('Anonymous chat ready with 9 requests'),
      ).toBeInTheDocument()
    },
  )

  it.each([
    {
      failure: 'the chat service refuses for good',
      fail: () =>
        secure.fetch.mockResolvedValue(
          refusal(
            {
              code: 'BAD_REQUEST',
              message: 'This client is too old',
              action: 'stop',
            },
            400,
          ),
        ),
      shown: 'This client is too old',
    },
    {
      failure: 'a signed-in account has no JWT',
      fail: () => {
        auth.userId = 'signed-in-account'
      },
      shown: 'Authentication token is unavailable',
    },
  ])('is not asked for again when $failure', async ({ fail, shown }) => {
    fakeTimeouts()
    fail()
    render(
      <HarnessProvider>
        <SessionStatus />
      </HarnessProvider>,
    )
    await settle()
    expect(screen.getByRole('alert')).toHaveTextContent(shown)
    const requests = secure.fetch.mock.calls.length
    const tokens = auth.getToken.mock.calls.length

    await act(() =>
      vi.advanceTimersByTimeAsync(
        SESSION_RETRY_DELAYS_MS.reduce((sum, ms) => sum + ms, 0),
      ),
    )

    expect(secure.fetch).toHaveBeenCalledTimes(requests)
    expect(auth.getToken).toHaveBeenCalledTimes(tokens)
    expect(screen.getByRole('alert')).toHaveTextContent(shown)
  })

  it('leaves a load that waits to the one asked for after it', async () => {
    fakeTimeouts()
    secure.fetch.mockRejectedValue(new TypeError('Failed to fetch'))
    render(
      <HarnessProvider>
        <SessionStatus />
      </HarnessProvider>,
    )
    await settle()
    expect(secure.fetch).toHaveBeenCalledTimes(1)

    act(() => {
      window.dispatchEvent(new Event(AUTH_ACTIVE_USER_CHANGED_EVENT))
    })
    await settle()
    expect(secure.fetch).toHaveBeenCalledTimes(2)

    await act(() => vi.advanceTimersByTimeAsync(SESSION_RETRY_DELAYS_MS[0]))
    expect(secure.fetch).toHaveBeenCalledTimes(3)
  })

  it('keeps trying a load when the one asked for after it never starts', async () => {
    fakeTimeouts()
    auth.userId = 'signed-in-account'
    auth.getToken.mockResolvedValue('signed-in-jwt')
    let initialize!: () => void
    vi.mocked(encryptionService.initialize)
      .mockReturnValueOnce(
        new Promise((done) => {
          initialize = () => done(null)
        }),
      )
      .mockRejectedValueOnce(new Error('invalid saved key'))
    secure.fetch
      .mockReset()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockImplementation(async () =>
        Response.json({
          ...testSession,
          user: { id: 'signed-in-account', anonymous: false },
        }),
      )
    render(
      <HarnessProvider>
        <SessionStatus />
      </HarnessProvider>,
    )
    await settle()
    act(() => {
      window.dispatchEvent(new Event(AUTH_ACTIVE_USER_CHANGED_EVENT))
    })
    await settle()
    expect(screen.getByRole('alert')).toHaveTextContent('invalid saved key')
    expect(secure.fetch).not.toHaveBeenCalled()

    await act(async () => initialize())
    await settle()
    expect(secure.fetch).toHaveBeenCalledTimes(1)

    await act(() => vi.advanceTimersByTimeAsync(SESSION_RETRY_DELAYS_MS[0]))
    expect(secure.fetch).toHaveBeenCalledTimes(2)
    expect(screen.getByText('Connecting')).toBeInTheDocument()
  })
})

function StorageMode() {
  const { session, keyReady, profileReady, profile } = useHarness()
  if (!session || !profileReady) return <p>Loading settings</p>
  return (
    <p>
      {`${keyReady ? 'Key ready' : 'No key'} with ${profile.nickname ?? 'no nickname'}`}
    </p>
  )
}

describe('signed-in storage modes', () => {
  beforeEach(() => {
    auth.userId = 'storage-user'
    auth.getToken.mockReset().mockResolvedValue('signed-in-jwt')
    secure.fetch.mockReset().mockImplementation(async (url) =>
      String(url).endsWith('/v1/session')
        ? Response.json({
            ...testSession,
            user: { id: 'storage-user', anonymous: false },
          })
        : Response.json(
            {
              error: {
                code: 'BAD_REQUEST',
                message: 'Unexpected request',
                action: 'stop',
              },
            },
            { status: 400 },
          ),
    )
  })

  it('reads an account’s local settings without the harness when it does not sync', async () => {
    localStorage.setItem(
      USER_PREFS_LOCAL_PROFILE,
      JSON.stringify({ nickname: 'Local Sam' }),
    )
    localStorage.setItem(USER_PREFS_LOCAL_PROFILE_UPGRADED, 'true')
    render(
      <HarnessProvider>
        <StorageMode />
      </HarnessProvider>,
    )
    await waitFor(() =>
      expect(screen.getByText('No key with Local Sam')).toBeInTheDocument(),
    )
    expect(secure.fetch.mock.calls.map(([url]) => url)).toEqual([
      'https://harness.example/v1/session',
    ])
    expect(localStorage.getItem(SETTINGS_CLOUD_SYNC_ENABLED)).toBeNull()
  })

  it.each([
    { disabled: null, enabled: 'true' },
    { disabled: 'true', enabled: null },
  ])(
    'turns cloud sync on for a key on this device unless it was turned off ($disabled)',
    async ({ disabled, enabled }) => {
      localStorage.setItem(USER_ENCRYPTION_KEY, `key_${'cd'.repeat(32)}`)
      if (disabled)
        localStorage.setItem(SETTINGS_CLOUD_SYNC_EXPLICITLY_DISABLED, disabled)
      render(
        <HarnessProvider>
          <StorageMode />
        </HarnessProvider>,
      )
      // The session is requested once the saved key has been checked.
      await waitFor(() =>
        expect(secure.fetch.mock.calls[0]?.[0]).toBe(
          'https://harness.example/v1/session',
        ),
      )
      expect(encryptionService.initialize).toHaveBeenCalledOnce()
      expect(localStorage.getItem(SETTINGS_CLOUD_SYNC_ENABLED)).toBe(enabled)
    },
  )
})
