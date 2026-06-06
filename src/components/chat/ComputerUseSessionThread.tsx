/**
 * Inline computer-use session — rendered in the chat scroll while the run is in
 * flight (`running` or paused for `handoff`). Pairing + consent live in
 * `ComputerUseSessionDialog`; the static post-mortem is in
 * `ComputerUseSessionMessage`.
 *
 * The card never renders screenshots inline. The toolbar exposes the archive
 * via the history popover. The body shows the model's prose, the action ledger,
 * exec output, and any pending capability ask.
 */

'use client'

import { cn } from '@/components/ui/utils'
import {
  imageSize,
  type LoopEvent,
  type useComputerUseSession,
} from '@/services/computer-use'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ComputerUseLiveView, type LiveViewStatus } from './ComputerUseLiveView'
import { collectErrors } from './ComputerUseSessionMessage'
import { ComputerUseSessionToolbar } from './ComputerUseSessionToolbar'
import {
  ComputerUseTerminal,
  type ComputerUseTerminalHandle,
} from './ComputerUseTerminal'

type SessionApi = ReturnType<typeof useComputerUseSession>

export function ComputerUseSessionThread({
  session,
  onStop,
}: {
  session: SessionApi
  /**
   * Red-light handler. The chat passes a commit-then-teardown callback here
   * (snapshot the run into history, THEN end the VM) so the live surface is
   * preserved until the operator explicitly stops. Defaults to a bare
   * `cancel()` — used by the dev harness, which has no chat history to
   * commit into.
   */
  onStop?: () => void
}) {
  const { state, cancel, dispatchExec, pause, resume, getAccessToken } = session
  const stop = onStop ?? cancel
  // The thread stays mounted while a session id exists OR the agent is
  // spinning one up — phase 'running' precedes the first `begin` event that
  // sets `sessionId`, and that gap is the boot window the skeleton fills.
  // The loop's phase tracks what the agent is doing, NOT whether the VM is
  // up; `cancel()` (red traffic light) zeroes `sessionId` and drops phase
  // out of 'running', which is what unmounts the thread. Until then the
  // operator can keep driving via the live view even after the model stops.
  const live = Boolean(state.sessionId) || state.phase === 'running'
  const agentActive = state.phase === 'running' || state.phase === 'handoff'

  // Whether the live view has reported a successful VNC connection on this
  // mount. Latched (only flips on 'connected') so a mid-run disconnect shows
  // the live view's own banner rather than re-raising the booting skeleton.
  // Reset naturally: the thread remounts fresh for each new session.
  const [everConnected, setEverConnected] = useState(false)
  const handleLiveStatus = useCallback((s: LiveViewStatus) => {
    if (s === 'connected') setEverConnected(true)
  }, [])

  const [collapsed, setCollapsed] = useState(false)
  const [expanded, setExpanded] = useState(false)
  // Terminal is hidden by default — the agent activity popover already shows
  // everything; the terminal is opt-in for users who want raw exec output
  // and the interactive prompt.
  const [terminalVisible, setTerminalVisible] = useState(false)
  const terminalRef = useRef<ComputerUseTerminalHandle | null>(null)
  const flushedRef = useRef(0)

  const flushIntoTerminal = useCallback(() => {
    const term = terminalRef.current
    if (!term) return
    for (let i = flushedRef.current; i < state.frames.length; i++) {
      term.appendEvent(state.frames[i])
    }
    flushedRef.current = state.frames.length
  }, [state.frames])

  // New frames just stream in; the effect runs whenever the frames array
  // changes (or the terminal becomes visible, in case it's a late mount).
  useEffect(() => {
    flushIntoTerminal()
  }, [flushIntoTerminal, terminalVisible])

  useEffect(() => {
    flushedRef.current = 0
  }, [state.sessionId])

  const handleExec = useCallback(
    (cmd: string) => dispatchExec(cmd),
    [dispatchExec],
  )

  const handleTogglePause = useCallback(() => {
    if (state.paused) resume()
    else pause()
  }, [state.paused, pause, resume])

  // Keep the booting placeholder up from the moment the agent starts running
  // until the live view actually connects (decoupled from frame count — the
  // first `begin` frame lands a beat before the WS finishes connecting).
  const showSkeleton = state.phase === 'running' && !everConnected

  if (!live) return null

  const errors = collectErrors(state.frames, state.error)

  return (
    <div
      className={cn(
        'relative mx-auto mb-6 flex w-full flex-col items-start',
        // Expanded mode escapes the standard message cap and grows to
        // whatever horizontal room the parent gives us, leaving a 1rem
        // gutter so the rounded card edges stay visible.
        expanded ? 'max-w-[calc(100vw-2rem)]' : 'max-w-3xl',
      )}
    >
      <div className="w-full px-4 py-2">
        <div className="overflow-hidden rounded-2xl border border-border-subtle bg-surface-chat-background">
          <ComputerUseSessionToolbar
            imageName={state.manifest?.session.image}
            imageOS={state.manifest?.session.os}
            vmStatus={
              state.phase === 'error'
                ? 'error'
                : state.paused || state.phase === 'handoff'
                  ? 'paused'
                  : 'running'
            }
            errors={errors}
            frames={state.frames}
            manifest={state.manifest}
            // Red light = explicitly stop the session. Always wired while a
            // session exists — the user owns lifecycle even after the agent
            // has finished. In chat this commits the run into history before
            // tearing the VM down; the dev harness just cancels.
            onClose={stop}
            onMinimize={() => setCollapsed((c) => !c)}
            onExpand={() => setExpanded((e) => !e)}
            expanded={expanded}
            terminalVisible={terminalVisible}
            onToggleTerminal={() => setTerminalVisible((v) => !v)}
            // Play/pause only makes sense while the agent is dispatching
            // (or already user-paused). Done/error get a static dot.
            onTogglePause={
              agentActive || state.paused ? handleTogglePause : undefined
            }
          />

          {!collapsed && (
            <div className="space-y-3 px-3 py-3">
              {state.sessionId ? (
                <div className="relative">
                  <ComputerUseLiveView
                    sessionId={state.sessionId}
                    getAccessToken={getAccessToken}
                    onConnectionStateChange={handleLiveStatus}
                    // When the user starts driving, pause the agent so the
                    // two input streams don't fight. They'll resume the
                    // agent explicitly via the toolbar's play button.
                    onUserTakeover={pause}
                    agentCursor={agentCursorFromFrames(state.frames)}
                    idleTimeout={state.manifest?.session.idle_timeout}
                    activityKey={state.frames.length}
                    vmPaused={state.paused}
                    className={
                      expanded ? 'aspect-[16/10] w-full' : 'aspect-[4/3] w-full'
                    }
                  />
                  {/* Skeleton overlays the (mounted-but-connecting) live view
                      so it can finish its WS handshake underneath, then lifts
                      the moment it reports connected. */}
                  {showSkeleton && <BootingSkeleton overlay />}
                  {/* In-VM prompts overlay the live view so the operator
                      reads them as dialogs about the visible screen
                      rather than as stacked rows that push it down. */}
                  {state.phase === 'handoff' && (
                    <PromptOverlay tone="amber">
                      <p className="text-sm">
                        Paused for you to take over in the sandbox. Resume from
                        the tray when done.
                      </p>
                    </PromptOverlay>
                  )}
                  {state.capabilityRequest && (
                    <PromptOverlay tone="amber" wide>
                      <CapabilityRequestPrompt
                        egress={state.capabilityRequest.egress}
                        onApprove={(edited) =>
                          session.approveCapability(edited)
                        }
                        onDeny={() => session.denyCapability()}
                      />
                    </PromptOverlay>
                  )}
                </div>
              ) : (
                // Boot window: phase 'running' but the first `begin` event
                // hasn't set `sessionId` yet, so there's no live view to mount
                // — the skeleton stands alone until it does.
                showSkeleton && <BootingSkeleton />
              )}
              {terminalVisible && (
                <ComputerUseTerminal
                  ref={terminalRef}
                  onExec={handleExec}
                  // When the terminal mounts late (operator opened it mid
                  // run), the frames that arrived before mount are still
                  // buffered on this thread. Flush them as soon as the
                  // ghostty WASM is initialised.
                  onReady={flushIntoTerminal}
                />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * Placeholder shown while the VM boots and the live view connects. Two modes:
 *
 *   - standalone (`overlay` false): owns the frame slot during the boot window
 *     before `sessionId` exists, sized to mirror the inline frame area so the
 *     card doesn't visibly resize when the live view takes over.
 *   - overlay (`overlay` true): an absolutely-positioned cover over the
 *     already-mounted live view while it finishes its WS handshake, lifted
 *     once the view reports connected.
 *
 * Both keep the pulsing surface + spinner so the loading affordance reads the
 * same in either slot.
 */
function BootingSkeleton({ overlay = false }: { overlay?: boolean }) {
  return (
    <div className={overlay ? 'absolute inset-0' : 'relative'}>
      <div
        className={cn(
          'animate-pulse rounded-lg border border-border-subtle bg-surface-chat',
          overlay ? 'absolute inset-0' : 'aspect-[4/3] w-full',
        )}
      />
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
        <span
          aria-hidden
          className="size-8 animate-spin rounded-full border-2 border-border-subtle border-t-content-primary"
        />
        <p className="text-sm text-content-secondary">
          Booting sandbox — first screenshot in a few seconds…
        </p>
      </div>
    </div>
  )
}

/**
 * Walk the LoopEvent stream backwards to find the agent's most recent
 * input action's (x, y), plus the dimensions of the most recent screenshot
 * we have. The overlay renders relative to that frame so a fit-scaled
 * canvas still places the marker at the same logical pixel.
 *
 * Returns undefined until both a coord-bearing action and a screenshot
 * have arrived — the overlay should not render before then.
 */
function agentCursorFromFrames(
  frames: LoopEvent[],
):
  | { x: number; y: number; frameWidth: number; frameHeight: number }
  | undefined {
  let cursor: { x: number; y: number } | undefined
  let frame: { frameWidth: number; frameHeight: number } | undefined
  for (let i = frames.length - 1; i >= 0; i--) {
    const f = frames[i]
    if (!cursor && f.type === 'action') {
      const p = f.action.payload as { x?: number; y?: number }
      if (typeof p?.x === 'number' && typeof p?.y === 'number') {
        cursor = { x: p.x, y: p.y }
      }
    }
    if (!frame && (f.type === 'begin' || f.type === 'action_result')) {
      const result = f.type === 'begin' ? f.screenshot : f.result
      const content = (result as { content?: Array<{ data?: string }> })
        ?.content
      const img = content?.find((p): p is { data?: string } => Boolean(p?.data))
      if (img?.data) {
        const size = imageSize(img.data)
        if (size) {
          frame = { frameWidth: size.width, frameHeight: size.height }
        }
      }
    }
    if (cursor && frame) break
  }
  if (!cursor || !frame) return undefined
  return { ...cursor, ...frame }
}

/**
 * Translucent dialog laid on top of the live VM view. Used for prompts
 * that are about the sandbox itself (handoff banner, capability ask) so
 * the user reads them as dialogs over the screen rather than as separate
 * boxes that push the canvas down.
 */
function PromptOverlay({
  tone,
  wide,
  children,
}: {
  tone: 'amber'
  wide?: boolean
  children: React.ReactNode
}) {
  const toneCls =
    tone === 'amber'
      ? 'border-amber-500/50 text-amber-100'
      : 'border-white/30 text-white'
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-4">
      <div
        className={cn(
          'pointer-events-auto rounded-xl border px-4 py-3 shadow-xl backdrop-blur',
          toneCls,
          wide ? 'w-full max-w-md' : 'max-w-sm',
        )}
      >
        {children}
      </div>
    </div>
  )
}

function CapabilityRequestPrompt({
  egress,
  onApprove,
  onDeny,
}: {
  egress: string[]
  onApprove: (edited: string[]) => void
  onDeny: () => void
}) {
  const [edited, setEdited] = useState<string[]>(egress)
  return (
    <div className="space-y-2 rounded-lg px-3 py-2">
      <p className="text-sm font-medium text-amber-700 dark:text-amber-300">
        Agent wants additional network access
      </p>
      <p className="text-xs text-content-secondary">
        The model asked to widen the egress allowlist. Approve will replace the
        current allowlist with the list below.
      </p>
      <ul className="space-y-1">
        {edited.map((d, i) => (
          <li key={i} className="flex items-center gap-2">
            <input
              value={d}
              onChange={(e) =>
                setEdited(edited.map((x, j) => (j === i ? e.target.value : x)))
              }
              className="flex-1 rounded-md border border-border-subtle bg-surface-chat px-2 py-1 font-mono text-xs text-content-primary"
            />
            <button
              type="button"
              onClick={() => setEdited(edited.filter((_, j) => j !== i))}
              className="rounded-md px-2 py-0.5 text-xs text-content-secondary hover:text-content-primary"
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
      <div className="flex justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onDeny}
          className="rounded-lg px-3 py-1 text-xs text-content-secondary hover:bg-surface-chat hover:text-content-primary"
        >
          Deny
        </button>
        <button
          type="button"
          onClick={() => onApprove(edited.map((d) => d.trim()).filter(Boolean))}
          disabled={edited.every((d) => !d.trim())}
          className="rounded-lg bg-amber-600 px-3 py-1 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-50"
        >
          Approve
        </button>
      </div>
    </div>
  )
}
