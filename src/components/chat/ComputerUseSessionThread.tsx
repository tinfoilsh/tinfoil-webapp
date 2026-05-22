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
import { useState } from 'react'
import { SandboxConfigSummary, SessionFrame } from './ComputerUseSessionMessage'

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
  if (!live) return null

  return (
    // Same layout shell as an assistant message (mx-auto, max-w-3xl, left-aligned)
    // so the session reads as an assistant turn in the conversation.
    <div className="relative mx-auto mb-6 flex w-full max-w-3xl flex-col items-start">
      <div className="w-full px-4 py-2">
        <div className="overflow-hidden rounded-2xl border border-border-subtle bg-surface-chat-background">
          <div className="flex items-center justify-between border-b border-border-subtle px-3 py-2">
            <span className="flex items-center gap-2 text-xs font-medium text-content-secondary">
              <span className="text-content-primary">Computer use</span>
              <span className="text-content-muted">
                · {STATUS_LABEL[state.phase]}
              </span>
              {state.phase === 'running' && (
                <span className="inline-block size-2 animate-pulse rounded-full bg-green-500" />
              )}
            </span>
            {state.phase === 'running' && (
              <button
                type="button"
                onClick={cancel}
                className="rounded-md px-2 py-0.5 text-xs text-content-secondary hover:bg-surface-chat hover:text-content-primary"
              >
                Stop
              </button>
            )}
          </div>

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
                capture can be ~10-30s). Without this, the card shows just the
                header for that whole window, which reads as "stuck". */}
            {state.phase === 'running' && state.frames.length === 0 && (
              <BootingSkeleton />
            )}
            {state.frames.map((f, i) => (
              <SessionFrame key={i} event={f} />
            ))}
            {/* Pending capability ask: the loop is paused awaiting user consent.
                Approve / Deny resolve the promise the loop is sitting on. */}
            {state.capabilityRequest && (
              <CapabilityRequestPrompt
                egress={state.capabilityRequest.egress}
                onApprove={(edited) => session.approveCapability(edited)}
                onDeny={() => session.denyCapability()}
              />
            )}
            {state.finalText && (
              <p className="text-sm text-content-primary">{state.finalText}</p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * Placeholder shown while the VM is booting and no screenshot has arrived yet.
 * 4:3 aspect approximates the macOS sandbox display (1024×768 logical) so the
 * card doesn't visibly resize when the real frame replaces it. Uses Tailwind
 * `animate-pulse` for a subtle shimmer.
 */
function BootingSkeleton() {
  return (
    <div className="space-y-2">
      <div className="aspect-[4/3] w-full animate-pulse rounded-lg border border-border-subtle bg-surface-chat" />
      <p className="text-center text-xs text-content-muted">
        Booting sandbox — first screenshot in a few seconds…
      </p>
    </div>
  )
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
