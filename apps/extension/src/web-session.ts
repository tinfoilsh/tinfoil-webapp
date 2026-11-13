import type { useClerk } from '@clerk/chrome-extension'
import type { GetToken } from '@tinfoil/chat-client/client'

const CLIENT_COOKIE = '__client'
const CLIENT_UPDATED_COOKIE = '__client_uat'
const DEV_BROWSER_COOKIE = '__clerk_db_jwt'
const ACCOUNT_CHANNEL = 'tinfoil-account'

// Tells the extension's other pages that this one changed who is signed in,
// which nothing else tells them at once.
export function announceAccountChange() {
  const channel = new BroadcastChannel(ACCOUNT_CHANNEL)
  channel.postMessage(null)
  channel.close()
}

export async function sessionToken(
  clerk: Pick<ReturnType<typeof useClerk>, 'session' | 'user'>,
  owner: string | null | undefined,
  options?: Parameters<GetToken>[0],
) {
  const session = clerk.session
  if (!session || session.user.id !== owner)
    throw new Error('The signed-in account changed.')
  const token = await session.getToken(options)
  if (clerk.session?.id !== session.id || clerk.user?.id !== owner)
    throw new Error('The signed-in account changed.')
  return token
}

export function watchWebSession(
  frontendAPI: string,
  reload: () => Promise<unknown>,
  onResult: (error: unknown | null) => void,
) {
  const host = new URL(frontendAPI).hostname
  let disposed = false
  let pending: Promise<void> | undefined
  let requested = false

  const refresh = () => {
    if (disposed) return Promise.resolve()
    requested = true
    pending ??= Promise.resolve().then(async () => {
      try {
        while (requested && !disposed) {
          requested = false
          try {
            await reload()
            if (!disposed) onResult(null)
          } catch (cause) {
            if (!disposed) onResult(cause)
          }
        }
      } finally {
        pending = undefined
      }
    })
    return pending
  }
  const cookieChanged = ({ cookie }: chrome.cookies.CookieChangeInfo) => {
    const domain = cookie.domain.replace(/^\./, '')
    const matchesHost =
      domain === host || (!cookie.hostOnly && host.endsWith(`.${domain}`))
    const matchesCookie =
      cookie.name === CLIENT_COOKIE ||
      cookie.name === CLIENT_UPDATED_COOKIE ||
      cookie.name.startsWith(`${CLIENT_UPDATED_COOKIE}_`) ||
      cookie.name === DEV_BROWSER_COOKIE
    if (matchesHost && matchesCookie) void refresh()
  }
  const visible = () => {
    if (document.visibilityState === 'visible') void refresh()
  }
  const announced = new BroadcastChannel(ACCOUNT_CHANNEL)
  announced.addEventListener('message', () => void refresh())
  chrome.cookies.onChanged.addListener(cookieChanged)
  window.addEventListener('focus', visible)
  document.addEventListener('visibilitychange', visible)

  return {
    refresh,
    dispose() {
      disposed = true
      announced.close()
      chrome.cookies.onChanged.removeListener(cookieChanged)
      window.removeEventListener('focus', visible)
      document.removeEventListener('visibilitychange', visible)
    },
  }
}
