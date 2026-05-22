/**
 * Modal for the *interactive* steps of a computer-use session — **pairing** and
 * **consent** only (they need focused input). Once approved, the live run is
 * interleaved into the chat by `ComputerUseSessionThread`, not a modal.
 *
 * The model proposes a manifest via `computer_begin` (with its own `reason`);
 * the consent step shows that reason and lets the user edit **every** capability
 * before approving (default-deny — nothing is granted that isn't shown here).
 */

'use client'

import { cn } from '@/components/ui/utils'
import {
  type CapabilityManifest,
  type GuestOS,
  type ManifestMount,
  type useComputerUseSession,
} from '@/services/computer-use'
import { useState } from 'react'

type SessionApi = ReturnType<typeof useComputerUseSession>

export function ComputerUseSessionDialog({ session }: { session: SessionApi }) {
  const { state, approve, cancel } = session
  // Modal only for the interactive steps; the run streams inline in the chat.
  if (state.phase !== 'pairing' && state.phase !== 'consent') return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-border-subtle bg-surface-chat shadow-xl">
        <header className="flex items-center justify-between border-b border-border-subtle px-5 py-3">
          <h2 className="text-sm font-semibold text-content-primary">
            Computer use
          </h2>
          <button
            type="button"
            onClick={cancel}
            className="rounded-md px-2 py-1 text-xs text-content-secondary hover:bg-surface-chat-background hover:text-content-primary"
          >
            Cancel
          </button>
        </header>

        <div className="overflow-y-auto px-5 py-4">
          {state.phase === 'pairing' && (
            <PairingBody code={state.pairingCode} />
          )}
          {state.phase === 'consent' && state.manifest && (
            <ManifestEditor
              key={state.task}
              reason={state.reason ?? state.task}
              images={state.images}
              initial={state.manifest}
              onApprove={approve}
              onCancel={cancel}
            />
          )}
        </div>
      </div>
    </div>
  )
}

function PairingBody({ code }: { code?: string }) {
  return (
    <div className="space-y-3 text-center">
      <p className="text-sm text-content-secondary">
        Approve this connection in the Tinfoil menu-bar icon. Confirm the code
        matches:
      </p>
      <div className="font-mono text-3xl font-bold tracking-widest text-content-primary">
        {code ?? '····'}
      </div>
      <p className="text-xs text-content-muted">Waiting for approval…</p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Consent — editable manifest
// ---------------------------------------------------------------------------

const fieldCls =
  'rounded-md border border-border-subtle bg-surface-chat px-2 py-1 text-sm text-content-primary'

function ManifestEditor({
  reason,
  images,
  initial,
  onApprove,
  onCancel,
}: {
  reason: string
  images: string[]
  initial: CapabilityManifest
  onApprove: (m: CapabilityManifest) => void
  onCancel: () => void
}) {
  const [os, setOs] = useState<GuestOS>(initial.session.os ?? 'mac')
  // Offer ready images plus the model's choice (even if not currently ready).
  const imageOptions = Array.from(
    new Set([
      ...(initial.session.image ? [initial.session.image] : []),
      ...images,
    ]),
  )
  const [image, setImage] = useState(initial.session.image ?? images[0] ?? '')
  const [clone, setClone] = useState(initial.session.clone ?? true)
  const [headless, setHeadless] = useState(initial.session.headless ?? true)
  const [idleTimeout, setIdleTimeout] = useState(
    initial.session.idle_timeout ?? '',
  )
  const [mounts, setMounts] = useState<ManifestMount[]>(initial.mounts ?? [])
  const [egress, setEgress] = useState<string[]>(initial.network?.egress ?? [])

  const hasImage = imageOptions.length > 0

  const build = (): CapabilityManifest => {
    const cleanMounts = mounts.filter((m) => m.src.trim() && m.dst.trim())
    const cleanEgress = egress.map((d) => d.trim()).filter(Boolean)
    return {
      version: 1,
      session: {
        os,
        image,
        clone,
        // `headless` defaults to true; only send it when the user wants a window.
        ...(headless ? {} : { headless: false }),
        ...(idleTimeout.trim() ? { idle_timeout: idleTimeout.trim() } : {}),
      },
      ...(cleanMounts.length ? { mounts: cleanMounts } : {}),
      ...(cleanEgress.length ? { network: { egress: cleanEgress } } : {}),
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-content-secondary">
        The agent wants to run in an isolated, ephemeral macOS sandbox:
      </p>
      <p className="rounded-lg bg-surface-chat-background px-3 py-2 text-sm text-content-primary">
        {reason}
      </p>

      {/* Session */}
      <Section title="Sandbox">
        <Field label="Image">
          {hasImage ? (
            <select
              value={image}
              onChange={(e) => setImage(e.target.value)}
              className={fieldCls}
            >
              {imageOptions.map((img) => (
                <option key={img} value={img}>
                  {img}
                </option>
              ))}
            </select>
          ) : (
            <span className="text-sm text-red-500">
              No ready image — run `tinfoil-broker image setup` first.
            </span>
          )}
        </Field>
        <Field label="OS">
          <select
            value={os}
            onChange={(e) => setOs(e.target.value as GuestOS)}
            className={fieldCls}
          >
            <option value="mac">mac</option>
            <option value="linux">linux</option>
          </select>
        </Field>
        <Field label="Idle timeout">
          <input
            value={idleTimeout}
            onChange={(e) => setIdleTimeout(e.target.value)}
            placeholder="e.g. 15m (blank = none)"
            className={cn(fieldCls, 'w-40')}
          />
        </Field>
        <Check
          checked={clone}
          onChange={setClone}
          label="Ephemeral clone (discard on exit)"
        />
        <Check
          checked={!headless}
          onChange={(v) => setHeadless(!v)}
          label="Show a window (for manual takeover)"
        />
      </Section>

      {/* Mounts */}
      <Section title="File access (mounts)">
        {mounts.length === 0 && <Empty>No folders shared.</Empty>}
        {mounts.map((m, i) => (
          <div key={i} className="flex flex-wrap items-center gap-1.5">
            <input
              value={m.src}
              onChange={(e) =>
                setMounts(upd(mounts, i, { src: e.target.value }))
              }
              placeholder="~/Documents/x (host)"
              className={cn(fieldCls, 'flex-1')}
            />
            <input
              value={m.dst}
              onChange={(e) =>
                setMounts(upd(mounts, i, { dst: e.target.value }))
              }
              placeholder="/Volumes/x (guest)"
              className={cn(fieldCls, 'flex-1')}
            />
            <select
              value={m.mode}
              onChange={(e) =>
                setMounts(
                  upd(mounts, i, { mode: e.target.value as 'ro' | 'rw' }),
                )
              }
              className={fieldCls}
            >
              <option value="ro">ro</option>
              <option value="rw">rw</option>
            </select>
            <RemoveBtn
              onClick={() => setMounts(mounts.filter((_, j) => j !== i))}
            />
          </div>
        ))}
        <AddBtn
          onClick={() =>
            setMounts([...mounts, { src: '', dst: '', mode: 'ro' }])
          }
        >
          + Add mount
        </AddBtn>
      </Section>

      {/* Network */}
      <Section title="Network (egress allowlist)">
        {egress.length === 0 && <Empty>Sealed — no network access.</Empty>}
        {egress.map((d, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <input
              value={d}
              onChange={(e) =>
                setEgress(egress.map((x, j) => (j === i ? e.target.value : x)))
              }
              placeholder="*.example.com"
              className={cn(fieldCls, 'flex-1')}
            />
            <RemoveBtn
              onClick={() => setEgress(egress.filter((_, j) => j !== i))}
            />
          </div>
        ))}
        <AddBtn onClick={() => setEgress([...egress, ''])}>+ Add domain</AddBtn>
      </Section>

      <div className="flex justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg px-3 py-1.5 text-sm text-content-secondary hover:bg-surface-chat-background"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => onApprove(build())}
          disabled={!hasImage || !image}
          className={cn(
            'rounded-lg px-3 py-1.5 text-sm font-medium',
            hasImage && image
              ? 'bg-brand-accent-dark text-white hover:opacity-90'
              : 'cursor-not-allowed bg-surface-chat-background text-content-muted',
          )}
        >
          Approve & run
        </button>
      </div>
    </div>
  )
}

function upd(
  mounts: ManifestMount[],
  i: number,
  patch: Partial<ManifestMount>,
): ManifestMount[] {
  return mounts.map((m, j) => (j === i ? { ...m, ...patch } : m))
}

function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-content-muted">
        {title}
      </h3>
      {children}
    </div>
  )
}

function Field({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="w-28 text-content-muted">{label}</span>
      {children}
    </div>
  )
}

function Check({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
}) {
  return (
    <label className="flex items-center gap-2 text-sm text-content-primary">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-content-muted">{children}</p>
}

function RemoveBtn({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-md px-2 py-1 text-xs text-content-secondary hover:bg-surface-chat-background"
    >
      Remove
    </button>
  )
}

function AddBtn({
  onClick,
  children,
}: {
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-xs font-medium text-brand-accent-dark hover:underline"
    >
      {children}
    </button>
  )
}
