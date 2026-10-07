import {
  AuthTokenManager,
  AuthTokenRefreshError,
  AuthTokenUnavailableError,
} from '@/services/auth/auth-token-manager'
import { describe, expect, it, vi } from 'vitest'

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

  it('releases auth waiters when Clerk confirms sign-out', async () => {
    const manager = new AuthTokenManager()
    const initialization = manager.waitForInit(1000)
    manager.initialize(null)

    await expect(initialization).resolves.toBe(true)
    await expect(manager.waitForInit(1000)).resolves.toBe(true)
  })

  it('rejects an in-flight token read after confirmed sign-out', async () => {
    const manager = new AuthTokenManager()
    let resolveToken!: (token: string) => void
    manager.initialize(() => new Promise((resolve) => (resolveToken = resolve)))
    const token = manager.getValidToken()
    manager.initialize(null)
    resolveToken('old-session-token')

    await expect(token).rejects.toBeInstanceOf(AuthTokenUnavailableError)
  })

  it('uses an ordinary Clerk token read by default', async () => {
    const getToken = vi.fn().mockResolvedValue('cached-token')
    const manager = new AuthTokenManager()
    manager.initialize(getToken)

    await expect(manager.getValidToken()).resolves.toBe('cached-token')
    expect(getToken).toHaveBeenCalledWith()
  })

  it('single-flights forced refreshes for the rejected token', async () => {
    let resolveRefresh!: (token: string) => void
    const getToken = vi.fn(
      () => new Promise<string>((resolve) => (resolveRefresh = resolve)),
    )
    const manager = new AuthTokenManager()
    manager.initialize(getToken)

    const first = manager.refreshToken('rejected-token')
    const second = manager.refreshToken('rejected-token')
    expect(first).toBe(second)
    expect(getToken).toHaveBeenCalledOnce()
    expect(getToken).toHaveBeenCalledWith({ skipCache: true })

    resolveRefresh('fresh-token')
    await expect(first).resolves.toBe('fresh-token')
  })

  it('throws typed unavailable and refresh errors', async () => {
    const manager = new AuthTokenManager()
    await expect(manager.getValidToken()).rejects.toBeInstanceOf(
      AuthTokenUnavailableError,
    )

    manager.initialize(vi.fn().mockResolvedValue(null))
    await expect(manager.refreshToken('rejected-token')).rejects.toBeInstanceOf(
      AuthTokenRefreshError,
    )
  })

  it('drops the provider and refresh state on reset', async () => {
    const manager = new AuthTokenManager()
    let resolveOld!: (token: string) => void
    manager.initialize(
      () =>
        new Promise<string>((resolve) => {
          resolveOld = resolve
        }),
    )
    const oldRefresh = manager.refreshToken('rejected-token')
    const oldRejection = expect(oldRefresh).rejects.toBeInstanceOf(
      AuthTokenRefreshError,
    )
    manager.reset()

    expect(manager.isInitialized()).toBe(false)
    await expect(manager.getValidToken()).rejects.toMatchObject({
      reason: 'not-initialized',
    })
    let resolveNew!: (token: string) => void
    const newProvider = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveNew = resolve
        }),
    )
    manager.initialize(newProvider)
    const newRefresh = manager.refreshToken('rejected-token')
    expect(newRefresh).not.toBe(oldRefresh)
    expect(newProvider).toHaveBeenCalledExactlyOnceWith({ skipCache: true })
    resolveOld('old-account-token')
    await oldRejection
    expect(manager.refreshToken('rejected-token')).toBe(newRefresh)
    expect(newProvider).toHaveBeenCalledOnce()
    resolveNew('new-account-token')
    await expect(newRefresh).resolves.toBe('new-account-token')
  })

  it('rejects an in-flight refresh after the account changes', async () => {
    let resolveOldRefresh!: (token: string) => void
    const manager = new AuthTokenManager()
    manager.initialize(
      vi.fn(
        () =>
          new Promise<string>((resolve) => {
            resolveOldRefresh = resolve
          }),
      ),
    )

    const refresh = manager.refreshToken('old-token')
    manager.reset()
    manager.initialize(vi.fn().mockResolvedValue('new-token'))
    resolveOldRefresh('old-account-token')

    await expect(refresh).rejects.toBeInstanceOf(AuthTokenRefreshError)
  })

  it('rejects an in-flight ordinary read after the account changes', async () => {
    let resolveOldRead!: (token: string) => void
    const manager = new AuthTokenManager()
    manager.initialize(
      vi.fn(
        () =>
          new Promise<string>((resolve) => {
            resolveOldRead = resolve
          }),
      ),
    )

    const read = manager.getValidToken()
    manager.reset()
    resolveOldRead('old-account-token')

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
