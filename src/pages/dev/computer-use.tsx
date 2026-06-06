/**
 * Developer-only preview page for the computer-use card.
 *
 * One unified form drives the whole flow: model + task + sandbox config
 * (image, headless flag, idle timeout, egress allowlist) → "Start
 * session". Consent is auto-approved with whatever the form last
 * specified, so the dev path is a single click from idle → running.
 *
 * The session card stays mounted across all terminal phases so the
 * operator can keep inspecting frames + screenshots after the model
 * finishes. An error boundary wraps the live thread so a 400 from
 * inference (or any other async bubble-up) surfaces as a reset-able
 * banner instead of unmounting the page.
 *
 * Reach it at /dev/computer-use. Not linked from the main UI.
 */

'use client'

import { ComputerUsePairingCard } from '@/components/chat/ComputerUsePairingCard'
import { ComputerUseSessionThread } from '@/components/chat/ComputerUseSessionThread'
import {
  useComputerUseSession,
  useDriverStatus,
  type CapabilityManifest,
} from '@/services/computer-use'
import { Component, useEffect, useMemo, useState, type ReactNode } from 'react'

const DEFAULT_MODEL = 'kimi-k2-6'
const DEFAULT_TASK = 'Open Safari and navigate to example.com.'

export default function ComputerUsePreviewPage() {
  const [modelName, setModelName] = useState(DEFAULT_MODEL)
  const [task, setTask] = useState(DEFAULT_TASK)
  // The operator's explicit image pick. `null` means "let the form fall
  // back to the first ready image the driver reports" — that derivation
  // lives in `imageName` below so we never have to write state from an
  // effect just to sync a default.
  const [pickedImage, setPickedImage] = useState<string | null>(null)
  const [headless, setHeadless] = useState(true)
  const [idleTimeout, setIdleTimeout] = useState('30m')
  const [egressInput, setEgressInput] = useState('')
  const status = useDriverStatus({ enabled: true })
  const session = useComputerUseSession(modelName)
  const { state, start, approve, cancel } = session

  // Derived default: the first ready image the driver reports, or the
  // operator's explicit selection when they've changed it.
  const defaultImage = status.status?.images?.find((i) => i.ready)?.name ?? ''
  const imageName = pickedImage ?? defaultImage

  const proposedManifest = useMemo<CapabilityManifest | undefined>(() => {
    if (!imageName) return undefined
    const img = status.status?.images?.find((i) => i.name === imageName)
    const egress = egressInput
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean)
    return {
      version: 1,
      session: {
        os: img?.os ?? 'mac',
        image: imageName,
        clone: true,
        ...(headless ? {} : { headless: false }),
        ...(idleTimeout.trim() ? { idle_timeout: idleTimeout.trim() } : {}),
      },
      ...(egress.length ? { network: { egress } } : {}),
    }
  }, [imageName, status.status, headless, idleTimeout, egressInput])

  // Auto-approve as soon as the session reaches the consent phase. The
  // form already captured every knob the editor would have, so there's
  // nothing left to ask the user.
  useEffect(() => {
    if (state.phase === 'consent' && state.manifest) {
      void approve(state.manifest)
    }
  }, [state.phase, state.manifest, approve])

  const idle =
    state.phase === 'idle' || state.phase === 'done' || state.phase === 'error'
  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!task.trim() || !imageName || !proposedManifest) return
    void start(task.trim(), proposedManifest)
  }

  return (
    <div className="bg-surface-page min-h-screen p-6 font-aeonik">
      <header className="mx-auto mb-6 max-w-3xl">
        <h1 className="text-xl font-semibold text-content-primary">
          Computer-use preview
        </h1>
        <p className="mt-1 text-sm text-content-secondary">
          Drive the live session card directly against a running driver — no
          chat orchestration. Pairing happens through the system tray; the
          sandbox config is taken from the form below (no separate consent
          step).
        </p>
      </header>

      <form
        onSubmit={onSubmit}
        className="mx-auto mb-6 max-w-3xl rounded-2xl border border-border-subtle bg-surface-card p-4"
      >
        {/* Definition-list shape mirrors the sandbox config popover so the
            form reads as the same field set: each label on its own row,
            the input on the row below for the textarea, otherwise on the
            same row as the label. */}
        <dl className="grid grid-cols-[max-content_1fr] items-baseline gap-x-3 gap-y-3 text-sm">
          <Row label="Model">
            <input
              value={modelName}
              onChange={(e) => setModelName(e.target.value)}
              spellCheck={false}
              className={fieldCls}
              placeholder="kimi-k2-6"
            />
          </Row>
          <Row label="Image">
            <select
              value={imageName}
              onChange={(e) => setPickedImage(e.target.value)}
              className={fieldCls}
            >
              {(status.status?.images ?? []).length === 0 && (
                <option value="" disabled>
                  — no images yet —
                </option>
              )}
              {(status.status?.images ?? []).map((i) => (
                <option key={i.name} value={i.name} disabled={!i.ready}>
                  {i.name} ({i.os}){i.ready ? '' : ' — not ready'}
                </option>
              ))}
            </select>
          </Row>
          <Row label="Lifetime">
            <span className="text-xs text-content-muted">
              ephemeral clone (always — base image is preserved)
            </span>
          </Row>
          <Row label="Display">
            <label className="flex items-center gap-2 text-xs text-content-secondary">
              <input
                type="checkbox"
                checked={headless}
                onChange={(e) => setHeadless(e.target.checked)}
              />
              Headless (no host window — VNC drives the display)
            </label>
          </Row>
          <Row label="Idle timeout">
            <input
              value={idleTimeout}
              onChange={(e) => setIdleTimeout(e.target.value)}
              placeholder="15m"
              className={fieldCls}
            />
          </Row>
          <Row label="Mounts">
            <span className="text-xs text-content-muted">
              none (add via the live editor — TODO)
            </span>
          </Row>
          <Row label="Egress">
            <input
              value={egressInput}
              onChange={(e) => setEgressInput(e.target.value)}
              placeholder="example.com *.github.com   (or * for allow-all)"
              className={fieldCls}
            />
          </Row>
          <Row label="Task">
            <textarea
              value={task}
              onChange={(e) => setTask(e.target.value)}
              rows={2}
              className={fieldCls}
            />
          </Row>
        </dl>
        <div className="mt-4 flex items-center gap-2 border-t border-border-subtle pt-4">
          <button
            type="submit"
            disabled={!idle || !imageName || !task.trim()}
            className="dark:text-content-page rounded-md bg-brand-accent-dark px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-accent-dark/90 disabled:opacity-50 dark:bg-brand-accent-light"
          >
            Start session
          </button>
          {state.phase !== 'idle' && (
            <button
              type="button"
              onClick={cancel}
              className="rounded-md border border-border-subtle px-3 py-1.5 text-sm text-content-secondary hover:bg-surface-chat hover:text-content-primary"
            >
              Reset
            </button>
          )}
          <span className="ml-auto text-xs text-content-muted">
            phase: <span className="font-mono">{state.phase}</span>
          </span>
        </div>
        {state.error && (
          <p className="mt-3 rounded-md bg-red-500/10 px-3 py-2 text-xs text-red-500">
            {state.error}
          </p>
        )}
      </form>

      {state.phase === 'pairing' && (
        <ComputerUsePairingCard
          code={state.pairingCode}
          status={
            state.pairingState === 'consumed' ? 'approved' : state.pairingState
          }
        />
      )}

      {/* The live thread renders for the whole life of the session — it
          stays mounted through done/error too so the operator can keep
          driving the VM. Reset (above) is the only path that tears it
          down. The error boundary guards against render-time crashes
          while async errors land in `state.error`. */}
      <SessionErrorBoundary onReset={cancel}>
        <ComputerUseSessionThread session={session} />
      </SessionErrorBoundary>

      {state.phase === 'done' && state.finalText && (
        <div className="mx-auto max-w-3xl rounded-2xl border border-border-subtle bg-surface-card p-4 text-sm text-content-primary">
          <p className="text-xs font-medium text-content-secondary">
            Final model output
          </p>
          <p className="mt-2 whitespace-pre-wrap">{state.finalText}</p>
        </div>
      )}
    </div>
  )
}

const fieldCls =
  'w-full rounded-md border border-border-subtle bg-surface-chat px-2 py-1 text-sm text-content-primary'

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-xs font-medium text-content-muted">{label}</dt>
      <dd>{children}</dd>
    </>
  )
}

/**
 * Catches render-time errors thrown by the live session card so a single
 * malformed frame can't unmount the entire page. Async errors (inference
 * rejections, network failures) bubble up through the session hook's
 * own try/catch and land in `state.error`; this boundary only fires for
 * truly unexpected render-time crashes.
 */
class SessionErrorBoundary extends Component<
  { children: ReactNode; onReset: () => void },
  { error: Error | null }
> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  reset = () => {
    this.setState({ error: null })
    this.props.onReset()
  }
  render() {
    if (this.state.error) {
      return (
        <div className="mx-auto mb-6 max-w-3xl rounded-2xl border border-red-500/50 bg-red-500/10 p-4 text-sm text-red-500">
          <p className="font-medium">Session card crashed</p>
          <p className="mt-1 break-words text-xs">{this.state.error.message}</p>
          <button
            type="button"
            onClick={this.reset}
            className="mt-3 rounded-md border border-red-500/40 px-3 py-1 text-xs hover:bg-red-500/10"
          >
            Reset
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
