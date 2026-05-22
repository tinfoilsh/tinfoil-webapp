/**
 * Type definitions for the confidential computer-use feature.
 *
 * These mirror the `tinfoil-broker` HTTP contract (see
 * `~/dev/tinfoil/tinfoil-broker/internal/{loopback,manifest,session}`) and the
 * cua-driver result shapes the broker passes through. The broker is the
 * authoritative validator — these types are the browser's view of the wire
 * format, not a second source of truth.
 */

// ---------------------------------------------------------------------------
// Detection / status (origin-gated, no secret)
// ---------------------------------------------------------------------------

export type GuestOS = 'mac' | 'linux'

/** One sandbox image reported by `GET /status`. */
export interface BrokerImage {
  name: string
  os: GuestOS
  ready: boolean
  last_setup?: string
}

/**
 * In-progress (or recently-finished) broker-driven default-image setup. The
 * broker runs the pull + provision in a background goroutine; the snapshot is
 * pinned to `setup_job` on `/status` so the chat's existing poll picks it up
 * for the inline progress UI. Once the job hits a terminal state (`done` /
 * `error`), the broker holds the snapshot ~30s so the next poll sees the
 * outcome, then clears the field.
 */
export interface BrokerSetupJob {
  /** `pulling` | `provisioning` | `done` | `error`. */
  state: 'pulling' | 'provisioning' | 'done' | 'error'
  /** Local image name the setup is creating (e.g. `tinfoil-default`). */
  image: string
  /** Optional one-line progress detail. Pure UI; no parse contract. */
  message?: string
  /**
   * Fractional progress in [0, 1] when known. Omitted (or 0 via JSON
   * omitempty) when the current phase doesn't report percent — e.g. the
   * "Resolving manifest" sub-step before `tart pull` knows the byte total,
   * or the `provisioning` phase which is non-percentized. Treat `undefined`
   * as "indeterminate" (render a spinner instead of a bar).
   */
  progress?: number
  /** Final error string on `state === 'error'`. */
  error?: string
}

/** `GET /status` response — drives conditional tool exposure + the indicator. */
export interface BrokerStatus {
  installed: boolean
  running: boolean
  version: string
  images: BrokerImage[]
  /** Snapshot of an active default-image setup, if any. */
  setup_job?: BrokerSetupJob
}

// ---------------------------------------------------------------------------
// Pairing + token (two-tier refresh/access model)
// ---------------------------------------------------------------------------

/** `POST /pair` response. */
export interface PairResponse {
  pairing_id: string
  code: string
}

export type PairState = 'pending' | 'denied' | 'approved' | 'consumed'

/**
 * `GET /pair/status?id=` response. `refresh_credential` is present exactly once,
 * on the first read after approval (`state === 'approved'`); a second read
 * returns `state: 'consumed'` with no credential.
 */
export interface PairStatusResponse {
  state: PairState
  refresh_credential?: string
}

/** `POST /token` response — a short-lived HS256 access JWT. */
export interface TokenResponse {
  /** HS256 JWT to put on `Authorization: Bearer` for the consequential path. */
  access_token: string
  /** Unix seconds. Read this to refresh proactively before expiry. */
  expires_at: number
  /** Seconds until expiry (convenience mirror of `expires_at`). */
  expires_in: number
}

// ---------------------------------------------------------------------------
// Capability manifest (the `computer_begin` parameter shape)
// ---------------------------------------------------------------------------

export type MountMode = 'ro' | 'rw'

export interface ManifestMount {
  src: string
  dst: string
  mode: MountMode
}

export interface ManifestNetwork {
  /** Default-deny domain allowlist enforced by the egress proxy. */
  egress?: string[]
  /** Additional guest ports to surface to the host. The control channel is not ingress. */
  ingress?: number[]
}

export interface ManifestSession {
  os: GuestOS
  /** Must be a real, ready image name from `/status` `images[]`. */
  image: string
  /** Ephemeral fork (recommended). */
  clone?: boolean
  /**
   * Omit for the default (no host window, non-disruptive). Set `false` only to
   * keep a window for seamless mid-task takeover (~20% WindowServer CPU cost).
   */
  headless?: boolean
  /** Go duration string, e.g. "15m". */
  idle_timeout?: string
}

export interface ManifestDevices {
  clipboard?: boolean
}

export interface ManifestDisplay {
  width?: number
  height?: number
  scale?: number
}

/**
 * The capability manifest. Default-deny: an empty manifest (beyond the required
 * `session`) yields a fully sealed VM. The broker re-validates server-side.
 */
export interface CapabilityManifest {
  version: 1
  /** Optional command run once at session start. */
  entrypoint?: string[]
  session: ManifestSession
  mounts?: ManifestMount[]
  network?: ManifestNetwork
  devices?: ManifestDevices
  display?: ManifestDisplay
}

// ---------------------------------------------------------------------------
// Action results (what `/action` and `/begin.screenshot` return)
// ---------------------------------------------------------------------------

export interface ImageContentPart {
  type: 'image'
  /** base64-encoded PNG/JPEG (no data: prefix). */
  data: string
  mimeType: string
}

export interface TextContentPart {
  type: 'text'
  text: string
}

export type ContentPart = ImageContentPart | TextContentPart

/**
 * MCP-style result for perception ops (`screenshot`, and click/type/etc. that
 * capture). The image is the model's view; the text is the on-screen window +
 * AX element summary.
 */
export interface PerceptionResult {
  content: ContentPart[]
  isError?: boolean
}

/** Result for the `exec` op. */
export interface ExecResult {
  stdout: string
  stderr: string
  exit_code: number
}

/** Anything `/action` can return on the happy path. */
export type ActionResult = PerceptionResult | ExecResult

export function isPerceptionResult(r: ActionResult): r is PerceptionResult {
  return Array.isArray((r as PerceptionResult).content)
}

export function isExecResult(r: ActionResult): r is ExecResult {
  return typeof (r as ExecResult).exit_code === 'number'
}

/** First image part of a perception result, if any. */
export function firstImagePart(r: ActionResult): ImageContentPart | undefined {
  if (!isPerceptionResult(r)) return undefined
  return r.content.find((p): p is ImageContentPart => p.type === 'image')
}

/** Concatenated text parts of a perception result. */
export function perceptionText(r: ActionResult): string {
  if (!isPerceptionResult(r)) return ''
  return r.content
    .filter((p): p is TextContentPart => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

/** `POST /begin` response. */
export interface BeginResponse {
  session: string
  screenshot: ActionResult
}

export type HandoffMode = 'agent_active' | 'user_active'

/** Shape of `/handoff`, `/resume`, and a `request_handoff` action result. */
export interface HandoffResponse {
  handoff: HandoffMode
  /** Present on takeover: whether the session has a window the user can drive. */
  driveable?: boolean
  message?: string
}

// ---------------------------------------------------------------------------
// Canonical broker action (post-normalization)
// ---------------------------------------------------------------------------

/**
 * The curated op vocabulary the broker accepts on `/action`. `request_handoff`
 * is the model's yield-at-a-login-wall escape hatch (not gated). Everything
 * else outside this set is rejected server-side.
 *
 * Note: `request_capability` is NOT routed through `/action` — the loop
 * intercepts it client-side, asks the user, and calls `/escalate` on approve.
 * It lives in this union so the adapter can normalize the action shape.
 */
export type BrokerOp =
  | 'screenshot'
  | 'click'
  | 'type'
  | 'key'
  | 'scroll'
  | 'launch_app'
  | 'exec'
  | 'request_handoff'
  | 'request_capability'

/** A normalized action ready to POST to `/action`. */
export interface BrokerAction {
  op: BrokerOp
  payload: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Maps to the broker's `{ "error": string }` body and HTTP status codes. */
export class BrokerError extends Error {
  constructor(
    message: string,
    /** HTTP status; 0 when the fetch itself failed (broker absent). */
    readonly status: number,
    /** True when the daemon could not be reached at all. */
    readonly unreachable = false,
  ) {
    super(message)
    this.name = 'BrokerError'
  }

  /** 401/403 — the access token or origin was rejected. */
  get isAuthError(): boolean {
    return this.status === 401 || this.status === 403
  }
}
