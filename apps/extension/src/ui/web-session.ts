import { useAuth, useClerk } from '@clerk/chrome-extension'
import { logError } from '@tinfoil/chat-client/logging'
import { useCallback, useEffect, useState } from 'react'
import { CLERK_FRONTEND_API } from '../config'
import { announceAccountChange, watchWebSession } from '../web-session'

// The account signed in on Tinfoil's website, which an extension page
// follows as it changes there.
export function useWebSession() {
  const { isLoaded, userId } = useAuth()
  const clerk = useClerk()
  const [signInError, setSignInError] = useState(false)
  useEffect(() => {
    if (!isLoaded) return
    const sync = watchWebSession(
      CLERK_FRONTEND_API,
      async () => {
        const client = await clerk.client.reload()
        if ((clerk.session?.id ?? null) !== client.lastActiveSessionId)
          await clerk.setActive({ session: client.lastActiveSessionId })
      },
      (cause) => {
        setSignInError(cause !== null)
        if (cause !== null) logError('Unable to refresh website sign-in', cause)
      },
    )
    void sync.refresh()
    return sync.dispose
  }, [clerk, isLoaded])
  // Signing out stays on the page. Left to itself, Clerk goes to an address
  // afterwards, at times by way of its own service, which cannot send a tab
  // back to an extension page.
  const signOut = useCallback(async () => {
    await clerk.signOut(() => undefined)
    announceAccountChange()
  }, [clerk])
  return { isLoaded, userId, clerk, signInError, signOut }
}
