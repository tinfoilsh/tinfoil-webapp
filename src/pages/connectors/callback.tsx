import { LogoLoading } from '@/components/ui/logo-loading'
import {
  announceSignIn,
  callbackAnswer,
  finishSignIn,
  startedSignIn,
  type CallbackAnswer,
} from '@/services/connectors/sign-in'
import { describeConnectorError } from '@/services/harness/connectors'
import { useHarness } from '@/services/harness/provider'
import { logError } from '@/utils/error-handling'
import Link from 'next/link'
import { useRouter } from 'next/router'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'

// Where the user goes when the sign-in names no page of its own.
const SETTINGS_RETURN = '/#settings/connectors'
const CLOUD_SYNC_RETURN = '/#settings/cloud-sync'
const STARTED_ELSEWHERE =
  'This sign-in was not started in this tab. Go back to where you started it, in Settings or in the Tinfoil app, and try again.'

type Progress =
  | { status: 'finishing' }
  | { status: 'failed'; message: string; returnTo: string }

// Where an authorization server sends the user back after they sign in to a
// connector. This page finishes the sign-in and tells the tab that started
// it how it ended. A popup then closes; the tab the sign-in took returns to
// where it started.
export default function ConnectorCallbackPage() {
  const router = useRouter()
  const { api, keyLocked, profileReady, error } = useHarness()
  // undefined until the address is read; null when it holds no answer.
  const [answer, setAnswer] = useState<CallbackAnswer | null>()
  const [progress, setProgress] = useState<Progress>({ status: 'finishing' })
  const started = useRef(false)

  // The answer is read once and taken out of the address at once, so the
  // tab's history does not keep the code. The router puts the query it read
  // as the page loaded back in the address until it is ready.
  useLayoutEffect(() => {
    if (!router.isReady) return
    const read = callbackAnswer(window.location.search)
    if (read) window.history.replaceState(null, '', window.location.pathname)
    setAnswer((kept) => kept ?? read)
  }, [router.isReady])

  useEffect(() => {
    if (answer === undefined || started.current) return
    const fail = (message: string, returnTo = SETTINGS_RETURN) => {
      started.current = true
      setProgress({ status: 'failed', message, returnTo })
    }
    if (!answer) {
      fail('There is no sign-in to finish here.')
      return
    }
    // Checked before the account, which the user may have only where they
    // started the sign-in.
    if (!startedSignIn(answer.state)) {
      fail(STARTED_ELSEWHERE)
      return
    }
    if (!api.userId) {
      fail('Sign in to Tinfoil Chat, then connect again.')
      return
    }
    if (keyLocked) {
      fail(
        'Unlock your encryption key in Settings, under Cloud Sync, then sign in to the connector again.',
        CLOUD_SYNC_RETURN,
      )
      return
    }
    // The account's settings load once its key is unlocked. While they
    // cannot, the user can go back; the sign-in goes on if they load.
    if (!profileReady) {
      if (error)
        setProgress({
          status: 'failed',
          message:
            'Your account could not be loaded. Check your connection, then sign in to the connector again from Settings.',
          returnTo: SETTINGS_RETURN,
        })
      return
    }
    started.current = true
    setProgress({ status: 'finishing' })
    void (async () => {
      let outcome: Awaited<ReturnType<typeof finishSignIn>>
      try {
        outcome = await finishSignIn(api, answer)
      } catch (cause) {
        logError('Failed to finish signing in to a connector', cause, {
          component: 'ConnectorCallbackPage',
          action: 'finishSignIn',
        })
        fail(describeConnectorError(cause))
        return
      }
      if (outcome.status === 'unknown') {
        fail(STARTED_ELSEWHERE)
        return
      }
      const { connectorId, signIn, status, returnTo } = outcome
      if (status === 'failed')
        logError('Failed to finish signing in to a connector', outcome.cause, {
          component: 'ConnectorCallbackPage',
          action: 'finishSignIn',
        })
      announceSignIn({
        connectorId,
        signIn,
        status,
        ...(status === 'failed'
          ? { reason: describeConnectorError(outcome.cause) }
          : {}),
      })
      // Only a popup closes.
      window.close()
      if (window.closed) return
      if (status === 'completed')
        void router.replace(returnTo ?? SETTINGS_RETURN)
      else
        fail(
          status === 'refused'
            ? 'The sign-in was canceled or refused.'
            : describeConnectorError(outcome.cause),
          returnTo ?? SETTINGS_RETURN,
        )
    })()
  }, [answer, api, keyLocked, profileReady, error, router])

  if (progress.status === 'finishing')
    return (
      <div role="status" aria-label="Finishing sign-in">
        <LogoLoading />
      </div>
    )
  return (
    <main className="flex h-screen items-center justify-center bg-surface-chat-background p-8">
      <div className="max-w-sm text-center">
        <h1 className="font-aeonik text-lg font-semibold text-content-primary">
          Could not finish signing in
        </h1>
        <p role="alert" className="mt-2 text-sm text-content-secondary">
          {progress.message}
        </p>
        <Link
          href={progress.returnTo}
          replace
          className="mt-4 inline-block rounded-lg bg-tinfoil-oak px-4 py-2 text-sm font-medium text-brand-dark transition-colors hover:bg-tinfoil-oak-hover"
        >
          Back to Tinfoil Chat
        </Link>
      </div>
    </main>
  )
}
