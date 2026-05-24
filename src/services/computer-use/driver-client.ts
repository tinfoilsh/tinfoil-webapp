/**
 * Loopback HTTP client for `tinfoil-driver`.
 *
 * Transport is plain HTTP to a known fixed loopback port (127.0.0.1:8765) — no
 * TLS, no WebSocket. `127.0.0.1` is a potentially-trustworthy origin, so an
 * `https://` chat page calling it is not mixed-content-blocked; the browser
 * attaches the `Origin` header automatically (it is a forbidden header we can't
 * and must not set ourselves), which is what the driver's CORS allowlist gates
 * on. Chrome additionally issues a PNA `OPTIONS` preflight; the driver answers
 * `Access-Control-Allow-Private-Network: true` for allowlisted origins, so no
 * action is needed here beyond the page being served from an allowlisted origin.
 *
 * Two gates on the driver side:
 *  - origin-only (no secret): /status, /pair, /pair/status, /token
 *  - origin + access-JWT (Authorization: Bearer): /begin /end /action /handoff /resume
 *
 * This client is deliberately low-level. Token *lifecycle* (refresh→access,
 * proactive renewal) lives in `access-token.ts`; the loop wires the two together.
 */

import {
  DriverError,
  type ActionResult,
  type BeginResponse,
  type CapabilityManifest,
  type DriverAction,
  type DriverStatus,
  type HandoffResponse,
  type PairResponse,
  type PairStatusResponse,
  type TokenResponse,
} from './types'

/** The known fixed port the driver binds (bind-or-fail-loudly). */
export const DEFAULT_DRIVER_ORIGIN = 'http://127.0.0.1:8765'

export interface DriverClientOptions {
  /** Override the driver origin (for a future configurable/remote host). */
  baseUrl?: string
  /** Injectable fetch for testing. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
  /**
   * Supplies a valid access JWT for the consequential (JWT-gated) endpoints.
   * Returns `null` when no token is available (not paired / revoked), which
   * surfaces as an auth error before the request is made.
   */
  getAccessToken?: () => Promise<string | null>
}

export class DriverClient {
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly getAccessToken?: () => Promise<string | null>

  constructor(opts: DriverClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_DRIVER_ORIGIN).replace(/\/$/, '')
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis)
    this.getAccessToken = opts.getAccessToken
  }

  // -- Detection (origin-gated) ---------------------------------------------

  /**
   * `GET /status`. Throws `DriverError(unreachable)` when the daemon is absent,
   * which the caller treats as "driver not installed/running".
   */
  async getStatus(signal?: AbortSignal): Promise<DriverStatus> {
    return this.request<DriverStatus>('GET', '/status', { signal })
  }

  // -- Pairing (origin-gated) -----------------------------------------------

  /** `POST /pair`. Displays-then-confirms: surfaces the request in the tray. */
  async pair(code: string, signal?: AbortSignal): Promise<PairResponse> {
    return this.request<PairResponse>('POST', '/pair', {
      body: { code },
      signal,
    })
  }

  /** `GET /pair/status?id=`. Poll until state leaves `pending`. */
  async pairStatus(
    pairingId: string,
    signal?: AbortSignal,
  ): Promise<PairStatusResponse> {
    return this.request<PairStatusResponse>(
      'GET',
      `/pair/status?id=${encodeURIComponent(pairingId)}`,
      { signal },
    )
  }

  // -- Token exchange (origin-gated; refresh credential is the secret) -------

  /**
   * `POST /token`. Exchanges the long-lived opaque refresh credential for a
   * short-lived access JWT. The refresh credential goes on the Authorization
   * header here (it is the secret), NOT via `getAccessToken`.
   */
  async mintAccessToken(
    refreshCredential: string,
    signal?: AbortSignal,
  ): Promise<TokenResponse> {
    return this.request<TokenResponse>('POST', '/token', {
      bearer: refreshCredential,
      signal,
    })
  }

  // -- Session lifecycle + actions (JWT-gated) ------------------------------

  /** `POST /begin`. Body is the capability manifest; returns session + first frame. */
  async begin(
    manifest: CapabilityManifest,
    signal?: AbortSignal,
  ): Promise<BeginResponse> {
    return this.request<BeginResponse>('POST', '/begin', {
      body: manifest,
      jwt: true,
      signal,
    })
  }

  /** `POST /action`. The consequential path: one normalized curated op. */
  async action(
    session: string,
    action: DriverAction,
    signal?: AbortSignal,
  ): Promise<ActionResult> {
    return this.request<ActionResult>('POST', '/action', {
      body: { session, op: action.op, payload: action.payload },
      jwt: true,
      signal,
    })
  }

  /** `POST /end`. Tears down the session, ephemeral clone, and egress proxy. */
  async end(session: string, signal?: AbortSignal): Promise<void> {
    await this.request<{ ok: boolean }>('POST', '/end', {
      body: { session },
      jwt: true,
      signal,
    })
  }

  /** `POST /handoff`. User-initiated takeover; pauses the agent + feed. */
  async handoff(
    session: string,
    signal?: AbortSignal,
  ): Promise<HandoffResponse> {
    return this.request<HandoffResponse>('POST', '/handoff', {
      body: { session },
      jwt: true,
      signal,
    })
  }

  /** `POST /resume`. Returns control to the agent — a user action only. */
  async resume(
    session: string,
    signal?: AbortSignal,
  ): Promise<HandoffResponse> {
    return this.request<HandoffResponse>('POST', '/resume', {
      body: { session },
      jwt: true,
      signal,
    })
  }

  /**
   * `POST /escalate`. Runtime egress allowlist change — additive (today only).
   * `egress` is the FULL desired set, replacing the current allowlist. Other
   * capability axes (mounts, clipboard, display) can't be live-escalated.
   * The user must approve in the consent UI before this is called.
   */
  async escalate(
    session: string,
    egress: string[],
    signal?: AbortSignal,
  ): Promise<{ egress: string[] }> {
    return this.request<{ egress: string[] }>('POST', '/escalate', {
      body: { session, egress },
      jwt: true,
      signal,
    })
  }

  /**
   * `POST /images/setup-default`. Kicks off the driver-driven first-time image
   * setup (pull default base from CDN + provision autostart/TCC). Returns 202
   * with the chosen image name; the driver runs the work in the background
   * and reflects progress via `/status`'s `setup_job` field, which the chat's
   * `useDriverStatus` poll already surfaces. Idempotent: calling while a setup
   * is in flight returns the in-flight job's image name.
   */
  async setupDefaultImage(signal?: AbortSignal): Promise<{ image: string }> {
    return this.request<{ image: string }>('POST', '/images/setup-default', {
      body: {},
      jwt: true,
      signal,
    })
  }

  // -- internals ------------------------------------------------------------

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    opts: {
      body?: unknown
      /** Use this exact string as the bearer (e.g. the refresh credential). */
      bearer?: string
      /** Resolve and attach the access JWT via `getAccessToken`. */
      jwt?: boolean
      signal?: AbortSignal
    } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {}
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json'

    let bearer = opts.bearer
    if (opts.jwt) {
      const token = this.getAccessToken ? await this.getAccessToken() : null
      if (!token) {
        throw new DriverError(
          'no access token available (not paired or pairing revoked)',
          401,
        )
      }
      bearer = token
    }
    if (bearer) headers['Authorization'] = `Bearer ${bearer}`

    let res: Response
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: opts.signal,
        // No credentials: the bearer is the auth, not cookies.
        credentials: 'omit',
        mode: 'cors',
      })
    } catch (err) {
      // A failed fetch (connection refused, DNS, CORS rejection surfacing as a
      // TypeError) means the daemon is effectively absent for our purposes.
      if (err instanceof DOMException && err.name === 'AbortError') throw err
      throw new DriverError(
        `driver unreachable: ${(err as Error).message}`,
        0,
        true,
      )
    }

    if (!res.ok) {
      throw new DriverError(await readErrorMessage(res), res.status)
    }

    // Some endpoints (e.g. /end) return a tiny body we don't need typed.
    return (await res.json()) as T
  }
}

/** Pull `{ "error": string }` out of a driver error body, falling back to status text. */
async function readErrorMessage(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { error?: string }
    if (data && typeof data.error === 'string' && data.error) return data.error
  } catch {
    // non-JSON body; fall through
  }
  return res.statusText || `HTTP ${res.status}`
}
