/**
 * Inline install-funnel widget for the computer-use feature. The model emits
 * `suggest_installing_computer_use` when the user asks for a sandboxed-desktop
 * task but the local broker (computer driver) isn't installed — gated at the
 * tool-exposure level so this never appears once the broker is detected (see
 * `computerUseRequestTools`).
 *
 * `defaultExpose: false`: this widget is NOT auto-included in the per-request
 * GenUI tool schemas. It rides on `computerUseTools` instead, which means the
 * model only sees it when the broker is genuinely absent — avoiding the case
 * where it would suggest installing something the user already has.
 *
 * Renders a compact card with:
 *  - the model's `reason` for surfacing this (so the user knows WHY),
 *  - a one-shot install command (copyable),
 *  - a direct-download link as a fallback,
 *  - a clear what-it-is line so the user knows what they're installing.
 */
import { cn } from '@/components/ui/utils'
import {
  ArrowTopRightOnSquareIcon,
  CheckIcon,
  ClipboardIcon,
} from '@heroicons/react/24/outline'
import { useState } from 'react'
import { PiDesktop } from 'react-icons/pi'
import { z } from 'zod'
import { defineGenUIWidget } from '../types'

// Single-line install command. The brief said installation may be a shell
// command OR a download link; we surface both. Keep this in one place so it
// doesn't drift across the docs.
const INSTALL_COMMAND = 'curl -fsSL https://tinfoil.sh/install-broker | sh'
const DOWNLOAD_URL = 'https://tinfoil.sh/download/computer-use'

const schema = z.object({
  reason: z
    .string()
    .optional()
    .describe(
      'One short sentence explaining what you wanted to do with computer use. Shown to the user so they understand WHY the install is being suggested.',
    ),
})

type Props = z.infer<typeof schema>

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

function SuggestInstallingComputerUse({ reason }: Props) {
  return (
    <div className="my-3 overflow-hidden rounded-lg border border-border-subtle bg-surface-card">
      <div className="flex items-center gap-2 border-b border-border-subtle px-3 py-2">
        <PiDesktop className="size-4 text-content-secondary" />
        <span className="text-sm font-medium text-content-primary">
          Install Tinfoil computer use
        </span>
      </div>
      <div className="space-y-3 px-3 py-3">
        {reason && (
          <p className="text-sm text-content-secondary">
            <span className="text-content-muted">To </span>
            {reason}
            <span className="text-content-muted">
              , Tinfoil needs the local computer driver running on your Mac.
            </span>
          </p>
        )}
        {!reason && (
          <p className="text-sm text-content-secondary">
            Computer use lets the agent drive a sandboxed Mac on your machine —
            the sandbox runs locally and is isolated from your real files.
            Install the local driver to get started.
          </p>
        )}
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
      </div>
    </div>
  )
}

export const widget = defineGenUIWidget({
  name: 'suggest_installing_computer_use',
  description:
    "Surface an install card for the Tinfoil computer-use feature. Call this ONLY when the user asks for a sandboxed-desktop or computer-automation task (browse, click, type, fill forms, drive an app) AND the `computer_begin` tool is NOT in your available tools — that means the local computer driver isn't installed yet. Do NOT call this if `computer_begin` is available; instead use that. Provide a brief `reason` describing what the user wanted to do.",
  schema,
  // Tool exposure is gated at the request level (see request-tools.ts), not via
  // the default GenUI tool schemas. This widget is only sent to the model when
  // the broker is verifiably absent.
  defaultExpose: false,
  promptHint:
    'install-funnel card for computer-use when the local driver isn’t installed',
  render: (args) => <SuggestInstallingComputerUse {...args} />,
})
