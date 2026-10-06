interface TokenReadOptions {
  skipCache?: boolean
}

type TokenGetter = (options?: TokenReadOptions) => Promise<string | null>

export class AuthTokenUnavailableError extends Error {
  constructor(
    public readonly reason: 'not-initialized' | 'unavailable',
    options?: ErrorOptions,
  ) {
    super(
      reason === 'not-initialized'
        ? 'Authentication is not initialized'
        : 'Authentication token is unavailable',
      options,
    )
    this.name = 'AuthTokenUnavailableError'
  }
}

export class AuthTokenRefreshError extends Error {
  constructor(options?: ErrorOptions) {
    super('Authentication token refresh failed', options)
    this.name = 'AuthTokenRefreshError'
  }
}

export class AuthTokenManager {
  private getToken: TokenGetter | null = null
  private initialized = false
  private initResolvers: Array<() => void> = []
  private refreshByRejectedToken = new Map<string, Promise<string>>()
  private generation = 0

  /** A null getter represents a confirmed signed-out session, not loading. */
  initialize(getToken: TokenGetter | null) {
    if (this.getToken !== getToken) {
      this.generation++
      this.refreshByRejectedToken.clear()
    }
    this.getToken = getToken
    this.initialized = true
    for (const resolve of this.initResolvers) {
      resolve()
    }
    this.initResolvers = []
  }

  isInitialized(): boolean {
    return this.initialized
  }

  isSignedOut(): boolean {
    return this.initialized && this.getToken === null
  }

  /**
   * Returns a promise that resolves to `true` when `initialize()` is called,
   * or `false` if the timeout expires first.  If already initialized,
   * resolves immediately.
   */
  waitForInit(timeoutMs: number): Promise<boolean> {
    if (this.initialized) return Promise.resolve(true)
    return new Promise((resolve) => {
      let settled = false
      const resolver = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(true)
      }
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        this.initResolvers = this.initResolvers.filter((r) => r !== resolver)
        resolve(false)
      }, timeoutMs)
      this.initResolvers.push(resolver)
    })
  }

  async getValidToken(signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted()
    const getToken = this.getToken
    const generation = this.generation
    if (!getToken) {
      throw new AuthTokenUnavailableError(
        this.initialized ? 'unavailable' : 'not-initialized',
      )
    }
    let token: string | null
    try {
      token = await settleWithAbortSignal(getToken(), signal)
    } catch (error) {
      throw new AuthTokenUnavailableError('unavailable', { cause: error })
    }
    if (generation !== this.generation) {
      throw new AuthTokenUnavailableError('unavailable')
    }
    if (!token) {
      throw new AuthTokenUnavailableError('unavailable')
    }
    return token
  }

  refreshToken(rejectedToken: string): Promise<string> {
    const existing = this.refreshByRejectedToken.get(rejectedToken)
    if (existing) return existing

    const refresh = this.readFreshToken().finally(() => {
      if (this.refreshByRejectedToken.get(rejectedToken) === refresh) {
        this.refreshByRejectedToken.delete(rejectedToken)
      }
    })
    this.refreshByRejectedToken.set(rejectedToken, refresh)
    return refresh
  }

  reset(): void {
    this.generation++
    this.getToken = null
    this.initialized = false
    this.refreshByRejectedToken.clear()
  }

  async getAuthHeaders(signal?: AbortSignal): Promise<Record<string, string>> {
    const token = await this.getValidToken(signal)
    return {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    }
  }

  async isAuthenticated(signal?: AbortSignal): Promise<boolean> {
    try {
      return !!(await this.getValidToken(signal))
    } catch {
      signal?.throwIfAborted()
      return false
    }
  }

  private async readFreshToken(): Promise<string> {
    const getToken = this.getToken
    const generation = this.generation
    if (!getToken) {
      throw new AuthTokenRefreshError({
        cause: new AuthTokenUnavailableError('not-initialized'),
      })
    }

    try {
      const token = await getToken({ skipCache: true })
      if (generation !== this.generation) {
        throw new AuthTokenUnavailableError('unavailable')
      }
      if (!token) {
        throw new AuthTokenUnavailableError('unavailable')
      }
      return token
    } catch (error) {
      throw new AuthTokenRefreshError({ cause: error })
    }
  }
}

function settleWithAbortSignal<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return operation
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    operation.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort)
    })
  })
}

export const authTokenManager = new AuthTokenManager()
