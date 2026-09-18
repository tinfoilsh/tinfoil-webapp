import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'

const plausibleScript = readFileSync(
  resolve(process.cwd(), 'public/js/plausible.js'),
  'utf8',
)

type Plausible = (eventName: string, options?: object) => void

function loadPlausible(url: string, referrer = '') {
  const parsedUrl = new URL(url)
  const location = {
    href: parsedUrl.href,
    hostname: parsedUrl.hostname,
    origin: parsedUrl.origin,
    pathname: parsedUrl.pathname,
    protocol: parsedUrl.protocol,
  }
  const fetchMock = vi.fn().mockResolvedValue({ status: 202 })
  const windowMock: {
    addEventListener: ReturnType<typeof vi.fn>
    fetch: typeof fetchMock
    history: {
      pushState: (
        data: unknown,
        unused: string,
        url?: string | URL | null,
      ) => void
    }
    localStorage: object
    navigator: { webdriver: boolean }
    plausible?: Plausible
  } = {
    addEventListener: vi.fn(),
    fetch: fetchMock,
    history: {
      pushState: vi.fn(),
    },
    localStorage: {},
    navigator: {
      webdriver: false,
    },
  }
  const documentMock = {
    addEventListener: vi.fn(),
    body: {},
    currentScript: {
      getAttribute: (name: string) => {
        if (name === 'data-api') return 'https://plausible.io/api/event'
        if (name === 'data-domain') return 'chat.tinfoil.sh'
        return null
      },
      src: 'https://chat.tinfoil.sh/js/plausible.js',
    },
    documentElement: {
      clientHeight: 800,
    },
    hasFocus: () => true,
    referrer,
    visibilityState: 'visible',
  }

  runInNewContext(plausibleScript, {
    URL,
    console,
    document: documentMock,
    fetch: fetchMock,
    location,
    setInterval,
    window: windowMock,
  })

  return {
    fetchMock,
    history: windowMock.history,
    location,
    plausible: windowMock.plausible,
  }
}

describe('Plausible analytics', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it.each([
    ['home with prefilled prompt', 'https://chat.tinfoil.sh/?q=private+prompt'],
    ['home with hash prompt', 'https://chat.tinfoil.sh/#send=cHJpdmF0ZQ=='],
    [
      'new chat with prefilled prompt',
      'https://chat.tinfoil.sh/newchat?q=private',
    ],
    ['shared chat', 'https://chat.tinfoil.sh/share/chat-id#v2:throwaway-key'],
    ['chat root', 'https://chat.tinfoil.sh/chat'],
    ['chat', 'https://chat.tinfoil.sh/chat/chat-id'],
    ['local chat', 'https://chat.tinfoil.sh/chat/local/chat-id'],
    ['project chat', 'https://chat.tinfoil.sh/project/project-id/chat/chat-id'],
  ])('does not send events from %s URLs', (_, url) => {
    const analytics = loadPlausible(url)

    analytics.plausible?.('Chat Viewed')

    expect(analytics.fetchMock).not.toHaveBeenCalled()
  })

  it('stops sending events after navigating to a chat URL', () => {
    const analytics = loadPlausible('https://chat.tinfoil.sh/signin')
    expect(analytics.fetchMock).toHaveBeenCalledTimes(1)

    analytics.location.href = 'https://chat.tinfoil.sh/chat/local/chat-id'
    analytics.location.pathname = '/chat/local/chat-id'
    analytics.history.pushState({}, '', '/chat/local/chat-id')

    expect(analytics.fetchMock).toHaveBeenCalledTimes(1)
  })

  it('continues sending pageviews from non-share routes', () => {
    const analytics = loadPlausible('https://chat.tinfoil.sh/shared')

    expect(analytics.fetchMock).toHaveBeenCalledTimes(1)
    const request = analytics.fetchMock.mock.calls[0][1]
    const body = JSON.parse(String(request.body)) as { u: string }
    expect(body.u).toBe('https://chat.tinfoil.sh/shared')
  })

  it('reports only the origin and path, never the query or hash', () => {
    const analytics = loadPlausible(
      'https://chat.tinfoil.sh/signin?redirect_url=%2F%3Fq%3Dsecret#token',
    )

    expect(analytics.fetchMock).toHaveBeenCalledTimes(1)
    const request = analytics.fetchMock.mock.calls[0][1]
    const body = JSON.parse(String(request.body)) as { u: string }
    expect(body.u).toBe('https://chat.tinfoil.sh/signin')
  })

  it('strips the query and hash from the referrer as well', () => {
    const analytics = loadPlausible(
      'https://chat.tinfoil.sh/signin',
      'https://chat.tinfoil.sh/newchat?q=private+prompt#send=c2VjcmV0',
    )

    const request = analytics.fetchMock.mock.calls[0][1]
    const body = JSON.parse(String(request.body)) as { r: string | null }
    expect(body.r).toBe('https://chat.tinfoil.sh/newchat')
  })
})

describe('Plausible script integrity', () => {
  it('matches the subresource integrity hash declared in _app', () => {
    const app = readFileSync(
      resolve(process.cwd(), 'src/pages/_app.tsx'),
      'utf8',
    )
    const declared = app.match(/integrity="(sha384-[^"]+)"/)?.[1]
    const actual = `sha384-${createHash('sha384').update(plausibleScript).digest('base64')}`
    expect(declared).toBe(actual)
  })
})
