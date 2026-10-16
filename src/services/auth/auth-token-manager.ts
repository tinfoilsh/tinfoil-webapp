type TokenGetter = () => Promise<string | null>

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

export class AuthTokenManager {
  private getToken: TokenGetter | null = null
  private initialized = false
  private generation = 0

  /** A null getter represents a confirmed signed-out session, not loading. */
  initialize(getToken: TokenGetter | null) {
    if (this.getToken !== getToken) {
      this.generation++
    }
    this.getToken = getToken
    this.initialized = true
  }

  isSignedOut(): boolean {
    return this.initialized && this.getToken === null
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

  reset(): void {
    this.generation++
    this.getToken = null
    this.initialized = false
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
