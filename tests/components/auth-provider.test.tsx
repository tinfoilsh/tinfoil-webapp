import { AuthProvider } from '@/components/auth-provider'
import { useAuth, useUser } from '@clerk/nextjs'
import { act, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const clerk = vi.hoisted(() => ({
  status: 'ready',
  provider: vi.fn(),
  cleanup: vi.fn(),
  getToken: vi.fn().mockResolvedValue('test-session-token'),
}))

vi.mock('@clerk/nextjs', () => ({
  ClerkProvider: ({ children, ...props }: { children: ReactNode }) => {
    clerk.provider(props)
    return children
  },
  ClerkLoading: ({ children }: { children: ReactNode }) =>
    clerk.status === 'loading' ? children : null,
  ClerkLoaded: ({ children }: { children: ReactNode }) =>
    clerk.status === 'ready' ? children : null,
  ClerkFailed: ({ children }: { children: ReactNode }) =>
    clerk.status === 'error' ? children : null,
  useAuth: () => ({
    isLoaded: true,
    isSignedIn: true,
    userId: 'account-one',
    getToken: clerk.getToken,
    signOut: vi.fn(),
  }),
  useUser: () => ({
    isLoaded: true,
    isSignedIn: true,
    user: { id: 'account-one' },
  }),
}))
vi.mock('@/components/auth-cleanup-handler', () => ({
  AuthCleanupHandler: () => {
    clerk.cleanup()
    return null
  },
}))
function Identity() {
  const auth = useAuth()
  const { user } = useUser()
  return (
    <p>
      {auth.isLoaded
        ? auth.isSignedIn
          ? user?.id
          : 'Anonymous chat'
        : 'Waiting'}
    </p>
  )
}

beforeEach(() => {
  clerk.status = 'ready'
  vi.clearAllMocks()
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it('renders the loaded Clerk session with telemetry disabled', () => {
  render(
    <AuthProvider>
      <Identity />
    </AuthProvider>,
  )
  expect(screen.getByText('account-one')).toBeInTheDocument()
  expect(clerk.provider).toHaveBeenCalledWith(
    expect.objectContaining({ telemetry: false }),
  )
  expect(clerk.cleanup).toHaveBeenCalled()
})

it('shows a retry action when Clerk fails', () => {
  clerk.status = 'error'
  render(
    <AuthProvider>
      <Identity />
    </AuthProvider>,
  )
  expect(screen.getByRole('alert')).toHaveTextContent(
    'Unable to load your sign-in session',
  )
  expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  expect(screen.queryByText('account-one')).not.toBeInTheDocument()
})

it('bounds the loading screen and still renders a session that finishes loading later', async () => {
  vi.useFakeTimers()
  clerk.status = 'loading'
  const view = render(
    <AuthProvider>
      <Identity />
    </AuthProvider>,
  )
  expect(screen.getByRole('status')).toBeInTheDocument()
  await act(async () => vi.advanceTimersByTime(20_000))
  expect(screen.getByRole('alert')).toBeInTheDocument()
  clerk.status = 'ready'
  view.rerender(
    <AuthProvider>
      <Identity />
    </AuthProvider>,
  )
  expect(screen.getByText('account-one')).toBeInTheDocument()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})
