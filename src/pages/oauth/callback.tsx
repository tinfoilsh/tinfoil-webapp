import { completeOAuthAuthorization } from '@/services/auth'
import { logError } from '@/utils/error-handling'
import { useRouter } from 'next/router'
import { useEffect, useState } from 'react'

export default function OAuthCallbackPage() {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!router.isReady || typeof window === 'undefined') return

    let cancelled = false
    completeOAuthAuthorization(window.location.href)
      .then((returnTo) => {
        if (!cancelled) {
          void router.replace(returnTo)
        }
      })
      .catch((err) => {
        if (cancelled) return
        logError('Failed to complete OAuth callback', err, {
          component: 'OAuthCallbackPage',
          action: 'completeOAuthAuthorization',
        })
        setError(err instanceof Error ? err.message : 'Authorization failed')
      })

    return () => {
      cancelled = true
    }
  }, [router])

  return (
    <main className="flex min-h-screen items-center justify-center bg-surface-chat-background p-6 text-content-primary">
      <div className="w-full max-w-md rounded-2xl border border-border-subtle bg-surface-card p-6 text-center shadow-sm">
        <h1 className="font-aeonik text-xl font-semibold">
          {error ? 'Unable to connect Tinfoil' : 'Connecting Tinfoil…'}
        </h1>
        <p className="mt-3 text-sm text-content-secondary">
          {error
            ? 'Please return to chat and try again.'
            : 'You will be returned to chat automatically.'}
        </p>
        {error && (
          <button
            type="button"
            onClick={() => void router.replace('/')}
            className="mt-6 rounded-lg bg-brand-accent-dark px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-accent-dark/90"
          >
            Return to chat
          </button>
        )}
      </div>
    </main>
  )
}
