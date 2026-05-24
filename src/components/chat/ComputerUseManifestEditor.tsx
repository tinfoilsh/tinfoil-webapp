/**
 * Editable manifest UI used by the inline consent prompt (and historically by
 * the consent modal). Lets the user review and edit the capabilities the agent
 * is asking for — image / lifetime / window / mounts / egress — before clicking
 * Approve.
 *
 * Extracted from ComputerUseSessionDialog so that both the (now retired) modal
 * path and the new in-chat ComputerUseConsentRenderer can render it without
 * duplication. Default-deny: nothing is granted that isn't visible here.
 */

'use client'

import { cn } from '@/components/ui/utils'
import type {
  CapabilityManifest,
  DriverImage,
  GuestOS,
  ManifestMount,
} from '@/services/computer-use'
import { useState } from 'react'
import { OSBadge } from './ComputerUseSessionMessage'

const fieldCls =
  'rounded-md border border-border-subtle bg-surface-chat px-2 py-1 text-sm text-content-primary'

export function ManifestEditor({
  reason,
  images,
  initial,
  onApprove,
  onCancel,
  approveLabel = 'Approve & run',
}: {
  reason: string
  images: DriverImage[]
  initial: CapabilityManifest
  onApprove: (m: CapabilityManifest) => void
  onCancel: () => void
  /** Label for the primary action button (defaults to "Approve & run"). */
  approveLabel?: string
}) {
  // Offer ready images plus the model's choice (even if not currently ready).
  // For the model's own image (if not in the ready set), fall back to mac
  // as the OS display — the driver will reject the manifest at /begin if the
  // OS doesn't match the image anyway.
  const imageMap = new Map(images.map((i) => [i.name, i.os] as const))
  const initialOS =
    initial.session.os ?? imageMap.get(initial.session.image) ?? 'mac'
  const imageOptions = Array.from(
    new Set([
      ...(initial.session.image ? [initial.session.image] : []),
      ...images.map((i) => i.name),
    ]),
  )
  const [image, setImage] = useState(
    initial.session.image ?? images[0]?.name ?? '',
  )
  const [clone, setClone] = useState(initial.session.clone ?? true)
  const [headless, setHeadless] = useState(initial.session.headless ?? true)
  const [idleTimeout, setIdleTimeout] = useState(
    initial.session.idle_timeout ?? '',
  )
  const [mounts, setMounts] = useState<ManifestMount[]>(initial.mounts ?? [])
  const [egress, setEgress] = useState<string[]>(initial.network?.egress ?? [])

  const hasImage = imageOptions.length > 0
  // Derived OS: looked up from the currently-selected image, falling back to
  // the initial value so an image the driver doesn't (yet) report still has
  // something sensible to display.
  const derivedOS: GuestOS = imageMap.get(image) ?? initialOS

  const build = (): CapabilityManifest => {
    const cleanMounts = mounts.filter((m) => m.src.trim() && m.dst.trim())
    const cleanEgress = egress.map((d) => d.trim()).filter(Boolean)
    return {
      version: 1,
      session: {
        os: derivedOS,
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
        The agent wants to run in an isolated, ephemeral sandbox:
      </p>
      <p className="rounded-lg bg-surface-chat-background px-3 py-2 text-sm text-content-primary">
        {reason}
      </p>

      <Section title="Sandbox">
        <Field label="Image">
          {hasImage ? (
            <div className="flex items-center gap-2">
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
              <OSBadge os={derivedOS} />
            </div>
          ) : (
            <span className="text-sm text-red-500">
              No ready image — run `tinfoil-driver image setup` first.
            </span>
          )}
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
          {approveLabel}
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
