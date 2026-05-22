/**
 * Static, history-resident render of a finished computer-use session.
 *
 * Shape parity with `ComputerUseSessionThread.tsx` (the live, in-flight version)
 * is intentional: the live thread renders during `running`/`handoff`, and once
 * the session reaches a terminal phase (`done` / `error`), chat-interface
 * commits a synthetic `assistant` message carrying the frames + (optionally) an
 * error string. That message picks the `ComputerUseSessionRenderer` below, and
 * the user sees the same visual block they were watching live — but now sitting
 * at the chronological position in chat history and persisted across reload.
 *
 * Frame renderers are shared via `SessionFrame`. The sandbox config the run was
 * approved with is rendered via `SandboxConfigSummary` so the user can always
 * see what privileges this run was granted, including in the persisted history.
 */

'use client'

import {
  dataUrl,
  firstImagePart,
  isExecResult,
  perceptionText,
  type CapabilityManifest,
  type GuestOS,
  type LoopEvent,
} from '@/services/computer-use'
import { FaApple, FaLinux } from 'react-icons/fa'

/**
 * Render one loop event the way the live thread does: model prose, action
 * call summary, screenshot image, exec output, or error line.
 *
 * Exported so the live thread (`ComputerUseSessionThread`) and the static
 * history renderer share an identical visual.
 */
export function SessionFrame({ event }: { event: LoopEvent }) {
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
  if (event.type === 'capability_request') {
    return (
      <p className="font-mono text-xs text-content-muted">
        → request_capability {JSON.stringify({ egress: event.egress })}
      </p>
    )
  }
  if (event.type === 'capability_result') {
    return (
      <p
        className={
          event.approved
            ? 'text-xs text-content-secondary'
            : 'text-xs text-red-500'
        }
      >
        {event.approved
          ? `✓ Egress widened: ${event.egress?.join(', ')}`
          : `✗ Capability denied${event.reason ? `: ${event.reason}` : ''}`}
      </p>
    )
  }
  return null
}

/**
 * Static card matching the live `ComputerUseSessionThread` shell, used by the
 * `ComputerUseSessionRenderer` to render a finished/errored session embedded
 * as a regular chat message. `error` switches the header label and shows the
 * error banner; otherwise renders the frame audit trail + (optional) final
 * summary the model produced.
 */
export function ComputerUseSessionCard({
  frames,
  finalText,
  error,
  manifest,
}: {
  frames: LoopEvent[]
  finalText?: string
  error?: string
  /** Sandbox configuration the run was approved with; hidden when absent. */
  manifest?: CapabilityManifest
}) {
  const isError = Boolean(error)
  return (
    <div className="relative mx-auto mb-6 flex w-full max-w-3xl flex-col items-start">
      <div className="w-full px-4 py-2">
        <div className="overflow-hidden rounded-2xl border border-border-subtle bg-surface-chat-background">
          <div className="flex items-center justify-between border-b border-border-subtle px-3 py-2">
            <span className="flex items-center gap-2 text-xs font-medium text-content-secondary">
              <span className="text-content-primary">Computer use</span>
              <span className="text-content-muted">
                · {isError ? 'Error' : 'Done'}
              </span>
            </span>
          </div>
          <div className="space-y-3 px-3 py-3">
            {manifest && <SandboxConfigSummary manifest={manifest} />}
            {isError && (
              <p className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-500">
                {error}
              </p>
            )}
            {frames.map((f, i) => (
              <SessionFrame key={i} event={f} />
            ))}
            {finalText && (
              <p className="text-sm text-content-primary">{finalText}</p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * Compact, collapsible read-only summary of the capability manifest the run
 * was approved with — image (with OS icon), ephemeral/persistent, windowed/
 * headless, idle timeout, mount table, egress allowlist. Default-open so the
 * user can see what was granted at a glance.
 */
function ConfigRow({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <>
      <dt className="text-content-muted">{label}</dt>
      <dd className="text-content-primary">{children}</dd>
    </>
  )
}

export function SandboxConfigSummary({
  manifest,
}: {
  manifest: CapabilityManifest
}) {
  const { session, mounts, network } = manifest
  const egress = network?.egress ?? []
  return (
    <details
      open
      className="rounded-lg border border-border-subtle bg-surface-chat px-3 py-2 text-xs"
    >
      <summary className="cursor-pointer select-none font-medium text-content-secondary">
        Sandbox config
      </summary>
      <dl className="mt-2 grid grid-cols-[max-content_1fr] items-baseline gap-x-3 gap-y-1">
        <ConfigRow label="Image">
          <span className="inline-flex items-center gap-1.5">
            <span className="font-mono">{session.image}</span>
            <OSBadge os={session.os} />
          </span>
        </ConfigRow>
        <ConfigRow label="Lifetime">
          {session.clone === false
            ? 'persistent (in-place)'
            : 'ephemeral clone'}
        </ConfigRow>
        <ConfigRow label="Display">
          {session.headless === false ? 'windowed (for takeover)' : 'headless'}
        </ConfigRow>
        {session.idle_timeout ? (
          <ConfigRow label="Idle timeout">{session.idle_timeout}</ConfigRow>
        ) : null}
        <ConfigRow label="Mounts">
          {mounts && mounts.length > 0 ? (
            <ul className="space-y-0.5">
              {mounts.map((m, i) => (
                <li key={i} className="font-mono">
                  {m.src} → {m.dst}{' '}
                  <span className="text-content-muted">({m.mode})</span>
                </li>
              ))}
            </ul>
          ) : (
            <span className="text-content-muted">none</span>
          )}
        </ConfigRow>
        <ConfigRow label="Egress">
          {egress.length > 0 ? (
            <ul className="space-y-0.5">
              {egress.map((d, i) => (
                <li key={i} className="font-mono">
                  {d}
                </li>
              ))}
            </ul>
          ) : (
            <span className="text-content-muted">sealed (no network)</span>
          )}
        </ConfigRow>
      </dl>
    </details>
  )
}

/** Apple / Linux platform glyph; used both in the consent dialog and here. */
export function OSBadge({ os }: { os: GuestOS }) {
  const Icon = os === 'mac' ? FaApple : FaLinux
  return (
    <span
      className="text-content-muted"
      role="img"
      aria-label={os === 'mac' ? 'macOS' : 'Linux'}
      title={os === 'mac' ? 'macOS' : 'Linux'}
    >
      <Icon size={12} />
    </span>
  )
}
