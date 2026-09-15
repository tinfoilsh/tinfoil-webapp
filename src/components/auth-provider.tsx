import {
  ClerkFailed,
  ClerkLoaded,
  ClerkLoading,
  ClerkProvider,
} from '@clerk/nextjs'
import { useEffect, useState, type ReactNode } from 'react'
import { AuthCleanupHandler } from './auth-cleanup-handler'

function AuthUnavailable() {
  return (
    <main
      role="alert"
      className="flex h-screen flex-col items-center justify-center gap-4 bg-surface-chat-background p-8 text-content-primary"
    >
      <p>
        Unable to load your sign-in session. Check your connection and try
        again.
      </p>
      <button
        type="button"
        className="rounded-lg bg-brand-accent-dark px-4 py-2 text-white"
        onClick={() => window.location.reload()}
      >
        Try again
      </button>
    </main>
  )
}

function AuthLoading() {
  const [timedOut, setTimedOut] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setTimedOut(true), 20_000)
    return () => clearTimeout(timer)
  }, [])
  return timedOut ? (
    <AuthUnavailable />
  ) : (
    <main
      role="status"
      className="flex h-screen items-center justify-center bg-surface-chat-background text-content-primary"
    >
      Loading your session…
    </main>
  )
}

export function AuthProvider({ children }: { children: ReactNode }) {
  return (
    <ClerkProvider
      telemetry={false}
      afterSignOutUrl="/"
      signInUrl="/signin"
      appearance={{ elements: { modalBackdrop: 'bg-black/50' } }}
    >
      <ClerkLoading>
        <AuthLoading />
      </ClerkLoading>
      <ClerkFailed>
        <AuthUnavailable />
      </ClerkFailed>
      <ClerkLoaded>
        <AuthCleanupHandler />
        {children}
      </ClerkLoaded>
    </ClerkProvider>
  )
}
