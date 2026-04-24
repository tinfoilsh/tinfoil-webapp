import { CheckCircle2, Circle, CircleDot } from 'lucide-react'
import { z } from 'zod'
import { defineGenUIWidget } from '../types'

const schema = z.object({
  steps: z
    .array(
      z.object({
        title: z.string(),
        description: z.string().optional(),
        status: z.enum(['pending', 'active', 'complete']).optional(),
      }),
    )
    .min(1)
    .describe('Ordered steps to display'),
})

const STATUS_ICONS = {
  pending: <Circle className="h-5 w-5 text-content-muted" />,
  active: <CircleDot className="h-5 w-5 text-blue-500" />,
  complete: <CheckCircle2 className="h-5 w-5 text-green-500" />,
} as const

export const widget = defineGenUIWidget({
  name: 'render_steps',
  description:
    'Show an ordered list of steps or a checklist. Use for processes, instructions, or progress tracking.',
  schema,
  promptHint: 'ordered steps, instructions, or checklist',
  render: ({ steps }) => (
    <div className="my-3 space-y-3">
      {steps.map((step, i) => {
        const status = step.status ?? 'pending'
        return (
          <div key={i} className="flex gap-3">
            <div className="mt-0.5 shrink-0">{STATUS_ICONS[status]}</div>
            <div>
              <p
                className={
                  status === 'complete'
                    ? 'text-sm font-medium text-content-muted line-through'
                    : 'text-sm font-medium text-content-primary'
                }
              >
                {step.title}
              </p>
              {step.description && (
                <p className="mt-0.5 text-xs text-content-muted">
                  {step.description}
                </p>
              )}
            </div>
          </div>
        )
      })}
    </div>
  ),
})
