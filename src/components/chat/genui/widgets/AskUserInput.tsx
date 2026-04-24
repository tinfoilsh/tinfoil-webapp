import { z } from 'zod'
import { defineGenUIWidget } from '../types'

const optionSchema = z.object({
  id: z.string().optional(),
  label: z.string(),
  value: z.string().optional(),
  description: z.string().optional(),
})

const schema = z.object({
  question: z
    .string()
    .describe(
      'The question presented to the user. Keep it concise and action-oriented.',
    ),
  options: z
    .array(optionSchema)
    .min(2)
    .max(6)
    .describe(
      '2–6 mutually exclusive options. Labels should be short noun phrases.',
    ),
  helpText: z
    .string()
    .optional()
    .describe('Optional secondary text shown beneath the question'),
})

export const widget = defineGenUIWidget({
  name: 'ask_user_input',
  description:
    'Ask the user a multiple-choice question. Replaces the chat input with a set of clickable options. Use when you need a structured choice before continuing (e.g. "Which date works?", "Which option do you prefer?").',
  schema,
  surface: 'input',
  promptHint:
    'a multiple-choice question that replaces the chat input with clickable options',
  renderInputArea: ({ question, options, helpText }, ctx) => (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium text-content-primary">{question}</p>
        {helpText && <p className="text-xs text-content-muted">{helpText}</p>}
      </div>
      <div className="flex flex-wrap gap-2">
        {options.map((option, i) => {
          const label = option.label
          const value = option.value ?? option.label
          return (
            <button
              key={option.id ?? `${label}-${i}`}
              type="button"
              onClick={() => ctx.resolve(value, { choice: value, label })}
              className="flex flex-col items-start gap-0.5 rounded-lg border border-border-subtle bg-surface-chat-background px-3 py-2 text-left text-sm text-content-primary transition-colors hover:border-content-primary/40 hover:bg-surface-card"
            >
              <span className="font-medium">{label}</span>
              {option.description && (
                <span className="text-xs text-content-muted">
                  {option.description}
                </span>
              )}
            </button>
          )
        })}
      </div>
    </div>
  ),
})
