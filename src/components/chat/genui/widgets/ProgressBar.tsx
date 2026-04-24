import { Progress } from '@/components/ui/progress'
import { z } from 'zod'
import { defineGenUIWidget } from '../types'

const schema = z.object({
  label: z.string().describe('Progress label'),
  value: z.number().describe('Current value'),
  max: z.number().optional().describe('Maximum value (defaults to 100)'),
})

export const widget = defineGenUIWidget({
  name: 'render_progress_bar',
  description:
    'Show progress toward a goal. Use when displaying a completion percentage.',
  schema,
  promptHint: 'linear progress toward a goal',
  render: ({ label, value, max = 100 }) => {
    const percentage = Math.min(100, Math.max(0, (value / max) * 100))
    return (
      <div className="my-3 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-content-primary">
            {label}
          </span>
          <span className="text-sm text-content-muted">
            {value}/{max}
          </span>
        </div>
        <Progress value={percentage} />
      </div>
    )
  },
})
