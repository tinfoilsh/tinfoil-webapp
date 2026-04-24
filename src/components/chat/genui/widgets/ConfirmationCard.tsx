import { Check, X } from 'lucide-react'
import { z } from 'zod'
import { defineGenUIWidget } from '../types'

const schema = z.object({
  title: z.string().describe('Short title of the action being confirmed'),
  summary: z
    .string()
    .optional()
    .describe('Short restatement of exactly what will happen'),
  details: z
    .array(z.object({ label: z.string(), value: z.string() }))
    .optional()
    .describe('Key/value pairs describing the proposed action'),
  confirmLabel: z.string().optional().describe('Default: "Confirm"'),
  cancelLabel: z.string().optional().describe('Default: "Cancel"'),
  confirmResponse: z
    .string()
    .optional()
    .describe('User message sent when the user confirms (default: "Confirm")'),
  cancelResponse: z
    .string()
    .optional()
    .describe('User message sent when the user cancels (default: "Cancel")'),
})

type ConfirmationProps = z.infer<typeof schema>

function ConfirmationBody({
  title,
  summary,
  details,
}: Pick<ConfirmationProps, 'title' | 'summary' | 'details'>) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-medium text-content-primary">{title}</p>
      {summary && <p className="text-sm text-content-muted">{summary}</p>}
      {details && details.length > 0 && (
        <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 text-xs">
          {details.map((d, i) => (
            <div key={i} className="contents">
              <dt className="font-medium uppercase tracking-wide text-content-muted">
                {d.label}
              </dt>
              <dd className="text-content-primary">{d.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  )
}

export const widget = defineGenUIWidget({
  name: 'confirmation_card',
  description:
    'Confirm a consequential action with the user before proceeding. Replaces the chat input with Confirm/Cancel buttons. Use whenever the user must explicitly approve an action (e.g. deleting data, sending a message, executing a command).',
  schema,
  surface: 'input',
  promptHint:
    'an explicit Confirm/Cancel prompt that replaces the chat input before consequential actions',
  renderInputArea: (args, ctx) => {
    const confirmLabel = args.confirmLabel ?? 'Confirm'
    const cancelLabel = args.cancelLabel ?? 'Cancel'
    const confirmResponse = args.confirmResponse ?? 'Confirm'
    const cancelResponse = args.cancelResponse ?? 'Cancel'
    return (
      <div className="flex flex-col gap-3">
        <ConfirmationBody
          title={args.title}
          summary={args.summary}
          details={args.details}
        />
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() =>
              ctx.resolve(confirmResponse, { decision: 'confirmed' })
            }
            className="inline-flex items-center gap-1.5 rounded-lg border border-content-primary bg-content-primary px-3 py-1.5 text-sm font-medium text-surface-chat-background transition-colors hover:opacity-90"
          >
            <Check className="h-4 w-4" />
            {confirmLabel}
          </button>
          <button
            type="button"
            onClick={() =>
              ctx.resolve(cancelResponse, { decision: 'cancelled' })
            }
            className="inline-flex items-center gap-1.5 rounded-lg border border-border-subtle bg-surface-chat-background px-3 py-1.5 text-sm text-content-primary transition-colors hover:border-content-primary/40"
          >
            <X className="h-4 w-4" />
            {cancelLabel}
          </button>
        </div>
      </div>
    )
  },
  renderResolved: (args, resolution) => {
    const decision =
      resolution.data &&
      typeof resolution.data === 'object' &&
      'decision' in resolution.data
        ? (resolution.data as { decision: string }).decision
        : undefined
    const isConfirmed = decision === 'confirmed'
    return (
      <div className="my-3 flex items-start gap-3 rounded-lg border border-border-subtle bg-surface-card px-4 py-3">
        <div
          className={`mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full ${
            isConfirmed
              ? 'bg-content-primary text-surface-chat-background'
              : 'bg-surface-chat-background text-content-muted'
          }`}
        >
          {isConfirmed ? (
            <Check className="h-3.5 w-3.5" />
          ) : (
            <X className="h-3.5 w-3.5" />
          )}
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <p className="text-sm font-medium text-content-primary">
            {args.title}
          </p>
          <p className="text-xs text-content-muted">
            {isConfirmed ? 'Confirmed' : 'Cancelled'}
          </p>
        </div>
      </div>
    )
  },
})
