import { Card, CardContent } from '@/components/ui/card'
import { TrendingDown, TrendingUp } from 'lucide-react'
import { z } from 'zod'
import { defineGenUIWidget } from '../types'

const schema = z.object({
  stats: z
    .array(
      z.object({
        label: z.string(),
        value: z.union([z.string(), z.number()]),
        trend: z.enum(['up', 'down']).optional(),
      }),
    )
    .min(1)
    .describe('Metrics or KPIs to display in a responsive grid'),
})

export const widget = defineGenUIWidget({
  name: 'render_stat_cards',
  description:
    'Display a grid of metrics or KPIs. Use when presenting multiple numeric summaries.',
  schema,
  promptHint: 'grid of numeric KPIs or metrics',
  render: ({ stats }) => (
    <div className="my-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
      {stats.map((stat, i) => (
        <Card key={`${stat.label}-${i}`}>
          <CardContent className="p-4">
            <p className="text-xs font-medium text-content-muted">
              {stat.label}
            </p>
            <div className="mt-1 flex items-center gap-2">
              <span className="text-xl font-semibold text-content-primary">
                {stat.value}
              </span>
              {stat.trend === 'up' && (
                <TrendingUp className="h-4 w-4 text-green-500" />
              )}
              {stat.trend === 'down' && (
                <TrendingDown className="h-4 w-4 text-red-500" />
              )}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  ),
})
