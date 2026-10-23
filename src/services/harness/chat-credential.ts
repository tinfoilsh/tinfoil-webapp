import { API_BASE_URL } from '@/config'
import { ERROR_CODES } from './protocol'
import { HarnessError } from './sse'
import type { RateLimit, TokenBudget } from './types'

// Chat access is minted again once it has less than this left, so a reply
// started with it can finish first.
const RENEW_BEFORE_EXPIRY_MS = 5 * 60_000
const MINT_TIMEOUT_MS = 15_000
// The control plane's answers that decide what an account's access is.
const SUBSCRIPTION_REQUIRED_STATUS = 402
const FORBIDDEN_STATUS = 403
const TOO_MANY_REQUESTS_STATUS = 429
const UNAVAILABLE_STATUS = 503
const SERVER_ERROR_STATUS = 500
const HOURLY_LIMIT_CODE = 'HOURLY_LIMIT_REACHED'
const ACCOUNT_PROVISIONING_CODE = 'ACCOUNT_PROVISIONING'
const MS_PER_SECOND = 1000

interface Credential {
  key: string
  expiresAt: number
  kind: 'hourly' | 'free_daily'
}

type Value = Record<string, unknown>
const obj = (value: unknown): Value =>
  value && typeof value === 'object' ? (value as Value) : {}
const str = (value: unknown) => (typeof value === 'string' ? value : '')
const num = (value: unknown) => (typeof value === 'number' ? value : undefined)

function budget(
  max: unknown,
  used: unknown,
  remaining: unknown,
): TokenBudget | undefined {
  const [m, u, r] = [num(max), num(used), num(remaining)]
  return m && m > 0 && u !== undefined && r !== undefined
    ? { max: m, used: u, remaining: r }
    : undefined
}

// The quota a control plane answer reports, in the form the harness reports
// a free key's. A missing or zero maximum leaves that dimension unlimited.
function rateLimitOf(value: unknown, kind: 'hourly' | 'free_daily'): RateLimit {
  const raw = obj(value)
  const limit: RateLimit = { kind }
  const maxRequests = num(raw.max_requests)
  const remaining = num(raw.remaining)
  if (maxRequests && maxRequests > 0 && remaining !== undefined)
    Object.assign(limit, { maxRequests, remaining })
  const input = budget(
    raw.max_input_tokens,
    raw.input_tokens_used,
    raw.input_tokens_remaining,
  )
  const output = budget(
    raw.max_output_tokens,
    raw.output_tokens_used,
    raw.output_tokens_remaining,
  )
  if (input) limit.inputTokens = input
  if (output) limit.outputTokens = output
  if (str(raw.resets_at)) limit.resetsAt = str(raw.resets_at)
  return limit
}

// The chat access a signed-in account's harness requests carry: a
// subscriber's chat token, or the account's free key. The browser mints it
// from the control plane, as each account's own client, and the harness
// verifies it.
export class ChatCredentialCache {
  private cached?: Credential
  private pending?: Promise<Credential>
  private generation = 0
  // A refusal that names when to ask again is kept until then, so an account
  // at its hourly cap does not ask with every request.
  private refused?: { error: HarnessError; until: number }
  private readonly lifetime = new AbortController()

  constructor(private readonly onRateLimit: (rateLimit: RateLimit) => void) {}

  async get(
    session: string,
    signal?: AbortSignal,
    refresh = false,
  ): Promise<string> {
    this.lifetime.signal.throwIfAborted()
    signal?.throwIfAborted()
    if (
      !refresh &&
      this.cached &&
      this.cached.expiresAt - RENEW_BEFORE_EXPIRY_MS > Date.now()
    )
      return this.cached.key
    if (this.refused && this.refused.until > Date.now()) {
      const held = this.usableAfterFailure(this.refused.error)
      if (held && !refresh) return held
      throw this.refused.error
    }
    if (!this.pending) {
      const pending = this.mint(session, this.generation).finally(() => {
        if (this.pending === pending) this.pending = undefined
      })
      this.pending = pending
    }
    const pending = this.pending
    let onAbort: (() => void) | undefined
    try {
      if (!signal) return (await pending).key
      const credential = await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          onAbort = () => reject(signal.reason)
          signal.addEventListener('abort', onAbort, { once: true })
        }),
      ])
      signal.throwIfAborted()
      return credential.key
    } catch (cause) {
      this.lifetime.signal.throwIfAborted()
      signal?.throwIfAborted()
      const held = this.usableAfterFailure(cause)
      if (held && !refresh) return held
      throw cause
    } finally {
      if (onAbort) signal?.removeEventListener('abort', onAbort)
    }
  }

  private usableAfterFailure(cause: unknown): string | undefined {
    const transient =
      cause instanceof TypeError ||
      (cause instanceof DOMException && cause.name === 'TimeoutError') ||
      (cause instanceof HarnessError &&
        (cause.status === undefined ||
          cause.status >= SERVER_ERROR_STATUS ||
          cause.code === ERROR_CODES.rateLimited))
    return transient && this.cached && this.cached.expiresAt > Date.now()
      ? this.cached.key
      : undefined
  }

  private invalidatePending() {
    this.generation++
    this.pending = undefined
    this.refused = undefined
  }

  renew(session: string, signal?: AbortSignal) {
    this.invalidatePending()
    return this.get(session, signal, true)
  }

  // Forgets the access and any refusal, as when the harness refused the
  // access or the account's subscription changed.
  reset() {
    this.cached = undefined
    this.invalidatePending()
  }

  dispose() {
    this.lifetime.abort()
    this.reset()
  }

  private request(path: string, session: string) {
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
    return fetch(new URL(path, base), {
      method: 'GET',
      headers: { Authorization: `Bearer ${session}` },
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      signal: AbortSignal.any([
        this.lifetime.signal,
        AbortSignal.timeout(MINT_TIMEOUT_MS),
      ]),
    })
  }

  private checkGeneration(generation: number) {
    this.lifetime.signal.throwIfAborted()
    if (generation !== this.generation)
      throw new DOMException('Chat access was superseded', 'AbortError')
  }

  private async mint(session: string, generation: number): Promise<Credential> {
    let response = await this.request('/api/chat/token', session)
    this.checkGeneration(generation)
    let kind: 'hourly' | 'free_daily' = 'hourly'
    // Only a missing subscription falls back to the free key: a capped or
    // suspended subscriber must not be downgraded around its limit.
    if (response.status === SUBSCRIPTION_REQUIRED_STATUS) {
      if (this.cached?.kind === 'hourly') this.cached = undefined
      await response.body?.cancel()
      response = await this.request('/api/keys/chat', session)
      kind = 'free_daily'
    }
    const value = obj(await response.json().catch(() => null))
    this.checkGeneration(generation)
    if (!response.ok) throw this.refuse(response, value)
    const expiresAt = Date.parse(str(value.expires_at))
    if (
      !str(value.key) ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= Date.now()
    )
      throw new HarnessError({
        code: ERROR_CODES.upstreamRefused,
        message: 'Tinfoil returned invalid chat access. Please try again.',
      })
    this.onRateLimit(
      value.rate_limit ? rateLimitOf(value.rate_limit, kind) : { kind: null },
    )
    this.refused = undefined
    this.cached = { key: str(value.key), expiresAt, kind }
    return this.cached
  }

  // The refusal a control plane answer means, kept until it says to retry.
  private refuse(response: Response, value: Value): HarnessError {
    const seconds = Number(response.headers.get('Retry-After'))
    const retryAfter =
      Number.isFinite(seconds) && seconds > 0 ? seconds : undefined
    let error: HarnessError
    let until = retryAfter ? Date.now() + retryAfter * MS_PER_SECOND : 0
    if (
      response.status === TOO_MANY_REQUESTS_STATUS &&
      str(value.code) === HOURLY_LIMIT_CODE
    ) {
      const resetsAt =
        str(value.resets_at) || str(obj(value.rate_limit).resets_at)
      const rateLimit: RateLimit = {
        ...rateLimitOf(value.rate_limit, 'hourly'),
        maxRequests: 0,
        remaining: 0,
        ...(resetsAt ? { resetsAt } : {}),
      }
      this.onRateLimit(rateLimit)
      error = new HarnessError(
        {
          code: ERROR_CODES.quotaExhausted,
          message:
            str(value.error) || 'You have reached your hourly usage limit.',
          kind: 'hourly',
          resetsAt,
          retryAfter,
          rateLimit,
        },
        response.status,
      )
      until = Date.parse(resetsAt) || until
    } else if (response.status === TOO_MANY_REQUESTS_STATUS) {
      error = new HarnessError(
        {
          code: ERROR_CODES.rateLimited,
          message: 'Chat access is busy. Please try again shortly.',
          retryAfter,
        },
        response.status,
      )
    } else if (response.status === FORBIDDEN_STATUS) {
      error = new HarnessError(
        {
          code: ERROR_CODES.upstreamRefused,
          message: 'This account is suspended.',
        },
        response.status,
      )
    } else if (response.status === UNAVAILABLE_STATUS) {
      error = new HarnessError(
        {
          code: ERROR_CODES.upstreamRefused,
          message:
            str(value.code) === ACCOUNT_PROVISIONING_CODE
              ? 'Your account is still being set up. Please try again shortly.'
              : 'Chat access is temporarily unavailable. Please try again shortly.',
          retryAfter,
        },
        response.status,
      )
    } else {
      error = new HarnessError(
        {
          code: ERROR_CODES.upstreamRefused,
          message: 'Unable to obtain chat access. Please try again.',
          status: response.status,
        },
        response.status,
      )
    }
    if (
      response.status === FORBIDDEN_STATUS ||
      error.code === ERROR_CODES.quotaExhausted
    )
      this.cached = undefined
    if (until > Date.now()) this.refused = { error, until }
    return error
  }
}
