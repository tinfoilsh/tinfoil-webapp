import { CONNECTOR_SIGN_INS } from '@/constants/storage-keys'
import { completeConnector } from '@/services/harness/connectors'
import { ERROR_ACTIONS, ERROR_CODES } from '@/services/harness/protocol'
import type { HarnessAPI } from '@/services/harness/runtime'
import { HarnessError } from '@/services/harness/sse'
import { sanitizeRelativeRedirect } from '@/utils/redirect-url'

// Signing in to a connector. The harness starts a sign-in and names the
// authorization server's page; this tab keeps which connector the sign-in is
// for, under the state the page will return, and opens the page in a popup
// that cannot reach this tab, or in the tab itself when the popup is
// blocked. The authorization server sends the user back to the callback
// page with a code and that state. The callback page finishes the sign-in:
// the harness trades the code for tokens it keeps, so the code only passes
// through the browser. A popup's callback page then tells the tab that
// started the sign-in how it ended. The callback page's address is the one
// the app's client metadata document (public/oauth/client-metadata.json)
// names.

// How long a sign-in started in this tab waits for the user to come back.
const SIGN_IN_TTL_MS = 30 * 60_000
const POPUP_NAME = 'tinfoil-connector-sign-in'
const POPUP_FEATURES = 'popup,width=520,height=720'
// The channel a callback page tells this app's tabs how a sign-in ended on,
// and the type of its messages.
const SIGN_IN_CHANNEL = 'tinfoil-connector-sign-ins'
const SIGN_IN_MESSAGE = 'connector-sign-in'

// How a sign-in ended: the harness finished it, the authorization server
// refused it or the user canceled it, or finishing it failed.
export type SignInStatus = 'completed' | 'refused' | 'failed'
const STATUSES: readonly string[] = ['completed', 'refused', 'failed']

// What the callback page tells the tab that started a sign-in. It never
// holds the code or the state.
interface SignInEnded {
  type: typeof SIGN_IN_MESSAGE
  connectorId: string
  status: SignInStatus
}

interface PendingSignIn {
  state: string
  connectorId: string
  // Where the tab goes once the sign-in finishes in it.
  returnTo: string
  startedAt: number
}

// What the user came back from a sign-in page with: a code and the state
// the sign-in started with, and the issuer when the authorization server
// names one, or the error it refused the sign-in with.
export interface CallbackAnswer {
  code?: string
  state?: string
  iss?: string
  error?: string
}

const ANSWER_FIELDS = ['code', 'state', 'iss', 'error'] as const

function isPending(value: unknown): value is PendingSignIn {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  return (
    typeof entry.state === 'string' &&
    typeof entry.connectorId === 'string' &&
    typeof entry.returnTo === 'string' &&
    typeof entry.startedAt === 'number'
  )
}

// The sign-ins this tab started that still wait for the user.
function pendingSignIns(): PendingSignIn[] {
  let stored: unknown
  try {
    stored = JSON.parse(sessionStorage.getItem(CONNECTOR_SIGN_INS) ?? '[]')
  } catch {
    return []
  }
  const now = Date.now()
  return Array.isArray(stored)
    ? stored.filter(
        (entry) => isPending(entry) && now - entry.startedAt < SIGN_IN_TTL_MS,
      )
    : []
}

function keepSignIns(entries: PendingSignIn[]) {
  if (entries.length)
    sessionStorage.setItem(CONNECTOR_SIGN_INS, JSON.stringify(entries))
  else sessionStorage.removeItem(CONNECTOR_SIGN_INS)
}

// The sign-in this tab started under a state, which no longer waits once
// taken.
function takeSignIn(state: string): PendingSignIn | undefined {
  const entries = pendingSignIns()
  const found = entries.find((entry) => entry.state === state)
  if (found) keepSignIns(entries.filter((entry) => entry !== found))
  return found
}

// What an address's query holds of a sign-in page's answer, if anything.
export function callbackAnswer(search: string): CallbackAnswer | null {
  const params = new URLSearchParams(search)
  const answer: CallbackAnswer = {}
  for (const field of ANSWER_FIELDS) {
    const value = params.get(field)
    if (value) answer[field] = value
  }
  return Object.keys(answer).length ? answer : null
}

const signInRefused = (message: string) =>
  new HarnessError({
    code: ERROR_CODES.connectorSignInFailed,
    action: ERROR_ACTIONS.stop,
    message,
  })

// Sends the user to the page that signs them in to a connector. The sign-in
// is kept first, so a popup's copy of this tab's sign-ins holds it. The
// popup opens blank, so a blocked one is told apart, and loses its opener
// before it loads the authorization server's page, which could otherwise
// navigate this tab. A blocked popup takes this tab to the page instead.
// Says where the page opened.
export function openSignIn(
  authorizationUrl: string,
  connectorId: string,
  returnTo: string,
): 'popup' | 'tab' {
  let page: URL
  try {
    page = new URL(authorizationUrl)
  } catch {
    throw signInRefused('The sign-in page has an invalid address.')
  }
  const state = page.searchParams.get('state')
  if (page.protocol !== 'https:' || !state)
    throw signInRefused('The sign-in page has an invalid address.')
  keepSignIns([
    ...pendingSignIns().filter((entry) => entry.state !== state),
    { state, connectorId, returnTo, startedAt: Date.now() },
  ])
  const popup = window.open('', POPUP_NAME, POPUP_FEATURES)
  if (!popup) {
    window.location.assign(page.href)
    return 'tab'
  }
  popup.opener = null
  popup.location.replace(page.href)
  return 'popup'
}

// Calls `ended` with each sign-in a callback page in another window says
// ended. Returns what stops listening.
export function listenForSignIns(
  ended: (message: Omit<SignInEnded, 'type'>) => void,
): () => void {
  const channel = new BroadcastChannel(SIGN_IN_CHANNEL)
  channel.onmessage = (event: MessageEvent) => {
    const data: unknown = event.data
    if (typeof data !== 'object' || data === null) return
    const message = data as Record<string, unknown>
    if (
      message.type === SIGN_IN_MESSAGE &&
      typeof message.connectorId === 'string' &&
      typeof message.status === 'string' &&
      STATUSES.includes(message.status)
    )
      ended({
        connectorId: message.connectorId,
        status: message.status as SignInStatus,
      })
  }
  return () => channel.close()
}

export type SignInOutcome =
  // No sign-in this tab started returns this state.
  | { status: 'unknown' }
  | {
      status: SignInStatus
      connectorId: string
      returnTo: string | null
      // Why finishing the sign-in failed.
      cause?: unknown
    }

// Finishes a sign-in this tab started, with what the user came back from
// its page with. An answer to a sign-in this tab did not start, or one the
// authorization server refused, never reaches the harness.
export async function finishSignIn(
  api: HarnessAPI,
  { code, state, iss, error }: CallbackAnswer,
): Promise<SignInOutcome> {
  const pending = state ? takeSignIn(state) : undefined
  if (!pending) return { status: 'unknown' }
  const ended = {
    connectorId: pending.connectorId,
    returnTo: sanitizeRelativeRedirect(pending.returnTo),
  }
  if (error || !code) return { status: 'refused', ...ended }
  try {
    await completeConnector(api, {
      id: pending.connectorId,
      code,
      state: pending.state,
      ...(iss ? { iss } : {}),
    })
  } catch (cause) {
    return { status: 'failed', ...ended, cause }
  }
  return { status: 'completed', ...ended }
}

// Tells this app's other tabs how a sign-in ended, so the one that started
// it shows it.
export function announceSignIn({
  connectorId,
  status,
}: Omit<SignInEnded, 'type'>) {
  const channel = new BroadcastChannel(SIGN_IN_CHANNEL)
  const message: SignInEnded = { type: SIGN_IN_MESSAGE, connectorId, status }
  channel.postMessage(message)
  channel.close()
}
