/**
 * Adaptive `/status` poller — the liveness engine behind the connection
 * indicator and conditional tool exposure (architecture → "Liveness UX — no
 * page refresh"). Framework-agnostic so it's unit-testable with fake timers;
 * `use-broker-status.ts` is a thin React binding over it.
 *
 * Cadence: probe fast (~2s) while disconnected so a freshly-installed broker is
 * detected quickly; settle to a slow heartbeat (~20s) once connected. The
 * heartbeat also catches the daemon dying mid-session (a probe starts failing →
 * indicator flips → the next request withdraws the tools). The React layer calls
 * `refresh()` on `visibilitychange` so tabbing back probes immediately.
 */

import {
  brokerReadiness,
  connectionIndicator,
  type BrokerReadiness,
  type ConnectionIndicator,
} from './availability'
import { BrokerError, type BrokerStatus } from './types'

export interface BrokerStatusState {
  status: BrokerStatus | null
  readiness: BrokerReadiness
  indicator: ConnectionIndicator
  /** True while a probe is in flight. */
  probing: boolean
  /** Timestamp (ms) of the last completed probe, or null. */
  lastUpdated: number | null
}

export interface BrokerStatusPollerOptions {
  /** Fetch `/status`; rejects (BrokerError unreachable) when the daemon is absent. */
  getStatus: (signal?: AbortSignal) => Promise<BrokerStatus>
  /** Notified on every state change (probe start, success, failure). */
  onUpdate: (state: BrokerStatusState) => void
  /** Heartbeat cadence once connected. Default 20s. */
  connectedIntervalMs?: number
  /** Base probe cadence while disconnected (catch post-install quickly). Default 2s. */
  disconnectedIntervalMs?: number
  /** Cap for the disconnected backoff (don't hammer localhost forever). Default 30s. */
  maxDisconnectedIntervalMs?: number
  now?: () => number
}

const DEFAULT_CONNECTED_MS = 20_000
const DEFAULT_DISCONNECTED_MS = 2_000
const DEFAULT_MAX_DISCONNECTED_MS = 30_000

export class BrokerStatusPoller {
  private running = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private abort: AbortController | null = null
  /** Consecutive failed probes — drives exponential backoff while disconnected. */
  private failures = 0
  private state: BrokerStatusState = {
    status: null,
    readiness: 'absent',
    indicator: 'disconnected',
    probing: false,
    lastUpdated: null,
  }

  constructor(private readonly opts: BrokerStatusPollerOptions) {}

  getState(): BrokerStatusState {
    return this.state
  }

  /** Begin polling (immediate first probe, then the adaptive cadence). */
  start(): void {
    if (this.running) return
    this.running = true
    this.schedule(0)
  }

  /** Stop polling and abort any in-flight probe. */
  stop(): void {
    this.running = false
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.abort?.abort()
    this.abort = null
  }

  /** Probe now, cancelling any pending scheduled probe (e.g. on visibilitychange). */
  refresh(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    return this.tick()
  }

  private schedule(ms: number): void {
    if (!this.running) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.tick()
    }, ms)
  }

  private emit(patch: Partial<BrokerStatusState>): void {
    this.state = { ...this.state, ...patch }
    this.opts.onUpdate(this.state)
  }

  private async tick(): Promise<void> {
    // Mark probing — but keep the indicator 'connected' if we already had a good
    // status, so the heartbeat doesn't flicker the chip every cycle.
    this.emit({
      probing: true,
      indicator: connectionIndicator(this.state.status, true),
    })

    this.abort?.abort()
    const ac = new AbortController()
    this.abort = ac
    const now = this.opts.now ?? Date.now

    try {
      const status = await this.opts.getStatus(ac.signal)
      if (ac.signal.aborted) return
      this.failures = 0
      this.emit({
        status,
        readiness: brokerReadiness(status),
        indicator: connectionIndicator(status, false),
        probing: false,
        lastUpdated: now(),
      })
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      // Any failure (unreachable, or a non-BrokerError) ⇒ treat as absent.
      void (err as BrokerError)
      this.failures++
      this.emit({
        status: null,
        readiness: 'absent',
        indicator: 'disconnected',
        probing: false,
        lastUpdated: now(),
      })
    } finally {
      if (this.abort === ac) this.abort = null
    }

    this.schedule(this.nextDelay())
  }

  /**
   * Connected → steady heartbeat. Disconnected → exponential backoff from the
   * base cadence up to the cap, so a user who never installs the broker isn't
   * hammering loopback (and spamming the console) every couple seconds forever.
   */
  private nextDelay(): number {
    if (this.state.indicator === 'connected') {
      return this.opts.connectedIntervalMs ?? DEFAULT_CONNECTED_MS
    }
    const base = this.opts.disconnectedIntervalMs ?? DEFAULT_DISCONNECTED_MS
    const max =
      this.opts.maxDisconnectedIntervalMs ?? DEFAULT_MAX_DISCONNECTED_MS
    return Math.min(base * 2 ** Math.max(0, this.failures - 1), max)
  }
}
