import { API_BASE_URL } from '@/config'
import { HarnessError } from './sse'
import type { RateLimit } from './types'

interface Credential {
  key: string
  expiresAt: number
  rateLimit: RateLimit
}

// This cache belongs to one HarnessClient and never writes browser storage.
export class AnonymousCredentialCache {
  private cached?: Credential
  private pending?: Promise<Credential>
  private readonly lifetime = new AbortController()

  get rateLimit() {
    return this.cached?.rateLimit
  }

  async get(signal?: AbortSignal): Promise<string> {
    this.lifetime.signal.throwIfAborted()
    signal?.throwIfAborted()
    if (this.cached && this.cached.expiresAt > Date.now())
      return this.cached.key
    if (!this.pending)
      this.pending = this.issue().finally(() => {
        this.pending = undefined
      })
    const pending = this.pending
    if (!signal) return (await pending).key
    let onAbort!: () => void
    try {
      const credential = await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          onAbort = () => reject(signal.reason)
          signal.addEventListener('abort', onAbort, { once: true })
        }),
      ])
      signal.throwIfAborted()
      return credential.key
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }

  reject(key: string) {
    if (this.cached?.key === key) this.cached = undefined
  }

  invalidate() {
    if (this.cached) this.cached.expiresAt = 0
  }

  exhausted() {
    if (this.cached)
      this.cached.rateLimit = { ...this.cached.rateLimit, remaining: 0 }
  }

  dispose() {
    this.lifetime.abort()
    this.cached = undefined
  }

  private async issue(): Promise<Credential> {
    const base = new URL(API_BASE_URL || 'https://api.tinfoil.sh')
    if (
      base.protocol !== 'https:' ||
      base.username ||
      base.password ||
      base.pathname !== '/' ||
      base.search ||
      base.hash
    )
      throw new HarnessError({
        code: 'CONFIGURATION',
        message: 'Configure an HTTPS origin for the controlplane.',
      })
    // Controlplane is public HTTPS, not an enclave. Calling it from the
    // browser preserves its existing IP-based anonymous key issuance.
    const response = await fetch(new URL('/api/keys/chat', base), {
      method: 'GET',
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      signal: AbortSignal.any([
        this.lifetime.signal,
        AbortSignal.timeout(15_000),
      ]),
    })
    if (!response.ok)
      throw new HarnessError(
        {
          code:
            response.status === 429 ? 'QUOTA_EXHAUSTED' : 'UPSTREAM_REFUSED',
          message: 'Unable to obtain anonymous chat access. Please try again.',
        },
        response.status,
      )
    const value = await response.json()
    const expiresAt = Date.parse(value?.expires_at)
    const rate = value?.rate_limit
    if (
      typeof value?.key !== 'string' ||
      !value.key.startsWith('free_') ||
      value.key.length <= 5 ||
      value.key.length > 256 ||
      value.is_free_tier !== true ||
      typeof value.expires_at !== 'string' ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= Date.now() ||
      !Number.isSafeInteger(rate?.max_requests) ||
      rate.max_requests < 0 ||
      !Number.isSafeInteger(rate?.remaining) ||
      rate.remaining < 0 ||
      rate.remaining > rate.max_requests ||
      typeof rate?.resets_at !== 'string' ||
      !Number.isFinite(Date.parse(rate.resets_at))
    )
      throw new HarnessError({
        code: 'UPSTREAM_REFUSED',
        message: 'Controlplane returned invalid anonymous chat access.',
      })
    this.lifetime.signal.throwIfAborted()
    this.cached = {
      key: value.key,
      expiresAt,
      rateLimit: {
        kind: 'free_daily',
        maxRequests: rate.max_requests,
        remaining: rate.remaining,
        resetsAt: rate.resets_at,
      },
    }
    return this.cached
  }
}
