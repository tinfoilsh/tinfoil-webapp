/**
 * Popovers anchored to the session toolbar icons: errors (bug), agent
 * activity (robot), and sandbox config (cog).
 *
 * The error popover auto-opens whenever a new error arrives and stays open
 * until the user dismisses it; further errors then re-pop. The activity
 * popover renders a compact ledger — small thumbnails for screenshots
 * that open the full image on click, an inline scrollable transcript for
 * each exec, and a single line for everything else. The config popover
 * shrinks to fit the content it renders.
 */

'use client'

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { cn } from '@/components/ui/utils'
import {
  dataUrl,
  firstImagePart,
  isExecResult,
  perceptionText,
  type CapabilityManifest,
  type LoopEvent,
} from '@/services/computer-use'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { OSBadge } from './ComputerUseOSBadge'
import { ScreenshotAlbum } from './ScreenshotAlbum'

export interface SessionError {
  /** Stable key for dedup + auto-pop tracking; usually the call id or "fatal". */
  id: string
  /** Origin of the error, used as a small header inside the popover row. */
  source: 'fatal' | 'action_error' | 'unsupported'
  message: string
  /** Optional curated op the error applied to (action_error / unsupported). */
  op?: string
}

interface ErrorPopoverProps {
  errors: SessionError[]
  children: ReactNode
}

export function ErrorPopover({ errors, children }: ErrorPopoverProps) {
  const [open, setOpen] = useState(false)
  const dismissed = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (errors.length === 0) return
    const fresh = errors.some((e) => !dismissed.current.has(e.id))
    if (fresh) setOpen(true)
  }, [errors])
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) for (const e of errors) dismissed.current.add(e.id)
      }}
    >
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        className="w-auto min-w-[16rem] max-w-[min(22rem,calc(100vw-1rem))]"
        collisionPadding={12}
      >
        <p className="mb-2 text-xs font-medium text-content-secondary">
          {errors.length === 1
            ? '1 error this session'
            : `${errors.length} errors this session`}
        </p>
        <ul className="max-h-64 space-y-2 overflow-y-auto pr-1">
          {errors.map((e) => (
            <li
              key={e.id}
              className="rounded-md border border-red-500/30 bg-red-500/5 px-2 py-1.5 text-xs"
            >
              <p className="text-[10px] uppercase tracking-wide text-red-500">
                {errorSourceLabel(e)}
              </p>
              <p className="mt-1 break-words text-content-primary">
                {e.message}
              </p>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
}

function errorSourceLabel(e: SessionError): string {
  if (e.source === 'fatal') return 'Fatal error'
  if (e.source === 'unsupported')
    return `Unsupported${e.op ? ` · ${e.op}` : ''}`
  return `Action error${e.op ? ` · ${e.op}` : ''}`
}

interface AgentHistoryPopoverProps {
  frames: LoopEvent[]
  children: ReactNode
}

export function AgentHistoryPopover({
  frames,
  children,
}: AgentHistoryPopoverProps) {
  const entries = collectHistory(frames)
  // Build the album the lightbox navigates: just the entries that have a
  // screenshot, in chronological order. Indexed so the prev/next arrows
  // know where they are.
  const album = entries
    .map((e, originalIndex) => ({ e, originalIndex }))
    .filter(({ e }) => Boolean(e.imageSrc))
  const [zoomIndex, setZoomIndex] = useState<number | null>(null)
  const onOpenZoom = (originalIndex: number) => {
    const albumIdx = album.findIndex((a) => a.originalIndex === originalIndex)
    setZoomIndex(albumIdx >= 0 ? albumIdx : 0)
  }
  return (
    <>
      <Popover>
        <PopoverTrigger asChild>{children}</PopoverTrigger>
        <PopoverContent
          align="center"
          collisionPadding={12}
          className="flex w-[28rem] max-w-[min(28rem,calc(100vw-1rem))] flex-col"
          // Use Radix's measured "available height" so the popover never
          // grows past the viewport (the inner ol scrolls). Without this
          // a long activity log can extend off-screen on small viewports
          // even with collisionPadding flipping the side.
          style={{
            maxHeight: 'var(--radix-popover-content-available-height, 80vh)',
          }}
        >
          <div className="mb-2 flex shrink-0 items-baseline justify-between">
            <p className="text-xs font-medium text-content-secondary">
              Agent activity
            </p>
            <p className="text-[10px] text-content-muted">
              {entries.length === 0
                ? 'nothing yet'
                : `${entries.length} event${entries.length === 1 ? '' : 's'}`}
            </p>
          </div>
          {entries.length === 0 ? (
            <p className="rounded-md border border-dashed border-border-subtle bg-surface-chat px-3 py-4 text-center text-xs text-content-muted">
              The agent&apos;s first action will appear here.
            </p>
          ) : (
            <ol className="min-h-0 flex-1 divide-y divide-border-subtle overflow-y-auto pr-1">
              {entries.map((e, i) => (
                <HistoryRow key={i} entry={e} onZoom={() => onOpenZoom(i)} />
              ))}
            </ol>
          )}
        </PopoverContent>
      </Popover>
      {zoomIndex !== null && album[zoomIndex] && (
        <ScreenshotAlbum
          album={album.map((a) => ({
            src: a.e.imageSrc!,
            caption: a.e.summary,
          }))}
          index={zoomIndex}
          onIndexChange={setZoomIndex}
          onClose={() => setZoomIndex(null)}
        />
      )}
    </>
  )
}

interface HistoryEntry {
  kind:
    | 'screenshot'
    | 'exec'
    | 'action'
    | 'model_message'
    | 'capability'
    | 'handoff'
    | 'error'
  callId?: string
  /** One-line summary; renders left-aligned in the row. */
  summary: string
  imageSrc?: string
  execText?: string
  execExitCode?: number
}

/**
 * Map every LoopEvent into a row the popover renders. We surface
 * everything the loop emits (clicks, types, screenshots, prose,
 * capability events, errors, handoff) so the agent activity log is the
 * full audit trail. The only events skipped here are ones that don't
 * carry a renderable surface: empty `model_message` content and the
 * terminal `stopped` lifecycle event.
 */
function collectHistory(frames: LoopEvent[]): HistoryEntry[] {
  const out: HistoryEntry[] = []
  for (const f of frames) {
    switch (f.type) {
      case 'begin': {
        const img = firstImagePart(f.screenshot)
        if (img) {
          out.push({
            kind: 'screenshot',
            summary: 'initial screen',
            imageSrc: dataUrl(img.data, img.mimeType),
          })
        }
        break
      }
      case 'model_message':
        if (f.content && f.content.trim()) {
          out.push({ kind: 'model_message', summary: f.content.trim() })
        }
        break
      case 'action':
        out.push({
          kind: 'action',
          callId: f.callId,
          summary: actionSummary(f.action),
        })
        break
      case 'action_result':
        if (isExecResult(f.result)) {
          out.push({
            kind: 'exec',
            callId: f.callId,
            summary: execSummary(f.action),
            execText: perceptionText(f.result),
            execExitCode: f.result.exit_code,
          })
        } else {
          const img = firstImagePart(f.result)
          if (img) {
            out.push({
              kind: 'screenshot',
              callId: f.callId,
              summary: `after ${f.action.op}`,
              imageSrc: dataUrl(img.data, img.mimeType),
            })
          }
          // Non-image, non-exec results (rare: AX-query payloads) are
          // suppressed — they have no useful inline visual.
        }
        break
      case 'action_error':
        out.push({
          kind: 'error',
          callId: f.callId,
          summary: `${f.action.op}: ${f.message}`,
        })
        break
      case 'unsupported':
        out.push({ kind: 'error', summary: `unsupported: ${f.reason}` })
        break
      case 'capability_request':
        out.push({
          kind: 'capability',
          summary: `requested egress: ${f.egress.join(', ')}`,
        })
        break
      case 'capability_result':
        out.push({
          kind: 'capability',
          summary: f.approved
            ? `egress widened: ${f.egress?.join(', ')}`
            : `egress denied${f.reason ? `: ${f.reason}` : ''}`,
        })
        break
      case 'handoff':
        out.push({ kind: 'handoff', summary: 'paused for user takeover' })
        break
      // `stopped` (terminal lifecycle event) carries no operator-visible
      // surface — `phase: done` already conveys the same.
    }
  }
  return out
}

function actionSummary(action: { op: string; payload: unknown }): string {
  const p = action.payload as Record<string, unknown> | undefined
  if (!p) return action.op
  // Pretty-print the verb plus the bits operators actually care about,
  // rather than `JSON.stringify` which renders pid/element_index noise.
  const op = action.op
  if (op === 'click' && typeof p.x === 'number' && typeof p.y === 'number') {
    const btn = typeof p.button === 'string' ? ` (${p.button})` : ''
    const dbl = p.double ? ' double' : ''
    return `click${dbl} (${p.x}, ${p.y})${btn}`
  }
  if (op === 'type' && typeof p.text === 'string') {
    const t = p.text.length > 64 ? p.text.slice(0, 61) + '…' : p.text
    return `type "${t}"`
  }
  if (op === 'key' && Array.isArray(p.keys)) {
    return `key ${p.keys.join('+')}`
  }
  if (
    op === 'scroll' &&
    typeof p.scroll_y === 'number' &&
    (p.x !== undefined || p.y !== undefined)
  ) {
    return `scroll ${p.scroll_y > 0 ? 'down' : 'up'} at (${p.x ?? '?'}, ${p.y ?? '?'})`
  }
  if (op === 'launch_app' && (p.name || p.bundle_id)) {
    return `launch ${p.name ?? p.bundle_id}`
  }
  if (op === 'exec' && typeof p.cmd === 'string') {
    return `$ ${p.cmd}`
  }
  return op
}

function execSummary(action: { op: string; payload: unknown }): string {
  const p = action.payload as { cmd?: string } | undefined
  return p?.cmd ?? action.op
}

function HistoryRow({
  entry,
  onZoom,
}: {
  entry: HistoryEntry
  onZoom: () => void
}) {
  const lead =
    entry.kind === 'error'
      ? 'text-red-500'
      : entry.kind === 'capability' || entry.kind === 'handoff'
        ? 'text-amber-500'
        : entry.kind === 'model_message'
          ? 'text-content-primary'
          : entry.kind === 'action'
            ? 'font-mono text-content-muted'
            : 'text-content-secondary'
  return (
    <li className="flex items-start gap-3 py-2 text-xs">
      {entry.imageSrc && (
        <button
          type="button"
          onClick={onZoom}
          aria-label="View full screenshot"
          className="block size-16 shrink-0 overflow-hidden rounded border border-border-subtle bg-surface-chat-background hover:border-content-primary/30"
        >
          <img src={entry.imageSrc} alt="" className="size-full object-cover" />
        </button>
      )}
      <div className="min-w-0 flex-1 space-y-1">
        <p
          className={cn(
            'break-words',
            lead,
            entry.kind === 'exec' && 'font-mono',
          )}
        >
          {entry.kind === 'exec' && (
            <span className="text-content-muted">$ </span>
          )}
          {entry.summary}
        </p>
        {entry.kind === 'exec' && (
          <pre className="max-h-24 overflow-auto rounded bg-surface-chat-background px-2 py-1 text-[11px] text-content-primary">
            {(entry.execText ?? '').trim() || `exit ${entry.execExitCode ?? 0}`}
          </pre>
        )}
      </div>
    </li>
  )
}

interface ConfigPopoverProps {
  manifest: CapabilityManifest
  children: ReactNode
}

export function ConfigPopover({ manifest, children }: ConfigPopoverProps) {
  const { session, mounts, network } = manifest
  const egress = network?.egress ?? []
  return (
    <Popover>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        align="center"
        className="w-auto min-w-[14rem] max-w-[min(20rem,calc(100vw-1rem))]"
        collisionPadding={12}
      >
        <p className="mb-2 text-xs font-medium text-content-secondary">
          Sandbox config
        </p>
        <dl className="grid grid-cols-[max-content_1fr] items-baseline gap-x-3 gap-y-1.5 text-xs">
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
            {session.headless === false
              ? 'windowed (for takeover)'
              : 'headless'}
          </ConfigRow>
          {session.idle_timeout && (
            <ConfigRow label="Idle timeout">{session.idle_timeout}</ConfigRow>
          )}
          <ConfigRow label="Mounts">
            {mounts && mounts.length > 0 ? (
              <ul className="space-y-0.5">
                {mounts.map((m, i) => (
                  <li key={i} className="break-all font-mono">
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
            {egress.length === 0 ? (
              <span className="text-content-muted">sealed (no network)</span>
            ) : egress.includes('*') ? (
              <span className="text-amber-500">any (allow-all)</span>
            ) : (
              <ul className="space-y-0.5">
                {egress.map((d, i) => (
                  <li key={i} className="break-all font-mono">
                    {d}
                  </li>
                ))}
              </ul>
            )}
          </ConfigRow>
        </dl>
      </PopoverContent>
    </Popover>
  )
}

function ConfigRow({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return (
    <>
      <dt className="text-content-muted">{label}</dt>
      <dd className="text-content-primary">{children}</dd>
    </>
  )
}
