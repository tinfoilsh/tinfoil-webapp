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
  const params = new URLSearchParams()
  if (v.subject) params.set('subject', v.subject)
  if (v.body) params.set('body', v.body)
  const qs = params.toString()
  const target = to ? encodeURIComponent(to) : ''
  return `mailto:${target}${qs ? `?${qs}` : ''}`
}

function MessageComposeCard({ channel = 'email', to, title, variants }: Props) {
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
        {variants.length > 1 && (
          <div className="flex flex-wrap gap-1">
            {variants.map((v, i) => (
              <button
                key={`${v.label}-${i}`}
                type="button"
                onClick={() => setSelected(i)}
                className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                  selected === i
                    ? 'border-content-primary bg-content-primary text-surface-chat-background'
                    : 'border-border-subtle bg-surface-chat-background text-content-primary hover:border-content-primary/40'
                }`}
              >
                {v.label}
              </button>
            ))}
          </div>
        )}
        {channel === 'email' && variant.subject && (
          <div className="flex flex-col gap-0.5">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-content-muted">
              Subject
            </p>
            <p className="text-sm text-content-primary">{variant.subject}</p>
          </div>
        )}
        <div className="flex flex-col gap-0.5">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-content-muted">
            {channel === 'email' ? 'Body' : 'Message'}
          </p>
          <pre className="whitespace-pre-wrap rounded-lg border border-border-subtle bg-surface-chat-background p-3 font-sans text-sm text-content-primary">
            {variant.body}
          </pre>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            onClick={copyBody}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border-subtle bg-surface-chat-background px-3 py-1.5 text-sm text-content-primary transition-colors hover:border-content-primary/40"
          >
            <Copy className="h-4 w-4" />
            {copied ? 'Copied' : 'Copy'}
          </button>
          {channel === 'email' && (
            <a
              href={buildMailto(to, variant)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border-subtle bg-surface-chat-background px-3 py-1.5 text-sm text-content-primary transition-colors hover:border-content-primary/40"
            >
              <Send className="h-4 w-4" />
              Open in client
            </a>
          )}
        </div>
      </div>
    </Card>
  )
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
