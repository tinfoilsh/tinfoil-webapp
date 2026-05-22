/**
 * Access-token lifecycle for the broker's two-tier (refresh/access) model.
 *
 * The long-lived **refresh credential** (opaque, revocable root, obtained once
 * via pairing) is exchanged for short-lived **access JWTs** the broker mints.
 * This manager caches the current access token, reads its `expires_at`, and
 * re-mints *ahead* of expiry so the action loop never stalls. On a 401 from an
 * action the loop calls `invalidate()` to force a fresh mint on the next call;
 * if minting itself 401s, the refresh credential was revoked and the caller
 * must re-pair (the `BrokerError` propagates with `isAuthError`).
 *
 * The refresh credential is a JS-readable bearer secret (see architecture →
 * threat model): keep it only here, never in URLs/logs.
 */

import { BrokerClient, type BrokerClientOptions } from './broker-client'
import { BrokerError, type TokenResponse } from './types'

/** Mint a token before it gets this close to expiry (ms). */
const REFRESH_SKEW_MS = 30_000

type MintFn = (
  refreshCredential: string,
  signal?: AbortSignal,
) => Promise<TokenResponse>

export class AccessTokenManager {
  private token: string | null = null
  private expiresAtMs = 0
  private inflight: Promise<string> | null = null

  constructor(
    private readonly mint: MintFn,
    private readonly refreshCredential: string,
    /** Injectable clock for tests. */
    private readonly now: () => number = Date.now,
    /**
     * Called when the refresh credential is *rejected* (mint returns 401/403) —
     * the credential is dead, so the owner can clear stored state and re-pair.
     * Fires wherever a token mint happens (session start, begin, mid-loop), so
     * a stale credential is rotated out no matter where the 401 surfaces.
     */
    private readonly onRefreshRejected?: () => void,
  ) {}

  /**
   * Return a valid access token, minting/refreshing if the cached one is
   * missing or within the skew window of expiry. Concurrent callers share one
   * in-flight mint. Throws `BrokerError` if the refresh credential is rejected.
   */
  async getAccessToken(signal?: AbortSignal): Promise<string> {
    if (this.token && this.now() < this.expiresAtMs - REFRESH_SKEW_MS) {
      return this.token
    }
    if (this.inflight) return this.inflight

    this.inflight = (async () => {
      try {
        const res = await this.mint(this.refreshCredential, signal)
        this.token = res.access_token
        this.expiresAtMs = res.expires_at * 1000
        return res.access_token
      } catch (err) {
        // A rejected refresh credential is terminal — the cached token (if any)
        // is also useless once it expires. Surface the auth error to trigger
        // re-pairing upstream.
        if (err instanceof BrokerError && err.isAuthError) {
          this.token = null
          this.expiresAtMs = 0
          this.onRefreshRejected?.()
        }
        throw err
      } finally {
        this.inflight = null
      }
    })()

    return this.inflight
  }

  /** Drop the cached access token (e.g. after a surprise 401 on an action). */
  invalidate(): void {
    this.token = null
    this.expiresAtMs = 0
  }
}

export interface BrokerConnection {
  /** JWT-gated client wired to auto-refresh access tokens. */
  client: BrokerClient
  /** The token manager, exposed so the loop can `invalidate()` on a 401. */
  tokens: AccessTokenManager
}

/**
 * Wire a {@link BrokerClient} together with an {@link AccessTokenManager} so the
 * client transparently attaches a fresh access JWT to consequential calls. The
 * same client instance mints tokens (origin-gated, no JWT needed) and performs
 * JWT-gated actions — there is no recursion because `mintAccessToken` does not
 * consult `getAccessToken`.
 */
export function createBrokerConnection(opts: {
  refreshCredential: string
  baseUrl?: string
  fetchImpl?: BrokerClientOptions['fetchImpl']
  now?: () => number
  /** Invoked when the refresh credential is rejected (clear stored state + re-pair). */
  onRefreshRejected?: () => void
}): BrokerConnection {
  let tokens: AccessTokenManager
  const client = new BrokerClient({
    baseUrl: opts.baseUrl,
    fetchImpl: opts.fetchImpl,
    getAccessToken: () => tokens.getAccessToken(),
  })
  tokens = new AccessTokenManager(
    (refresh, signal) => client.mintAccessToken(refresh, signal),
    opts.refreshCredential,
    opts.now,
    opts.onRefreshRejected,
  )
  return { client, tokens }
}
