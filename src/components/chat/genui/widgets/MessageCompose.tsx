import { Card } from '@/components/ui/card'
import { Copy, Send } from 'lucide-react'
import { useState } from 'react'
import { z } from 'zod'
import { defineGenUIWidget } from '../types'

const variantSchema = z.object({
  label: z
    .string()
    .describe('Short variant label, e.g. "Formal", "Concise", "Apologetic"'),
  subject: z.string().optional(),
  body: z.string(),
})

const schema = z.object({
  channel: z
    .enum(['email', 'message'])
    .optional()
    .describe('email (shows subject + "Open in Mail") or message (body only)'),
  to: z.string().optional().describe('Recipient — used for mailto:'),
  title: z
    .string()
    .optional()
    .describe('Card title, e.g. "Draft reply to Alice"'),
  variants: z
    .array(variantSchema)
    .min(1)
    .describe(
      'One or more message drafts to offer. First variant is selected by default.',
    ),
})

type Variant = z.infer<typeof variantSchema>
type Props = z.infer<typeof schema>

function buildMailto(to: string | undefined, v: Variant): string {
  // RFC 6068: the mailto query string must use percent-encoding (`%20` for
  // spaces). `URLSearchParams.toString()` produces `application/x-www-form-
  // urlencoded` output (`+` for spaces), which Mail.app interprets
  // literally, so we hand-roll the query with `encodeURIComponent`.
  const parts: string[] = []
  if (v.subject) parts.push(`subject=${encodeURIComponent(v.subject)}`)
  if (v.body) parts.push(`body=${encodeURIComponent(v.body)}`)
  const qs = parts.join('&')
  const target = to ? encodeURIComponent(to) : ''
  return `mailto:${target}${qs ? `?${qs}` : ''}`
}

function VariantTabs({
  variants,
  selected,
  onSelect,
  inline = false,
}: {
  variants: Variant[]
  selected: number
  onSelect: (i: number) => void
  inline?: boolean
}) {
  if (variants.length <= 1) return null
  const containerClass = inline
    ? 'flex flex-wrap gap-1'
    : 'flex flex-wrap gap-1 border-b border-border-subtle bg-surface-chat-background px-3 py-2'
  const inactiveBg = inline ? 'bg-surface-chat-background' : 'bg-surface-card'
  return (
    <div className={containerClass}>
      {variants.map((v, i) => (
        <button
          key={`${v.label}-${i}`}
          type="button"
          onClick={() => onSelect(i)}
          className={`rounded-full border px-3 py-1 text-xs transition-colors ${
            selected === i
              ? 'border-content-primary bg-content-primary text-surface-chat-background'
              : `border-border-subtle ${inactiveBg} text-content-primary hover:border-content-primary/40`
          }`}
        >
          {v.label}
        </button>
      ))}
    </div>
  )
}

function EmailComposeCard({ to, title, variants }: Props) {
  const [selected, setSelected] = useState(0)
  const [copied, setCopied] = useState(false)
  const variant = variants[selected] ?? variants[0]

  async function copyBody() {
    try {
      await navigator.clipboard.writeText(variant.body)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard may be unavailable in some contexts; leave copied=false
    }
  }

  const headerLabel = title ?? 'New Message'

  return (
    <Card className="my-3 max-w-2xl overflow-hidden">
      {/* Window chrome — title bar with traffic-light dots and actions. */}
      <div className="flex items-center gap-2 border-b border-border-subtle bg-surface-chat-background px-3 py-2">
        <div className="flex items-center gap-1.5" aria-hidden>
          <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]" />
        </div>
        <p className="flex-1 truncate text-center text-xs font-medium text-content-muted">
          {headerLabel}
        </p>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={copyBody}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-content-muted transition-colors hover:bg-surface-card hover:text-content-primary"
            aria-label="Copy body"
          >
            <Copy className="h-3.5 w-3.5" />
            {copied ? 'Copied' : 'Copy'}
          </button>
          <a
            href={buildMailto(to, variant)}
            className="inline-flex items-center gap-1 rounded-md bg-content-primary px-2.5 py-1 text-xs font-medium text-surface-chat-background transition-colors hover:opacity-90"
          >
            <Send className="h-3.5 w-3.5" />
            Open in mail client
          </a>
        </div>
      </div>

      <VariantTabs
        variants={variants}
        selected={selected}
        onSelect={setSelected}
      />

      {/* Recipient / Subject header fields. */}
      <div className="flex flex-col divide-y divide-border-subtle">
        <EmailHeaderRow
          label="To"
          value={to ?? ''}
          placeholder="recipient@example.com"
        />
        <EmailHeaderRow
          label="Subject"
          value={variant.subject ?? ''}
          placeholder="(no subject)"
        />
      </div>

      {/* Body area — plain text block, no inner border box. */}
      <div className="whitespace-pre-wrap px-4 py-4 font-sans text-sm leading-relaxed text-content-primary">
        {variant.body}
      </div>
    </Card>
  )
}

function EmailHeaderRow({
  label,
  value,
  placeholder,
}: {
  label: string
  value: string
  placeholder: string
}) {
  const isEmpty = value.trim().length === 0
  return (
    <div className="flex items-baseline gap-3 px-4 py-2 text-sm">
      <span className="w-16 flex-shrink-0 text-xs font-medium uppercase tracking-wide text-content-muted">
        {label}
      </span>
      <span
        className={
          isEmpty
            ? 'truncate text-content-muted'
            : 'truncate text-content-primary'
        }
      >
        {isEmpty ? placeholder : value}
      </span>
    </div>
  )
}

function MessageOnlyCard({ title, variants }: Props) {
  const [selected, setSelected] = useState(0)
  const [copied, setCopied] = useState(false)
  const variant = variants[selected] ?? variants[0]

  async function copyBody() {
    try {
      await navigator.clipboard.writeText(variant.body)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard may be unavailable in some contexts; leave copied=false
    }
  }

  return (
    <Card className="my-3 max-w-2xl overflow-hidden">
      <div className="flex flex-col gap-3 p-4">
        {title && (
          <p className="text-sm font-semibold text-content-primary">{title}</p>
        )}
        <VariantTabs
          variants={variants}
          selected={selected}
          onSelect={setSelected}
          inline
        />
        <div className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-content-primary">
          {variant.body}
        </div>
        <div className="flex items-center justify-end">
          <button
            type="button"
            onClick={copyBody}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border-subtle bg-surface-chat-background px-3 py-1.5 text-sm text-content-primary transition-colors hover:border-content-primary/40"
          >
            <Copy className="h-4 w-4" />
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>
    </Card>
  )
}

function MessageComposeCard(props: Props) {
  if ((props.channel ?? 'email') === 'email') {
    return <EmailComposeCard {...props} />
  }
  return <MessageOnlyCard {...props} />
}

export const widget = defineGenUIWidget({
  name: 'render_message_compose',
  description:
    'Draft a message or email with one or more tone variants. Includes Copy and (for email) Open in Mail. Use when proposing a reply, message, or email draft to send.',
  schema,
  promptHint:
    'a draft message or email with optional tone variants and Copy / Open in Mail',
  render: (args) => <MessageComposeCard {...args} />,
})
