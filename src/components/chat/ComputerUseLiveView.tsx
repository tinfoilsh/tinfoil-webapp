/**
 * Embedded live VNC view of the running sandbox VM.
 *
 * The view connects through the driver's `ws://127.0.0.1:8765/vnc?session=…
 * &token=…` bridge (noVNC client) and shows the guest framebuffer in
 * real time. The framebuffer carries the *real* cursor; the agent's
 * intent-cursor overlay rendered on top is added by Phase F.
 *
 * Input semantics:
 *   - `viewOnly = true` (default): the user can watch but not click. The
 *     agent owns input; mouse/keyboard from the browser are ignored.
 *   - `viewOnly = false`: the user drives. Their input flows through the
 *     same VNC pipe the agent will eventually use too (Phase E), so the
 *     guest treats it as genuine HID input — TCC dialogs accept those
 *     clicks, unlike clicks routed through cua-driver-rs's synthetic path.
 *
 * VNC password regenerates every `tart run`, so we re-fetch credentials
 * on each mount. Reconnects are not automatic — if the driver restarts,
 * the WS dies and the component surfaces a state error; the user can
 * re-mount via the toolbar's expand/contract toggle.
 */

'use client'

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/components/ui/utils'
import { DriverClient } from '@/services/computer-use'
import { ClockIcon } from '@heroicons/react/24/outline'
import { useEffect, useRef, useState } from 'react'
import { formatRemaining, useIdleCountdown } from './use-idle-timer'

interface ComputerUseLiveViewProps {
  /** Live session id captured from the loop's `begin` event. */
  sessionId: string
  /** Provides a fresh access JWT each time the view mounts/reconnects. */
  getAccessToken: () => Promise<string | null>
  /** Default driver client baseUrl. Tests inject a custom one. */
  baseUrl?: string
  /**
   * Initial input mode. The agent's typical state is the actor, so the
   * user is view-only by default; clicking the view escalates to driving
   * (matches the "click to take over" pattern in plan-vnc-embed.md).
   */
  viewOnly?: boolean
  /**
   * Fires whenever the user produces input that takes them out of view-only
   * mode (e.g. clicks the canvas to start driving). The parent can use this
   * to surface a "you are driving" banner or to pause the agent loop.
   */
  onUserTakeover?: () => void
  /**
   * Agent cursor position to render as an overlay marker on top of the
   * live framebuffer. Coordinates are in the same pixel space as the
   * VM's framebuffer; the component scales them to the rendered canvas.
   * Omit to hide the overlay (e.g. before the first action).
   */
  agentCursor?: {
    x: number
    y: number
    frameWidth: number
    frameHeight: number
  }
  /**
   * Driver-side idle_timeout (Go duration string). When set, a floating
   * clock chip is rendered in the top-right of the live view; clicking
   * it shows the remaining time before the reaper would fire.
   */
  idleTimeout?: string
  /**
   * Bump on any activity (usually `frames.length`) to reset the
   * countdown. Without this the timer ticks down independently of
   * what's actually happening in the session.
   */
  activityKey?: number
  /** Whether the user has paused dispatch — the reaper holds while paused. */
  vmPaused?: boolean
  /**
   * Called whenever the noVNC connection status changes. The session thread
   * uses this to decide when to lift the booting skeleton: the skeleton stays
   * up until the live view reports `connected`, rather than disappearing the
   * moment the first screenshot frame lands (the WS connect lags the frame by
   * a beat, so frame-count gating flashed an empty "Connecting…" view).
   */
  onConnectionStateChange?: (status: LiveViewStatus) => void
  className?: string
}

interface NoVNCInstance {
  disconnect(): void
  viewOnly: boolean
  scaleViewport: boolean
  resizeSession: boolean
  background: string
  addEventListener: (
    type: string,
    handler: (event: { detail: unknown }) => void,
  ) => void
  removeEventListener: (
    type: string,
    handler: (event: { detail: unknown }) => void,
  ) => void
}

export type LiveViewStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'error'

/**
 * SVG filter id for the red<->blue channel swap applied to the framebuffer
 * canvas (see the comment where it's wired). Module-scoped so the filter is
 * defined once and referenced by `url(#…)`.
 */
const RB_SWAP_FILTER_ID = 'cua-vnc-rb-swap'

export function ComputerUseLiveView({
  sessionId,
  getAccessToken,
  baseUrl,
  viewOnly = true,
  onUserTakeover,
  agentCursor,
  idleTimeout,
  activityKey = 0,
  vmPaused = false,
  onConnectionStateChange,
  className,
}: ComputerUseLiveViewProps) {
  const remaining = useIdleCountdown(idleTimeout, activityKey, vmPaused)
  const containerRef = useRef<HTMLDivElement>(null)
  const rfbRef = useRef<NoVNCInstance | null>(null)
  const [status, setStatus] = useState<LiveViewStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [userDriving, setUserDriving] = useState(!viewOnly)

  // Surface every status transition to the parent so it can gate the booting
  // skeleton on a real connection rather than on the first frame arriving.
  useEffect(() => {
    onConnectionStateChange?.(status)
  }, [status, onConnectionStateChange])

  useEffect(() => {
    if (!containerRef.current) return
    let cancelled = false
    setStatus('connecting')
    setError(null)
    ;(async () => {
      try {
        // Wire the parent's token supplier into the DriverClient so its
        // JWT-gated request path can mint a fresh access token. Without
        // this, the client throws "no access token available" the moment
        // we hit /vnc/credentials — regardless of whether the session is
        // actually paired.
        const client = new DriverClient({
          baseUrl,
          getAccessToken: () => getAccessToken(),
        })
        const token = await getAccessToken()
        if (!token) {
          throw new Error(
            'live view: session has no access token yet — is the driver paired and the session paused on consent?',
          )
        }
        const { password } = await client.getVncCredentials(sessionId)
        if (cancelled) return
        const RFB = (await import('@novnc/novnc')).default
        if (cancelled || !containerRef.current) return
        const wsUrl = client.vncWebSocketUrl(sessionId, token)
        const rfb = new RFB(containerRef.current, wsUrl, {
          credentials: { password },
        }) as unknown as NoVNCInstance
        rfb.viewOnly = !userDriving
        rfb.scaleViewport = true
        rfb.resizeSession = false
        rfb.background = '#0b0e15'
        // Correct Apple Virtualization.framework's swapped colour channels.
        // VF's VNC server emits BGR-ordered pixels and ignores noVNC's
        // SetPixelFormat (which requests RGB); noVNC then blits the bytes as
        // RGB, so red<->blue come out swapped (reds look blue, yellow looks
        // teal). noVNC discards the server's reported channel shifts, so
        // there's no RFB knob for it — we swap the channels back at the
        // display layer, on the framebuffer canvas only. The overlays (agent
        // cursor, status badges, idle chip) are DOM siblings of the canvas,
        // so their colours stay correct. `_connect()` runs synchronously in
        // the RFB constructor, so the canvas is already mounted here.
        const fbCanvas = containerRef.current?.querySelector('canvas')
        if (fbCanvas) fbCanvas.style.filter = `url(#${RB_SWAP_FILTER_ID})`
        const onConnect = () => setStatus('connected')
        const onDisconnect = () => setStatus('disconnected')
        const onSecurityFailure = (e: { detail: unknown }) => {
          const reason =
            (e.detail as { reason?: string } | undefined)?.reason ??
            'security failure'
          setError(reason)
          setStatus('error')
        }
        rfb.addEventListener('connect', onConnect)
        rfb.addEventListener('disconnect', onDisconnect)
        rfb.addEventListener('securityfailure', onSecurityFailure)
        rfbRef.current = rfb
      } catch (e) {
        if (cancelled) return
        setError(e instanceof Error ? e.message : String(e))
        setStatus('error')
      }
    })()
    return () => {
      cancelled = true
      rfbRef.current?.disconnect()
      rfbRef.current = null
    }
    // sessionId / baseUrl swap is a fresh remount; userDriving is applied
    // imperatively below so we don't tear the socket down on a mode flip.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, baseUrl])

  // Apply viewOnly imperatively when the toggle changes so the WS stays up.
  useEffect(() => {
    if (rfbRef.current) rfbRef.current.viewOnly = !userDriving
  }, [userDriving])

  // Pointer-down / key-down inside the surface flips view-only off the first
  // time the user touches the canvas. The "click-to-take-over" affordance.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    if (userDriving) return
    const takeover = () => {
      setUserDriving(true)
      onUserTakeover?.()
    }
    el.addEventListener('pointerdown', takeover)
    el.addEventListener('keydown', takeover)
    return () => {
      el.removeEventListener('pointerdown', takeover)
      el.removeEventListener('keydown', takeover)
    }
  }, [userDriving, onUserTakeover])

  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-lg border border-border-subtle bg-[#0b0e15]',
        className ?? 'aspect-[4/3]',
      )}
    >
      {/* Channel-swap filter referenced by the framebuffer canvas. The matrix
          maps (R,G,B,A) -> (B,G,R,A), undoing VF's BGR pixel order. A pure
          permutation is colour-space invariant, so the sRGB hint is just
          belt-and-suspenders. Defs only — renders nothing visible. */}
      <svg
        aria-hidden
        focusable="false"
        className="pointer-events-none absolute size-0"
      >
        <filter id={RB_SWAP_FILTER_ID} colorInterpolationFilters="sRGB">
          <feColorMatrix
            type="matrix"
            values="0 0 1 0 0 0 1 0 0 0 1 0 0 0 0 0 0 0 1 0"
          />
        </filter>
      </svg>
      <div
        ref={containerRef}
        role="region"
        aria-label="Live VM display"
        // The canvas noVNC injects fills this container; keep relative so the
        // status overlay sits on top.
        className="size-full"
        tabIndex={0}
      />
      {status !== 'connected' && status !== 'error' && (
        <StatusBadge label={statusLabel(status)} kind="muted" />
      )}
      {status === 'error' && (
        <StatusBadge label={error ?? 'connection failed'} kind="error" />
      )}
      {status === 'connected' && !userDriving && <ViewOnlyHint />}
      {agentCursor && status === 'connected' && (
        <AgentCursorOverlay cursor={agentCursor} />
      )}
      {remaining != null && (
        <IdleTimerOverlay remainingMs={remaining} paused={vmPaused} />
      )}
    </div>
  )
}

/**
 * Floating clock chip in the top-right of the live view. Surfaces the
 * driver's idle-reap countdown without taking up toolbar space (where it
 * used to shift layout elements as the digit count changed). Hover/focus
 * exposes a tooltip with the full sentence.
 */
function IdleTimerOverlay({
  remainingMs,
  paused,
}: {
  remainingMs: number
  paused: boolean
}) {
  const label = formatRemaining(remainingMs)
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={cn(
              'absolute right-2 top-2 inline-flex select-none items-center gap-1 rounded-md bg-black/55 px-1.5 py-0.5 text-[11px] text-white shadow',
              !paused && remainingMs < 30_000 && 'text-amber-300',
              !paused && remainingMs < 10_000 && 'text-red-400',
            )}
            aria-label={`Idle reap in ${label}`}
          >
            <ClockIcon className="size-3.5" />
            {label}
          </span>
        </TooltipTrigger>
        <TooltipContent>
          VM reaped after {label} of inactivity
          {paused && ' (held while paused)'}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

/**
 * Decorative cursor + "agent" label rendered on top of the noVNC canvas
 * at the agent's last commanded position. The framebuffer's real cursor
 * (whatever the guest WindowServer draws) is unaffected; this overlay is
 * the user's signal that the visible cursor was *moved by the agent*,
 * distinguishing it from their own pointer when they take over.
 *
 * Coords arrive in framebuffer pixels; we convert to percentages so the
 * marker tracks correctly even when the canvas is fit-scaled by noVNC.
 */
function AgentCursorOverlay({
  cursor,
}: {
  cursor: { x: number; y: number; frameWidth: number; frameHeight: number }
}) {
  if (cursor.frameWidth === 0 || cursor.frameHeight === 0) return null
  const left = (cursor.x / cursor.frameWidth) * 100
  const top = (cursor.y / cursor.frameHeight) * 100
  return (
    <div
      className="pointer-events-none absolute"
      style={{ left: `${left}%`, top: `${top}%` }}
      aria-hidden
    >
      <div className="-translate-x-1/2 -translate-y-1/2">
        <div className="relative">
          <span className="block size-4 -translate-x-2 -translate-y-2 rounded-full border-2 border-white bg-[#ff5733] shadow-[0_0_0_1px_rgba(0,0,0,0.6)]" />
          <span className="absolute left-3 top-3 whitespace-nowrap rounded-md px-1.5 py-0.5 text-[10px] font-medium text-white">
            agent
          </span>
        </div>
      </div>
    </div>
  )
}

function statusLabel(s: LiveViewStatus) {
  switch (s) {
    case 'idle':
      return 'Preparing live view…'
    case 'connecting':
      return 'Connecting to sandbox…'
    case 'disconnected':
      return 'Disconnected — reopen to retry.'
    default:
      return ''
  }
}

function StatusBadge({
  label,
  kind,
}: {
  label: string
  kind: 'muted' | 'error'
}) {
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
      <span
        className={cn(
          'rounded-md px-3 py-1.5 text-xs',
          kind === 'error'
            ? 'bg-red-500/20 text-red-200'
            : 'bg-black/40 text-content-secondary',
        )}
      >
        {label}
      </span>
    </div>
  )
}

function ViewOnlyHint() {
  return (
    <div className="pointer-events-none absolute bottom-2 left-2 rounded-md bg-black/40 px-2 py-1 text-[10px] text-content-secondary">
      View-only · click to drive
    </div>
  )
}
