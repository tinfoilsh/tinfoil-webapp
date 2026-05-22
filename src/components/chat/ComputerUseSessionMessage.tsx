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

// ---------------------------------------------------------------------------
// SessionToolbar — macOS-style window-chrome header shared by the live thread
// and the history card. Three circular controls on the left (close / minimize /
// maximize) match the visual macOS users expect; status text + the pulsing dot
// sit to the right.
//
// Behaviors per circle:
//   • Red    → onClose (live: cancel + tear down VM; history: disabled)
//   • Yellow → onMinimize (live: collapse card body to just the toolbar)
//   • Green  → reserved (future "open live view" / "maximize"); no handler.
//
// Hover affordances follow macOS: the ×/−/+ glyphs only show on hover of the
// control group. When `disabled` is true the lights render at half opacity and
// no glyphs appear — used by the history card where there's nothing to stop.
// ---------------------------------------------------------------------------

interface SessionToolbarProps {
  /** Right-aligned status text, e.g. "Working…" or "Done". */
  status: string
  /** Show a pulsing green dot next to the status (live "running" only). */
  pulse?: boolean
  /** Click handler for the red light. Omit/disable to render non-interactive. */
  onClose?: () => void
  /** Click handler for the yellow light. */
  onMinimize?: () => void
  /**
   * When true, lights render at half opacity and don't react to hover/click.
   * Used by the history card (the session is over — nothing to stop/collapse).
   */
  disabled?: boolean
}

export function SessionToolbar({
  status,
  pulse,
  onClose,
  onMinimize,
  disabled,
}: SessionToolbarProps) {
  return (
    <div
      className={
        'group/lights flex items-center justify-between border-b border-border-subtle px-3 py-2'
      }
    >
      <div className="flex items-center gap-1.5">
        <TrafficLight
          color="red"
          symbol="×"
          onClick={onClose}
          disabled={disabled}
          aria-label="Stop session"
        />
        <TrafficLight
          color="yellow"
          symbol="−"
          onClick={onMinimize}
          disabled={disabled}
          aria-label="Minimize session card"
        />
        {/* Green: reserved for a future "open live view" / maximize. Render
            the circle for visual parity, but don't wire a handler today. */}
        <TrafficLight
          color="green"
          symbol="+"
          disabled
          aria-label="Maximize (reserved)"
        />
      </div>
      <span className="flex items-center gap-2 text-xs font-medium text-content-secondary">
        <span className="text-content-primary">Computer use</span>
        <span className="text-content-muted">· {status}</span>
        {pulse && (
          <span className="inline-block size-2 animate-pulse rounded-full bg-green-500" />
        )}
      </span>
    </div>
  )
}

/**
 * One macOS-style traffic-light dot. The `×`/`−`/`+` glyph is only visible
 * when the parent `.group/lights` is hovered (the whole light cluster reveals
 * symbols together, matching macOS). Non-interactive when `disabled` (lower
 * opacity, no cursor, no symbol on hover).
 */
function TrafficLight({
  color,
  symbol,
  onClick,
  disabled,
  'aria-label': ariaLabel,
}: {
  color: 'red' | 'yellow' | 'green'
  symbol: string
  onClick?: () => void
  disabled?: boolean
  'aria-label': string
}) {
  const palette = {
    red: 'bg-[#ff5f57] text-black/70',
    yellow: 'bg-[#febc2e] text-black/70',
    green: 'bg-[#28c840] text-black/70',
  }[color]
  const interactive = !disabled && Boolean(onClick)
  return (
    <button
      type="button"
      onClick={interactive ? onClick : undefined}
      disabled={!interactive}
      aria-label={ariaLabel}
      className={`relative inline-flex size-3 items-center justify-center rounded-full ${palette} ${
        interactive
          ? 'cursor-pointer hover:brightness-95'
          : 'cursor-default opacity-50'
      }`}
    >
      {interactive && (
        <span
          aria-hidden
          className="pointer-events-none text-[10px] font-bold leading-none opacity-0 group-hover/lights:opacity-100"
        >
          {symbol}
        </span>
      )}
    </button>
  )
}

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
 * error banner; otherwise renders the frame audit trail (the model's final
 * answer lives in its own assistant message right after — see the commit
 * effect in chat-interface.tsx).
 */
export function ComputerUseSessionCard({
  frames,
  error,
  manifest,
}: {
  frames: LoopEvent[]
  error?: string
  /** Sandbox configuration the run was approved with; hidden when absent. */
  manifest?: CapabilityManifest
}) {
  const isError = Boolean(error)
  return (
    <div className="relative mx-auto mb-6 flex w-full max-w-3xl flex-col items-start">
      <div className="w-full px-4 py-2">
        <div className="overflow-hidden rounded-2xl border border-border-subtle bg-surface-chat-background">
          {/* History card: the session is done, so the lights are decorative
              (disabled). The user can no longer stop or collapse it. */}
          <SessionToolbar status={isError ? 'Error' : 'Done'} disabled />
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
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * Compact, collapsible read-only summary of the capability manifest the run
 * was approved with — image (with OS icon), ephemeral/persistent, windowed/
 * headless, idle timeout, mount table, egress allowlist. Default-collapsed
 * to keep the session card visually quiet; users click to expand.
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
    <details className="rounded-lg border border-border-subtle bg-surface-chat px-3 py-2 text-xs">
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
