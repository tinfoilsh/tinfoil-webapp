import { API_BASE_URL } from '@/config'
import { ERROR_CODES } from './protocol'
import { HarnessError } from './sse'

interface Credential {
  key: string
  expiresAt: number
}

// This cache belongs to one HarnessClient and never writes browser storage.
export class AnonymousCredentialCache {
  private cached?: Credential
  private pending?: Promise<Credential>
  private readonly lifetime = new AbortController()

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
        code: ERROR_CODES.configuration,
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
            response.status === 429
              ? ERROR_CODES.quotaExhausted
              : ERROR_CODES.upstreamRefused,
          message: 'Unable to obtain anonymous chat access. Please try again.',
        },
        response.status,
      )
    // The harness reports the key's quota; only the key and its expiry are
    // read here.
    const value = await response.json()
    const expiresAt = Date.parse(value?.expires_at)
    if (
      typeof value?.key !== 'string' ||
      !value.key.startsWith('free_') ||
      value.key.length <= 5 ||
      value.key.length > 256 ||
      value.is_free_tier !== true ||
      typeof value.expires_at !== 'string' ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= Date.now()
    )
      throw new HarnessError({
        code: ERROR_CODES.upstreamRefused,
        message: 'Controlplane returned invalid anonymous chat access.',
      })
    this.lifetime.signal.throwIfAborted()
    this.cached = { key: value.key, expiresAt }
    return this.cached
  }
}
