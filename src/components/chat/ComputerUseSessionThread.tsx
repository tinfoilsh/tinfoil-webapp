/**
 * Inline computer-use session — rendered *in the chat scroll* (not a modal)
 * while the run is in flight (`running` or paused for `handoff`). The pairing +
 * consent steps stay in `ComputerUseSessionDialog`.
 *
 * On terminal phases (`done` / `error`), chat-interface commits the session's
 * frames + summary as a synthetic assistant message and the
 * `ComputerUseSessionRenderer` takes over the visual — so the run takes its
 * chronological place in history and survives reload. While that handoff is
 * happening this component returns `null` to avoid double-rendering.
 */

'use client'

import { type useComputerUseSession } from '@/services/computer-use'
import { useEffect, useState } from 'react'
import {
  SandboxConfigSummary,
  SessionFrame,
  SessionToolbar,
} from './ComputerUseSessionMessage'

type SessionApi = ReturnType<typeof useComputerUseSession>

const STATUS_LABEL: Record<string, string> = {
  running: 'Working…',
  handoff: 'Paused — your turn',
}

export function ComputerUseSessionThread({ session }: { session: SessionApi }) {
  const { state, cancel } = session
  // Render ONLY while the run is in flight. `done` / `error` are folded into
  // chat history by chat-interface and rendered by `ComputerUseSessionRenderer`.
  const live = state.phase === 'running' || state.phase === 'handoff'

  // Yellow-light minimize: hide the card body, leaving only the toolbar.
  // The toolbar visual is small and unobtrusive, so the user still sees that
  // a session is running but doesn't have its frames in their face.
  const [collapsed, setCollapsed] = useState(false)

  // Keep the booting skeleton on screen for at least ~900ms after entering
  // `running`, even if the first frame arrives almost immediately (warm host /
  // pre-pulled image). Otherwise the placeholder flashes for one paint and the
  // user perceives the card as having "skipped" the loading state.
  const showSkeleton = useBootingSkeletonVisible(
    state.phase === 'running',
    state.frames.length,
  )

  if (!live) return null

  return (
    // Same layout shell as an assistant message (mx-auto, max-w-3xl, left-aligned)
    // so the session reads as an assistant turn in the conversation.
    <div className="relative mx-auto mb-6 flex w-full max-w-3xl flex-col items-start">
      <div className="w-full px-4 py-2">
        <div className="overflow-hidden rounded-2xl border border-border-subtle bg-surface-chat-background">
          <SessionToolbar
            status={STATUS_LABEL[state.phase]}
            pulse={state.phase === 'running'}
            // Red = stop. `cancel()` aborts the in-flight loop AND tears down
            // the session via broker.end() in the loop's finally-block.
            onClose={state.phase === 'running' ? cancel : undefined}
            // Yellow = collapse to just the toolbar.
            onMinimize={() => setCollapsed((c) => !c)}
          />

          {!collapsed && (
            <div className="space-y-3 px-3 py-3">
              {state.manifest && (
                <SandboxConfigSummary manifest={state.manifest} />
              )}
              {state.phase === 'handoff' && (
                <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-600">
                  Paused for you to take over in the sandbox window. Resume from
                  the tray when done.
                </p>
              )}
              {/* Skeleton placeholder while the VM boots: `running` is set as
                  soon as the user approves, but the first frame doesn't arrive
                  until `/begin` returns its screenshot (clone + boot + first
                  capture can be ~10-30s). Without this, the card shows just
                  the header for that whole window, which reads as "stuck".
                  Stays visible for a minimum duration even on warm boots — see
                  useBootingSkeletonVisible. */}
              {showSkeleton && <BootingSkeleton />}
              {/* Only render frames after the skeleton has cleared, otherwise
                  the user momentarily sees the first screenshot stacked under
                  the placeholder during the minimum-display window. */}
              {!showSkeleton &&
                state.frames.map((f, i) => <SessionFrame key={i} event={f} />)}
              {/* Pending capability ask: the loop is paused awaiting user
                  consent. Approve / Deny resolve the promise the loop is
                  sitting on. */}
              {state.capabilityRequest && (
                <CapabilityRequestPrompt
                  egress={state.capabilityRequest.egress}
                  onApprove={(edited) => session.approveCapability(edited)}
                  onDeny={() => session.denyCapability()}
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
 * Placeholder shown while the VM is booting and no screenshot has arrived yet.
 * 4:3 aspect approximates the macOS sandbox display (1024×768 logical) so the
 * card doesn't visibly resize when the real frame replaces it.
 *
 * Visuals: an `animate-pulse` rectangle as the screenshot stand-in, plus a
 * spinning ring + status text centered on top so the user reads the box as
 * "loading" rather than "broken". The spinner is plain Tailwind — no extra
 * dependency.
 */
function BootingSkeleton() {
  return (
    <div className="relative">
      <div className="aspect-[4/3] w-full animate-pulse rounded-lg border border-border-subtle bg-surface-chat" />
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
 * Hook that returns `true` while the booting placeholder should be on screen.
 * The placeholder shows when:
 *   - we're in `running` AND no frames yet, OR
 *   - we've been in `running` for less than ~900ms (the minimum-display window,
 *     for the warm-host case where the first frame arrives in < 1 paint).
 *
 * Hiding happens when BOTH the minimum window has elapsed AND at least one
 * frame has arrived. Resets whenever `running` exits.
 */
function useBootingSkeletonVisible(running: boolean, frameCount: number) {
  const MIN_MS = 900
  // `minimumElapsed` flips false→true after MIN_MS once `running` starts, and
  // resets to false on every transition out of `running`.
  const [minimumElapsed, setMinimumElapsed] = useState(false)
  useEffect(() => {
    // The setState-in-effect is the entire point of this hook: a boolean
    // phase change (running false→true) needs to drive a *delayed* state
    // transition that isn't observable from the inputs alone. There is no
    // pure-derivation alternative for "show this for at least N ms."
    if (!running) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setMinimumElapsed(false)
      return
    }
    setMinimumElapsed(false)
    const id = setTimeout(() => setMinimumElapsed(true), MIN_MS)
    return () => clearTimeout(id)
  }, [running])

  if (!running) return false
  if (!minimumElapsed) return true
  return frameCount === 0
}

/**
 * Inline consent prompt rendered when the model has called `request_capability`
 * and the loop is paused awaiting the user's decision. The user can edit the
 * domain list (e.g. trim something the model overreached on) before approving;
 * the edited list becomes the new egress allowlist.
 */
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
    <div className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2">
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
