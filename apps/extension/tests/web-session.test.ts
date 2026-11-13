import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { sessionToken, watchWebSession } from '../src/web-session'

type CookieListener = Parameters<typeof chrome.cookies.onChanged.addListener>[0]
const listeners = new Set<CookieListener>()
const dispose: (() => void)[] = []
const FRONTEND = 'https://clerk.example.com'

function held<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function cookie(name: string, domain = '.clerk.example.com') {
  const event: chrome.cookies.CookieChangeInfo = {
    removed: false,
    cause: 'explicit',
    cookie: {
      name,
      domain,
      value: 'fixture',
      path: '/',
      secure: true,
      httpOnly: true,
      hostOnly: !domain.startsWith('.'),
      session: true,
      sameSite: 'no_restriction',
      storeId: '0',
    },
  }
  for (const listener of listeners) listener(event)
}

beforeEach(() => {
  listeners.clear()
  vi.stubGlobal('chrome', {
    cookies: {
      onChanged: {
        addListener: (listener: CookieListener) => listeners.add(listener),
        removeListener: (listener: CookieListener) =>
          listeners.delete(listener),
      },
    },
  })
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
})
afterEach(() => {
  for (const stop of dispose.splice(0)) stop()
})

test('a website account change waits for an older reload and then reads the new account', async () => {
  let websiteAccount = 'alice'
  let panelAccount = 'signed-out'
  const firstStarted = held<void>()
  const firstResponse = held<void>()
  const bobSeen = held<void>()
  const reads: string[] = []
  const sync = watchWebSession(
    FRONTEND,
    async () => {
      const account = websiteAccount
      reads.push(account)
      if (account === 'alice') {
        firstStarted.resolve()
        await firstResponse.promise
      }
      panelAccount = account
    },
    (error) => {
      expect(error).toBeNull()
      if (panelAccount === 'bob') bobSeen.resolve()
    },
  )
  dispose.push(sync.dispose)
  cookie('__client')
  await firstStarted.promise
  websiteAccount = 'bob'
  cookie('__client_uat_instance', '.example.com')
  expect(panelAccount).toBe('signed-out')
  expect(reads).toEqual(['alice'])
  firstResponse.resolve()
  await bobSeen.promise
  expect(reads).toEqual(['alice', 'bob'])
  expect(panelAccount).toBe('bob')
})

test('only the configured host auth cookies and visible panel events refresh the session', async () => {
  const reload = vi.fn(async () => {})
  const reported = vi.fn()
  const sync = watchWebSession(FRONTEND, reload, reported)
  dispose.push(sync.dispose)
  cookie('__client', '.clerk.example.com.attacker.test')
  cookie('__client', 'example.com')
  cookie('__session')
  await sync.refresh()
  expect(reload).toHaveBeenCalledTimes(1)
  expect(reported).toHaveBeenLastCalledWith(null)
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  document.dispatchEvent(new Event('visibilitychange'))
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  document.dispatchEvent(new Event('visibilitychange'))
  window.dispatchEvent(new Event('focus'))
  await sync.refresh()
  expect(reload).toHaveBeenCalledTimes(2)
  sync.dispose()
  cookie('__client')
  window.dispatchEvent(new Event('focus'))
  document.dispatchEvent(new Event('visibilitychange'))
  await sync.refresh()
  expect(reload).toHaveBeenCalledTimes(2)
})

test('a failed reload can recover and closing the panel drops queued work and late results', async () => {
  const failure = new TypeError('Offline')
  const response = held<void>()
  const started = held<void>()
  const reload = vi
    .fn()
    .mockRejectedValueOnce(failure)
    .mockResolvedValueOnce(undefined)
    .mockImplementation(async () => {
      started.resolve()
      await response.promise
    })
  const reported = vi.fn()
  const sync = watchWebSession(FRONTEND, reload, reported)
  dispose.push(sync.dispose)
  await sync.refresh()
  await sync.refresh()
  expect(reported.mock.calls).toEqual([[failure], [null]])
  const pending = sync.refresh()
  await started.promise
  const queued = sync.refresh()
  sync.dispose()
  response.resolve()
  await Promise.all([pending, queued])
  expect(reload).toHaveBeenCalledTimes(3)
  expect(reported.mock.calls).toEqual([[failure], [null]])
})

function signedIn(owner = 'alice', id = 'session-alice') {
  return {
    user: { id: owner },
    session: {
      id,
      user: { id: owner },
      getToken: vi.fn(async () => 'token-alice'),
    },
  }
}
type ClerkState = Parameters<typeof sessionToken>[0]

test('refreshing the same session resource does not invalidate an in-flight token', async () => {
  const clerk = signedIn()
  const response = held<string>()
  clerk.session.getToken.mockReturnValue(response.promise)
  const pending = sessionToken(clerk as unknown as ClerkState, 'alice')
  clerk.session = signedIn().session
  response.resolve('token-alice')
  expect(await pending).toBe('token-alice')
})

test.each(['owner', 'session'])(
  'an in-flight token is rejected after the %s changes',
  async (change) => {
    const clerk = signedIn()
    const response = held<string>()
    clerk.session.getToken.mockReturnValue(response.promise)
    const pending = sessionToken(clerk as unknown as ClerkState, 'alice').catch(
      (error) => error,
    )
    if (change === 'owner') clerk.user = { id: 'bob' }
    else clerk.session = signedIn('alice', 'another-session').session
    response.resolve('token-alice')
    expect(await pending).toEqual(new Error('The signed-in account changed.'))
  },
)

test('a token is not requested for a different account', async () => {
  const clerk = signedIn('bob', 'session-bob')
  await expect(
    sessionToken(clerk as unknown as ClerkState, 'alice'),
  ).rejects.toThrow('signed-in account changed')
  expect(clerk.session.getToken).not.toHaveBeenCalled()
})
