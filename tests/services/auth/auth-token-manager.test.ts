import {
  AuthTokenManager,
  AuthTokenUnavailableError,
} from '@/services/auth/auth-token-manager'
import { describe, expect, it, vi } from 'vitest'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((finish) => {
    resolve = finish
  })
  return { promise, resolve }
}

describe('AuthTokenManager', () => {
  it('distinguishes a confirmed signed-out session from unresolved auth', async () => {
    const manager = new AuthTokenManager()
    expect(manager.isInitialized()).toBe(false)
    expect(manager.isSignedOut()).toBe(false)

    manager.initialize(null)
    expect(manager.isInitialized()).toBe(true)
    expect(manager.isSignedOut()).toBe(true)
    await expect(manager.getAuthHeaders()).rejects.toMatchObject({
      reason: 'unavailable',
    })

    manager.reset()
    expect(manager.isInitialized()).toBe(false)
    expect(manager.isSignedOut()).toBe(false)
  })

  it('rejects an in-flight token read after confirmed sign-out', async () => {
    const manager = new AuthTokenManager()
    const pendingToken = deferred<string>()
    manager.initialize(() => pendingToken.promise)
    const token = manager.getValidToken()
    manager.initialize(null)
    pendingToken.resolve('old-session-token')

    await expect(token).rejects.toBeInstanceOf(AuthTokenUnavailableError)
  })

  it('rejects an in-flight ordinary read after the account changes', async () => {
    const oldToken = deferred<string>()
    const manager = new AuthTokenManager()
    manager.initialize(vi.fn(() => oldToken.promise))

    const read = manager.getValidToken()
    manager.reset()
    oldToken.resolve('old-account-token')

    await expect(read).rejects.toBeInstanceOf(AuthTokenUnavailableError)
  })

  it('cancels a hanging authentication read with the caller signal', async () => {
    const manager = new AuthTokenManager()
    manager.initialize(vi.fn(() => new Promise<string | null>(() => {})))
    const controller = new AbortController()

    const authenticated = manager.isAuthenticated(controller.signal)
    controller.abort()

    await expect(authenticated).rejects.toMatchObject({ name: 'AbortError' })
  })
})
