import { CONNECTOR_SIGN_INS } from '@/constants/storage-keys'
import { completeConnector } from '@/services/harness/connectors'
import { ERROR_ACTIONS, ERROR_CODES } from '@/services/harness/protocol'
import type { HarnessAPI } from '@/services/harness/runtime'
import { HarnessError } from '@/services/harness/sse'
import type { Connector } from '@/services/harness/types'
import { sanitizeRelativeRedirect } from '@/utils/redirect-url'

// Signing in to a connector. The harness starts a sign-in and names the
// authorization server's page; this tab keeps which connector the sign-in is
// for, under the state the page will return, and opens the page in a popup,
// or in the tab itself when the popup is blocked. The authorization server
// sends the user back to the callback page with a code and that state,
// which the harness trades for tokens it keeps. The code only passes through
// the browser. The callback page's address is the one the app's client
// metadata document (public/oauth/client-metadata.json) names.

// The type of the message a sign-in popup sends the page that opened it.
const CALLBACK_MESSAGE = 'tinfoil-connector-callback'
// How long a sign-in started in this tab waits for the user to come back.
const SIGN_IN_TTL_MS = 30 * 60_000
const POPUP_NAME = 'tinfoil-connector-sign-in'
const POPUP_FEATURES = 'popup,width=520,height=720'

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

// A sign-in page's answer as a popup sent it, if the message is one.
function messageAnswer(data: unknown): CallbackAnswer | null {
  if (typeof data !== 'object' || data === null) return null
  const message = data as Record<string, unknown>
  if (message.type !== CALLBACK_MESSAGE) return null
  const answer: CallbackAnswer = {}
  for (const field of ANSWER_FIELDS)
    if (typeof message[field] === 'string' && message[field])
      answer[field] = message[field]
  return answer
}

const signInRefused = (message: string) =>
  new HarnessError({
    code: ERROR_CODES.connectorSignInFailed,
    action: ERROR_ACTIONS.stop,
    message,
  })

// Sends the user to the page that signs them in to a connector: in a popup
// that answers this page, or in this tab when the browser blocks the popup.
// Returns the popup, or null once the tab is on its way.
export function openSignIn(
  authorizationUrl: string,
  connectorId: string,
  returnTo: string,
): Window | null {
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
  const popup = window.open(page.href, POPUP_NAME, POPUP_FEATURES)
  if (popup) return popup
  window.location.assign(page.href)
  return null
}

// Calls `answered` with what the popup this page opened sends back. Only a
// message from that popup, on this app's origin, counts. Returns what stops
// waiting.
export function awaitPopupAnswer(
  popup: Window,
  answered: (answer: CallbackAnswer) => void,
): () => void {
  const listener = (event: MessageEvent) => {
    if (event.origin !== window.location.origin || event.source !== popup)
      return
    const answer = messageAnswer(event.data)
    if (!answer) return
    stop()
    answered(answer)
  }
  const stop = () => window.removeEventListener('message', listener)
  window.addEventListener('message', listener)
  return stop
}

// The page that opened this window, when it is this app's.
function appOpener(): Window | null {
  const opener: unknown = window.opener
  if (!opener || opener === window) return null
  try {
    return (opener as Window).location.origin === window.location.origin
      ? (opener as Window)
      : null
  } catch {
    // An opener on another origin cannot be read.
    return null
  }
}

// Hands a sign-in page's answer to the page of this app that opened the
// sign-in popup, if one did. Says whether it did.
export function answerOpener(answer: CallbackAnswer): boolean {
  const opener = appOpener()
  if (!opener) return false
  opener.postMessage(
    { type: CALLBACK_MESSAGE, ...answer },
    window.location.origin,
  )
  return true
}

export type SignInOutcome =
  // The harness finished the sign-in.
  | { status: 'completed'; connector: Connector; returnTo: string | null }
  // The authorization server refused it, or the user canceled it.
  | { status: 'refused'; returnTo: string | null }
  // No sign-in this tab started returns this state.
  | { status: 'unknown' }

// Finishes a sign-in this tab started, with what the user came back from
// its page with. An answer to a sign-in this tab did not start, or one the
// authorization server refused, never reaches the harness.
export async function finishSignIn(
  api: HarnessAPI,
  { code, state, iss, error }: CallbackAnswer,
): Promise<SignInOutcome> {
  const pending = state ? takeSignIn(state) : undefined
  if (!pending) return { status: 'unknown' }
  const returnTo = sanitizeRelativeRedirect(pending.returnTo)
  if (error || !code) return { status: 'refused', returnTo }
  const { connector } = await completeConnector(api, {
    id: pending.connectorId,
    code,
    state: pending.state,
    ...(iss ? { iss } : {}),
  })
  return { status: 'completed', connector, returnTo }
}
