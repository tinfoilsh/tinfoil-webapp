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
const AUTHORIZATION_URL = `https://auth.notion.example/authorize?client_id=x&state=${STATE}&code_challenge=c`

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

// The sign-in popup this tab opens, which the browser lets it open unless
// `blocked`.
let popup: Window | null

beforeEach(() => {
  routerReplace.mockReset().mockResolvedValue(true)
  toast.mockReset()
  signIn({ cloud: true, session })
  client.post.mockImplementation(async (path: string) => {
    switch (path) {
      case '/v1/session':
        return structuredClone(session)
      case '/v1/connectors/list':
        return { connectors: [] }
      case '/v1/connectors/add':
        return { connector: connector(), authorizationUrl: AUTHORIZATION_URL }
      case '/v1/connectors/complete':
        return { connector: CONNECTED }
      default:
        throw new Error(`Unexpected harness request: ${path}`)
    }
  })
  popup = {} as Window
  vi.spyOn(window, 'open').mockImplementation(() => popup)
})

afterEach(() => {
  setLocation('/')
})

// Connects Notion from a chat's settings, which starts a sign-in in a popup.
async function connectFromChat() {
  setLocation('/chat/chat-1')
  const { result } = renderHook(() => useConnectors())
  await act(() => result.current.list.add('Notion', SERVER))
  expect(window.open).toHaveBeenCalledExactlyOnceWith(
    AUTHORIZATION_URL,
    expect.any(String),
    expect.any(String),
  )
  return result
}

describe('the connector sign-in callback', () => {
  it('finishes a sign-in this tab started and returns to where it started', async () => {
    await connectFromChat()
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

  it('refuses a state this tab did not start without asking the harness', async () => {
    await connectFromChat()
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
    setLocation(`/connectors/callback?error=access_denied&state=${STATE}`)

    render(<ConnectorCallbackPage />)

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The sign-in was canceled or refused.',
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

  it('hands the answer to the page that opened the popup', async () => {
    const opener = { location: window.location, postMessage: vi.fn() }
    vi.spyOn(window, 'opener', 'get').mockReturnValue(opener)
    const close = vi.spyOn(window, 'close').mockImplementation(() => {})
    setLocation(`/connectors/callback?code=the-code&state=${STATE}`)

    render(<ConnectorCallbackPage />)

    await waitFor(() => expect(close).toHaveBeenCalled())
    expect(opener.postMessage).toHaveBeenCalledExactlyOnceWith(
      {
        type: 'tinfoil-connector-callback',
        code: 'the-code',
        state: STATE,
      },
      window.location.origin,
    )
    expect(window.location.search).toBe('')
    expect(completions()).toEqual([])
  })
})

describe('a sign-in popup', () => {
  const answer = (source: unknown, data: Record<string, unknown>) =>
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'tinfoil-connector-callback', ...data },
        origin: window.location.origin,
        source: source as Window,
      }),
    )

  it('finishes the sign-in with what only the popup it opened sends back', async () => {
    const result = await connectFromChat()

    // Another window of this origin cannot answer for the popup.
    answer(window, { code: 'forged', state: STATE })
    expect(completions()).toEqual([])

    answer(popup, { code: 'the-code', state: STATE })
    await waitFor(() => expect(result.current.connectors).toEqual([CONNECTED]))
    expect(completions()).toEqual([
      [
        '/v1/connectors/complete',
        { key: KEY, id: 'connector-1', code: 'the-code', state: STATE },
        expect.any(AbortSignal),
      ],
    ])
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
