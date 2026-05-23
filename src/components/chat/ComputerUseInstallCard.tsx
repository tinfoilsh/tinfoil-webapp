/**
 * Static install-funnel card. Renders when an assistant message carries the
 * `computerUseInstallSuggestion` marker; that marker is committed by the
 * webapp (NOT by the model) — currently from the toggle's "Ask Tin" click in
 * the broker-absent + never-engaged state. Moved out of GenUI because the
 * funnel is a deterministic webapp action, not a model-controlled widget;
 * the model has no install tool to abuse and never sees this message in its
 * context (chat-query builder filters it).
 *
 * Live status:
 *   • Polls `/status` while the card is on screen so the user sees the
 *     broker come online the moment they finish installing.
 *   • Once the broker is detected (unpaired), a Connect button drives the
 *     same pairing flow as the toggle/banner via `ComputerUseFunnelContext`.
 *   • Once paired, the row shows "Connected" and the toggle becomes active.
 */
'use client'

import { useComputerUseFunnelContext } from '@/components/chat/computer-use-funnel-context'
import { cn } from '@/components/ui/utils'
import { useBrokerStatus, usePaired } from '@/services/computer-use'
import {
  ArrowTopRightOnSquareIcon,
  CheckCircleIcon,
  CheckIcon,
  ClipboardIcon,
} from '@heroicons/react/24/outline'
import { useState } from 'react'
import { PiDesktop, PiSpinner } from 'react-icons/pi'

// Single-line install command. The brief said installation may be a shell
// command OR a download link; we surface both. Keep this in one place so it
// doesn't drift across the docs.
const INSTALL_COMMAND = 'curl -fsSL https://tinfoil.sh/install-driver | sh'
const DOWNLOAD_URL = 'https://tinfoil.sh/download/tinfoil-driver'

interface ComputerUseInstallCardProps {
  /**
   * Optional one-sentence note about why the funnel appeared. Today nobody
   * writes this; reserved for a future flow where the model generates a
   * justification. Rendered in italics + curly quotes when present.
   */
  reason?: string
  /** Set by the assistant-message wrapper for left-anchored chat alignment. */
  className?: string
}

/**
 * Strip surrounding quotes + trailing terminal punctuation so the curly
 * quotes the card adds don't double up. Same helper as the previous
 * widget — kept local here to avoid a circular import once GenUI deps drop.
 */
function cleanReason(s: string): string {
  return s
    .trim()
    .replace(/^["“”'']+|["“”'']+$/g, '')
    .replace(/[.!?]+$/g, '')
    .trim()
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(text)
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      }}
      aria-label={copied ? 'Copied' : 'Copy install command'}
      className={cn(
        'rounded-md p-1.5 transition-colors',
        copied
          ? 'bg-green-500/10 text-green-600 dark:text-green-400'
          : 'text-content-secondary hover:bg-surface-chat hover:text-content-primary',
      )}
    >
      {copied ? (
        <CheckIcon className="size-4" />
      ) : (
        <ClipboardIcon className="size-4" />
      )}
    </button>
  )
}

export function ComputerUseInstallCard({
  reason,
  className,
}: ComputerUseInstallCardProps) {
  const brokerStatus = useBrokerStatus({ enabled: true })
  const paired = usePaired()
  const funnel = useComputerUseFunnelContext()
  const reachable = brokerStatus.readiness !== 'absent'

  return (
    // Standard assistant-message shell (mx-auto, max-w-3xl, left-aligned) so
    // the card sits in the same column as other chat messages instead of
    // stretching the full width. Matches ComputerUseSessionCard /
    // ComputerUseConsentRenderer / ComputerUsePairingCard.
    <div className="relative mx-auto mb-6 flex w-full max-w-3xl flex-col items-start">
      <div className="w-full px-4 py-2">
        <div
          className={cn(
            'overflow-hidden rounded-lg border border-border-subtle bg-surface-card',
            className,
          )}
        >
          <div className="flex items-center gap-2 border-b border-border-subtle px-3 py-2">
            <PiDesktop className="size-4 text-content-secondary" />
            <span className="text-sm font-medium text-content-primary">
              Install Tinfoil computer use
            </span>
          </div>
          <div className="space-y-3 px-3 py-3">
            {reason && (
              <p className="text-sm italic text-content-secondary">
                “{cleanReason(reason)}”
              </p>
            )}
            <p className="text-sm text-content-secondary">
              Computer use lets the agent drive a sandboxed Mac on your machine
              — the sandbox runs locally and is isolated from your real files.
              Install the local driver below to get started.
            </p>
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-content-muted">
                Quick install (Terminal)
              </p>
              <div className="flex items-stretch gap-1 rounded-md border border-border-subtle bg-surface-chat">
                <code className="flex-1 select-all overflow-x-auto whitespace-nowrap px-3 py-2 font-mono text-xs text-content-primary">
                  {INSTALL_COMMAND}
                </code>
                <CopyButton text={INSTALL_COMMAND} />
              </div>
            </div>
            <div className="flex items-center justify-between gap-2">
              <a
                href={DOWNLOAD_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs font-medium text-brand-accent-dark hover:underline dark:text-brand-accent-light"
              >
                Download installer
                <ArrowTopRightOnSquareIcon className="size-3" />
              </a>
              <span className="text-xs text-content-muted">
                macOS · ~21 GB image
              </span>
            </div>
            <ConnectionStatusRow
              reachable={reachable}
              probing={brokerStatus.probing}
              paired={paired}
              onConnect={funnel?.connect}
            />
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * Status + action row at the bottom of the install card. See the widget
 * version's docstring for the three-state matrix — copied here verbatim now
 * that the GenUI widget is gone.
 */
function ConnectionStatusRow({
  reachable,
  probing,
  paired,
  onConnect,
}: {
  reachable: boolean
  probing: boolean
  paired: boolean
  onConnect?: () => Promise<boolean>
}) {
  const [connecting, setConnecting] = useState(false)

  if (paired) {
    return (
      <div className="flex items-center gap-2 rounded-md bg-green-500/10 px-3 py-2 text-xs text-green-700 dark:text-green-300">
        <CheckCircleIcon className="size-4" />
        <span className="font-medium">Connected</span>
        <span className="opacity-80">
          — the toggle in the input bar is now active.
        </span>
      </div>
    )
  }

  if (!reachable) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-dashed border-border-subtle bg-surface-chat px-3 py-2 text-xs text-content-secondary">
        <PiSpinner className={cn('size-4', probing && 'animate-spin')} />
        <span>Watching for the local driver…</span>
        <span className="opacity-60">
          Run the install command above; this will switch on its own.
        </span>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
      <span
        aria-hidden
        className="inline-block size-2 rounded-full bg-amber-500"
      />
      <span className="font-medium">Driver detected.</span>
      <span className="flex-1 opacity-80">Connect this browser to it.</span>
      {onConnect ? (
        <button
          type="button"
          onClick={async () => {
            if (connecting) return
            setConnecting(true)
            try {
              await onConnect()
            } finally {
              setConnecting(false)
            }
          }}
          disabled={connecting}
          className={cn(
            'rounded-md px-2 py-1 text-xs font-medium transition-colors',
            connecting
              ? 'bg-amber-500/30 text-amber-900/60 dark:text-amber-100/60'
              : 'bg-amber-500/30 text-amber-900 hover:bg-amber-500/40 dark:text-amber-100',
          )}
        >
          {connecting ? 'Confirming in tray…' : 'Connect'}
        </button>
      ) : (
        <span className="opacity-60">Use the toggle below.</span>
      )}
    </div>
  )
}
