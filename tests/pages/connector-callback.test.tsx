import { CONNECTOR_SIGN_INS } from '@/constants/storage-keys'
import { useConnectors } from '@/hooks/use-connectors'
import ConnectorCallbackPage from '@/pages/connectors/callback'
import { publish } from '@/services/harness/runtime'
import type { Connector } from '@/services/harness/types'
import {
  act,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { client, KEY, signIn, testSession } from '../harness-fixture'

const routerReplace = vi.fn()
const router = { replace: routerReplace, isReady: true }
vi.mock('next/router', () => ({ useRouter: () => router }))
vi.mock('@/utils/error-handling', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarning: vi.fn(),
}))
const toast = vi.fn()
vi.mock('@/hooks/use-toast', () => ({
  toast: (...args: unknown[]) => toast(...args),
}))

const session = {
  ...testSession,
  features: { ...testSession.features, connectors: true },
}

const SERVER = 'https://mcp.notion.com/mcp'
const STATE = 'state-started-here'
const pageWith = (state: string) =>
  `https://auth.notion.example/authorize?client_id=x&state=${state}&code_challenge=c`
const AUTHORIZATION_URL = pageWith(STATE)
// The channel the callback page says how a sign-in ended on.
const SIGN_IN_CHANNEL = 'tinfoil-connector-sign-ins'

const connector = (fields: Partial<Connector> = {}): Connector => ({
  id: 'connector-1',
  name: 'Notion',
  url: SERVER,
  enabled: true,
  status: 'signedOut',
  signIn: true,
  createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-01T00:00:00Z',
  tools: [],
  ...fields,
})
const CONNECTED = connector({
  status: 'connected',
  tools: [{ name: 'search', permission: 'allow', readOnly: true }],
})

function setLocation(path: string) {
  window.history.replaceState(null, '', path)
}

const completions = () =>
  client.post.mock.calls.filter(([path]) => path === '/v1/connectors/complete')
const listings = () =>
  client.post.mock.calls.filter(([path]) => path === '/v1/connectors/list')

// The popup the browser opens, unless it blocks it, and the sign-ins this
// tab kept when the popup opened, which the popup's copy holds.
interface FakePopup {
  opener: unknown
  closed: boolean
  close: ReturnType<typeof vi.fn>
  location: { replace: ReturnType<typeof vi.fn> }
}
const fakePopup = (): FakePopup => ({
  opener: window,
  closed: false,
  close: vi.fn(),
  location: { replace: vi.fn() },
})
let popup: FakePopup | null
let keptWhenOpened: string | null
// The harness has the connector connected once the sign-in completed.
let completed: boolean

beforeEach(() => {
  routerReplace.mockReset().mockResolvedValue(true)
  toast.mockReset()
  completed = false
  signIn({ cloud: true, session })
  client.post.mockImplementation(async (path: string) => {
    switch (path) {
      case '/v1/session':
        return structuredClone(session)
      case '/v1/connectors/list':
        return { connectors: [completed ? CONNECTED : connector()] }
      case '/v1/connectors/add':
        return { connector: connector(), authorizationUrl: AUTHORIZATION_URL }
      case '/v1/connectors/authorize':
        return {
          connector: connector(),
          authorizationUrl: pageWith('state-started-again'),
        }
      case '/v1/connectors/complete':
        completed = true
        return { connector: CONNECTED }
      default:
        throw new Error(`Unexpected harness request: ${path}`)
    }
  })
  popup = fakePopup()
  keptWhenOpened = null
  vi.spyOn(window, 'open').mockImplementation(() => {
    keptWhenOpened = sessionStorage.getItem(CONNECTOR_SIGN_INS)
    return popup as unknown as Window
  })
})

const closedProperty = Object.getOwnPropertyDescriptor(window, 'closed')!
afterEach(() => {
  setLocation('/')
  Object.defineProperty(window, 'closed', closedProperty)
})

// Stubs closing this window: a popup closes, a tab does not.
function closingAsA(kind: 'popup' | 'tab') {
  return vi.spyOn(window, 'close').mockImplementation(() => {
    if (kind === 'popup')
      Object.defineProperty(window, 'closed', {
        configurable: true,
        value: true,
      })
  })
}

// Connects Notion from a chat's settings, which starts a sign-in.
async function connectFromChat() {
  setLocation('/chat/chat-1')
  const { result } = renderHook(() => useConnectors())
  await act(() => result.current.list.add('Notion', SERVER))
  return result
}

describe('starting a connector sign-in', () => {
  it('keeps the sign-in, then opens its page in a popup that cannot reach this tab', async () => {
    await connectFromChat()

    expect(window.open).toHaveBeenCalledExactlyOnceWith(
      '',
      expect.any(String),
      expect.any(String),
    )
    expect(JSON.parse(keptWhenOpened ?? '[]')).toEqual([
      expect.objectContaining({
        state: STATE,
        connectorId: 'connector-1',
        returnTo: '/chat/chat-1#settings/connectors',
      }),
    ])
    expect(popup!.opener).toBeNull()
    expect(popup!.location.replace).toHaveBeenCalledExactlyOnceWith(
      AUTHORIZATION_URL,
    )
  })

  it('opens the sign-in page in the tab when the popup is blocked', async () => {
    popup = null
    const assign = vi
      .spyOn(window.location, 'assign')
      .mockImplementation(() => {})

    await connectFromChat()

    expect(assign).toHaveBeenCalledExactlyOnceWith(AUTHORIZATION_URL)
  })
})

describe('the connector sign-in callback', () => {
  it('finishes a sign-in in the tab it took, and returns to where it started', async () => {
    popup = null
    vi.spyOn(window.location, 'assign').mockImplementation(() => {})
    await connectFromChat()
    const close = closingAsA('tab')
    setLocation(
      `/connectors/callback?code=the-code&state=${STATE}&iss=https%3A%2F%2Fauth.notion.example`,
    )

    render(<ConnectorCallbackPage />)

    // The code leaves the address before anything else happens.
    expect(window.location.search).toBe('')
    await waitFor(() =>
      expect(routerReplace).toHaveBeenCalledExactlyOnceWith(
        '/chat/chat-1#settings/connectors',
      ),
    )
    expect(close).toHaveBeenCalled()
    expect(completions()).toEqual([
      [
        '/v1/connectors/complete',
        {
          key: KEY,
          id: 'connector-1',
          code: 'the-code',
          state: STATE,
          iss: 'https://auth.notion.example',
        },
        expect.any(AbortSignal),
      ],
    ])
  })

  it('finishes a popup’s sign-in, tells the tab that started it, and closes', async () => {
    const result = await connectFromChat()
    expect(result.current.connectors).toEqual([connector()])
    closingAsA('popup')
    setLocation(`/connectors/callback?code=the-code&state=${STATE}`)

    render(<ConnectorCallbackPage />)

    await waitFor(() => expect(result.current.connectors).toEqual([CONNECTED]))
    expect(completions()).toEqual([
      [
        '/v1/connectors/complete',
        { key: KEY, id: 'connector-1', code: 'the-code', state: STATE },
        expect.any(AbortSignal),
      ],
    ])
    expect(routerReplace).not.toHaveBeenCalled()
    expect(toast).not.toHaveBeenCalled()
  })

  it('refuses a state this tab did not start without asking the harness', async () => {
    await connectFromChat()
    closingAsA('tab')
    setLocation('/connectors/callback?code=the-code&state=another-state')

    render(<ConnectorCallbackPage />)

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This sign-in was not started in this tab.',
    )
    expect(completions()).toEqual([])
    expect(routerReplace).not.toHaveBeenCalled()
  })

  it('refuses a sign-in the authorization server declined without asking the harness', async () => {
    await connectFromChat()
    closingAsA('popup')
    setLocation(`/connectors/callback?error=access_denied&state=${STATE}`)

    render(<ConnectorCallbackPage />)

    await waitFor(() =>
      expect(toast).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          description: 'The sign-in was canceled or refused.',
        }),
      ),
    )
    expect(completions()).toEqual([])
  })

  it('asks for the key to be unlocked before finishing a sign-in', async () => {
    await connectFromChat()
    // A refused key leaves the account's settings unloaded.
    signIn({ cloud: true, locked: true, session })
    publish({ profileReady: false })
    setLocation(`/connectors/callback?code=the-code&state=${STATE}`)

    render(<ConnectorCallbackPage />)

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Unlock your encryption key',
    )
    expect(completions()).toEqual([])
  })
})

describe('the tab that started a sign-in', () => {
  // Says on the channel how sign-ins ended, in order, as callback pages do.
  function signInsEnded(
    ...ended: [connectorId: string, signIn: string, status: string][]
  ) {
    const channel = new BroadcastChannel(SIGN_IN_CHANNEL)
    for (const [connectorId, signIn, status] of ended)
      channel.postMessage({
        type: 'connector-sign-in',
        connectorId,
        signIn,
        status,
      })
    channel.close()
  }
  // The id of the sign-in this tab started under a state.
  const signInOf = (state: string): string =>
    JSON.parse(sessionStorage.getItem(CONNECTOR_SIGN_INS) ?? '[]').find(
      (entry: { state: string }) => entry.state === state,
    ).signIn

  it('shows how its own sign-in ended, and ignores others', async () => {
    const result = await connectFromChat()
    const listed = listings().length
    const started = signInOf(STATE)

    signInsEnded(
      ['connector-2', started, 'refused'],
      ['connector-2', started, 'completed'],
      ['connector-1', started, 'failed'],
    )

    await waitFor(() =>
      expect(toast).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ title: 'Sign-in did not finish' }),
      ),
    )
    expect(listings()).toHaveLength(listed)
    expect(result.current.connectors).toEqual([connector()])
  })
})

describe('a connector signed in to again', () => {
  it('counts only the latest sign-in, whatever an earlier one says', async () => {
    const result = await connectFromChat()
    const first = popup!
    popup = fakePopup()

    await act(() => result.current.list.signIn('connector-1'))

    // The earlier popup holds a copy of this tab's sign-ins from before.
    expect(first.close).toHaveBeenCalledOnce()
    expect(popup.location.replace).toHaveBeenCalledExactlyOnceWith(
      pageWith('state-started-again'),
    )
    // The earlier popup ends its sign-in anyway, as one not closed in time.
    const close = closingAsA('popup')
    setLocation(`/connectors/callback?error=access_denied&state=${STATE}`)
    const earlier = render(<ConnectorCallbackPage />)
    await waitFor(() => expect(close).toHaveBeenCalledOnce())
    earlier.unmount()

    setLocation('/connectors/callback?code=the-code&state=state-started-again')
    render(<ConnectorCallbackPage />)

    await waitFor(() => expect(result.current.connectors).toEqual([CONNECTED]))
    expect(toast).not.toHaveBeenCalled()
  })
})
