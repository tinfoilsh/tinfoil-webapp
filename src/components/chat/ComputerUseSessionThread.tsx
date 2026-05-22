/**
 * Inline computer-use session — rendered *in the chat scroll* (not a modal) once
 * the user has approved consent. Shows the live agent activity (model notes,
 * actions, screenshot frames) and the final summary, interleaved with the
 * conversation. The discrete frames double as the audit trail.
 *
 * The pairing + consent steps (which need focused interaction) stay in
 * `ComputerUseSessionDialog`; this renders everything from `running` onward.
 */

'use client'

import {
  dataUrl,
  firstImagePart,
  isExecResult,
  perceptionText,
  type LoopEvent,
  type useComputerUseSession,
} from '@/services/computer-use'

type SessionApi = ReturnType<typeof useComputerUseSession>

const STATUS_LABEL: Record<string, string> = {
  running: 'Working…',
  done: 'Done',
  handoff: 'Paused — your turn',
  error: 'Error',
}

export function ComputerUseSessionThread({ session }: { session: SessionApi }) {
  const { state, cancel } = session
  const live =
    state.phase === 'running' ||
    state.phase === 'done' ||
    state.phase === 'handoff' ||
    state.phase === 'error'
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
            {state.phase === 'handoff' && (
              <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-600">
                Paused for you to take over in the sandbox window. Resume from
                the tray when done.
              </p>
            )}
            {state.phase === 'error' && (
              <p className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-500">
                {state.error}
              </p>
            )}
            {state.frames.map((f, i) => (
              <Frame key={i} event={f} />
            ))}
            {state.finalText && (
              <p className="text-sm text-content-primary">{state.finalText}</p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function Frame({ event }: { event: LoopEvent }) {
  if (event.type === 'model_message' && event.content) {
    return <p className="text-sm text-content-secondary">{event.content}</p>
  }
  if (event.type === 'action') {
    return (
      <p className="font-mono text-xs text-content-muted">
        → {event.action.op} {JSON.stringify(event.action.payload)}
      </p>
    )
  }
  if (event.type === 'action_result' || event.type === 'begin') {
    const result = event.type === 'begin' ? event.screenshot : event.result
    const img = firstImagePart(result)
    if (img) {
      return (
        <img
          src={dataUrl(img.data, img.mimeType)}
          alt="agent screen"
          className="w-full rounded-lg border border-border-subtle"
        />
      )
    }
    if (isExecResult(result)) {
      return (
        <pre className="overflow-x-auto rounded-lg bg-surface-chat p-2 text-xs text-content-primary">
          {perceptionText(result) || `exit ${result.exit_code}`}
        </pre>
      )
    }
  }
  if (event.type === 'action_error' || event.type === 'unsupported') {
    const msg = event.type === 'action_error' ? event.message : event.reason
    return <p className="text-xs text-red-500">{msg}</p>
  }
  return null
}
