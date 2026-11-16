import { LogoLoading } from '@/components/ui/logo-loading'
import {
  answerOpener,
  callbackAnswer,
  finishSignIn,
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

type Progress =
  | { status: 'finishing' }
  // The answer went to the page that opened this sign-in window.
  | { status: 'handed' }
  | { status: 'failed'; message: string; returnTo: string }

// Where an authorization server sends the user back after they sign in to a
// connector. In a popup, the answer goes to the page that opened it, which
// finishes the sign-in; otherwise this page finishes it and returns to where
// the sign-in started.
export default function ConnectorCallbackPage() {
  const router = useRouter()
  const { api, keyLocked, profileReady } = useHarness()
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
    if (answerOpener(answer)) {
      started.current = true
      setProgress({ status: 'handed' })
      window.close()
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
    // The account's settings load once its key is unlocked.
    if (!profileReady) return
    started.current = true
    void (async () => {
      try {
        const outcome = await finishSignIn(api, answer)
        if (outcome.status === 'completed') {
          void router.replace(outcome.returnTo ?? SETTINGS_RETURN)
          return
        }
        if (outcome.status === 'refused')
          fail(
            'The sign-in was canceled or refused.',
            outcome.returnTo ?? SETTINGS_RETURN,
          )
        else
          fail(
            'This sign-in was not started in this tab. Start it again from Settings.',
          )
      } catch (cause) {
        logError('Failed to finish signing in to a connector', cause, {
          component: 'ConnectorCallbackPage',
          action: 'finishSignIn',
        })
        fail(describeConnectorError(cause))
      }
    })()
  }, [answer, api, keyLocked, profileReady, router])

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
          {progress.status === 'handed'
            ? 'Signed in'
            : 'Could not finish signing in'}
        </h1>
        <p
          role={progress.status === 'failed' ? 'alert' : undefined}
          className="mt-2 text-sm text-content-secondary"
        >
          {progress.status === 'handed'
            ? 'You can close this window.'
            : progress.message}
        </p>
        {progress.status === 'failed' && (
          <Link
            href={progress.returnTo}
            replace
            className="mt-4 inline-block rounded-lg bg-tinfoil-oak px-4 py-2 text-sm font-medium text-brand-dark transition-colors hover:bg-tinfoil-oak-hover"
          >
            Back to Tinfoil Chat
          </Link>
        )}
      </div>
    </main>
  )
}
