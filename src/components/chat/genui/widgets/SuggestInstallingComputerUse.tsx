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
import { z } from 'zod'
import { defineGenUIWidget } from '../types'

// Single-line install command. The brief said installation may be a shell
// command OR a download link; we surface both. Keep this in one place so it
// doesn't drift across the docs.
const INSTALL_COMMAND = 'curl -fsSL https://tinfoil.sh/install-driver | sh'
const DOWNLOAD_URL = 'https://tinfoil.sh/download/tinfoil-driver'

const schema = z.object({
  reason: z.string().optional().describe(
    // The widget renders this in italics as the user-facing "why" line, so:
    //   • Write it as a short, second-person sentence the user would
    //     recognise as the thing they just asked for.
    //     ✅ "You asked me to open Safari and summarize the top post."
    //     ✅ "You wanted to drive a sandboxed Mac to fill out a form."
    //     ✅ "You're asking how to enable computer use."
    //   • Don't refer to "the user" in the third person — the user IS the
    //     reader of this card.
    //   • Don't start with "To " or any other fragment that needs the
    //     surrounding text to make grammatical sense.
    //   • Keep it under ~15 words.
    'One short, second-person sentence ("You asked me to …" / "You wanted to …" / "You\'re asking …") describing what the user just asked. Shown verbatim on the install card so they recognise why it appeared. Do NOT refer to "the user" in the third person and do NOT start with "To "; the surrounding card text is independent.',
  ),
})

type Props = z.infer<typeof schema>

/**
 * Trim and lightly normalise a model-supplied reason so it renders well
 * inside the typographic-quote wrapper used by the card. Strips matched
 * surrounding quotes (some models echo them) and any trailing terminal
 * punctuation, which would otherwise double up with the closing curly
 * quote ("…feature.”").
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

function SuggestInstallingComputerUse({ reason }: Props) {
  // Live broker state polled while the card is on screen. We always enable
  // the poll here (independent of the chat-input's gating) so users see
  // detection happen the moment they finish installing — without us, they'd
  // need to refresh the chat to learn the broker came online.
  const brokerStatus = useBrokerStatus({ enabled: true })
  const paired = usePaired()
  const funnel = useComputerUseFunnelContext()
  const reachable = brokerStatus.readiness !== 'absent'

  return (
    <div className="my-3 overflow-hidden rounded-lg border border-border-subtle bg-surface-card">
      <div className="flex items-center gap-2 border-b border-border-subtle px-3 py-2">
        <PiDesktop className="size-4 text-content-secondary" />
        <span className="text-sm font-medium text-content-primary">
          Install Tinfoil computer use
        </span>
      </div>
      <div className="space-y-3 px-3 py-3">
        {/* Reason + explainer render independently so the card reads
            sensibly regardless of how the model phrased the reason (verb
            phrase, full sentence, noun phrase, third-person, etc.). Earlier
            we composed them as "To <reason>, Tinfoil needs …" — that broke
            on every shape that wasn't a bare verb phrase ("To The user
            wants to enable …, Tinfoil needs …"). */}
        {reason && (
          <p className="text-sm italic text-content-secondary">
            “{cleanReason(reason)}”
          </p>
        )}
        <p className="text-sm text-content-secondary">
          Computer use lets the agent drive a sandboxed Mac on your machine —
          the sandbox runs locally and is isolated from your real files. Install
          the local driver below to get started.
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
        {/* Live connection status row. Polls /status while the card is on
            screen; the row swaps shape as the broker comes online and again
            once pairing succeeds, giving the user one place to watch the
            install land instead of hunting for the toggle indicator. */}
        <ConnectionStatusRow
          reachable={reachable}
          probing={brokerStatus.probing}
          paired={paired}
          onConnect={funnel?.connect}
        />
      </div>
    </div>
  )
}

/**
 * Status + action row at the bottom of the install card. Three visible
 * states:
 *   1. broker NOT reachable: spinner + "Watching for the driver…" (so the
 *      user has confidence the app is checking, no manual refresh needed).
 *   2. broker reachable, NOT paired: amber dot + "Driver detected" + a
 *      "Connect" button that drives session.connect() (the same pairing
 *      flow the toggle's amber-dot click uses).
 *   3. broker reachable + paired: green check + "Connected" — the card
 *      becomes inert, and the rest of the UI (toggle / banners) takes over.
 *
 * Without a funnel context (e.g. when the card is rendered in a historical
 * chat without a live session), the Connect button is omitted and the row
 * degrades to read-only.
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

  // Reachable but not paired — surface the pair action right here.
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

export const widget = defineGenUIWidget({
  name: 'suggest_installing_computer_use',
  description:
    'Surface the inline install card for Tinfoil computer use (a sandboxed Mac the agent can drive). The local computer driver isn\'t installed on this user\'s machine yet — this tool is the WAY you respond to ANY of the following: (a) the user asks to do a desktop task (browse, click, type, fill a form, drive an app); (b) the user asks how to enable, install, set up, or turn on computer use / desktop control / the local driver; (c) the user asks what computer use is and how to get it; (d) the user expresses interest in the feature in general. The install card IS the answer in all of these cases — do NOT just describe install steps in text, because you do not know the exact install command/link and the card carries the canonical, copy-pasteable one. The `reason` parameter is a short second-person sentence ("You asked me to open Safari and summarize the top post." / "You\'re asking how to enable computer use." / "You wanted to drive a sandboxed Mac to fill out a form.") shown verbatim on the card so the user recognises why it appeared — DO NOT refer to the user in the third person, DO NOT start with "To ", and DO NOT wrap it in quotes (the card adds them). Only skip this tool if the question is genuinely unrelated to computer use.',
  schema,
  // Tool exposure is gated at the request level (see request-tools.ts), not via
  // the default GenUI tool schemas. This widget is only sent to the model when
  // the broker is verifiably absent.
  defaultExpose: false,
  promptHint:
    'install-funnel card for computer-use — call on ANY computer-use request OR setup question',
  render: (args) => <SuggestInstallingComputerUse {...args} />,
})
