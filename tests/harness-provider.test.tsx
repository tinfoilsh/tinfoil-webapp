import { encryptionService } from '@/services/encryption/encryption-service'
import { HarnessProvider, useHarness } from '@/services/harness/provider'
import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { testSession } from './harness-fixture'

const { auth, secure, controlplane } = vi.hoisted(() => ({
  auth: {
    userId: null as string | null,
    getToken: vi.fn<() => Promise<string | null>>(),
  },
  secure: {
    ready: vi.fn<() => Promise<void>>(),
    fetch: vi.fn<(url: string, init: RequestInit) => Promise<Response>>(),
    getVerificationDocument: vi.fn(),
  },
  controlplane: vi.fn<typeof fetch>(),
}))

vi.mock('@clerk/nextjs', () => ({
  useAuth: () => ({ isLoaded: true, ...auth }),
}))
vi.mock('@/services/harness/client', async (importOriginal) => {
  const { HarnessClient } =
    await importOriginal<typeof import('@/services/harness/client')>()
  return {
    HarnessClient: class extends HarnessClient {
      constructor(...args: ConstructorParameters<typeof HarnessClient>) {
        super(args[0], args[1], secure)
      }
    },
  }
})

function issuance() {
  return Response.json({
    key: 'free_guest',
    is_free_tier: true,
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    rate_limit: {
      max_requests: 10,
      remaining: 9,
      resets_at: new Date(Date.now() + 3_600_000).toISOString(),
    },
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
  auth.userId = null
  auth.getToken.mockReset().mockResolvedValue(null)
  secure.ready.mockReset().mockResolvedValue(undefined)
  secure.fetch.mockReset().mockImplementation(async (_url, init) => {
    if (new Headers(init.headers).get('Authorization') !== 'Bearer free_guest')
      return Response.json(
        {
          error: {
            code: 'UNAUTHENTICATED',
            message: 'An anonymous chat key is required',
          },
        },
        { status: 401 },
      )
    return Response.json({
      ...testSession,
      rateLimit: { kind: null, maxRequests: 0, remaining: 0 },
    })
  })
  controlplane.mockReset().mockImplementation(async () => issuance())
  vi.stubGlobal('fetch', controlplane)
  vi.stubEnv('NEXT_PUBLIC_HARNESS_ENCLAVE_URL', 'https://harness.example')
  vi.spyOn(encryptionService, 'initialize').mockResolvedValue(null)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
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
