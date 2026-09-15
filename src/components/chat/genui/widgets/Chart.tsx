import { lazy, Suspense } from 'react'
import { z } from 'zod'
import { defineGenUIWidget } from '../types'

const schema = z.object({
  type: z.enum(['bar', 'line', 'pie']),
  data: z.array(z.record(z.string(), z.union([z.string(), z.number()]))).min(1),
  xKey: z.string().optional(),
  yKey: z.string().optional(),
  title: z.string().optional(),
  color: z.string().optional(),
})

export type ChartArgs = z.infer<typeof schema>

// Recharts is heavy and only needed once a chart actually renders, so it is
// split into its own chunk and loaded on demand rather than at registry
// import time (which runs on the blank chat screen).
const ChartView = lazy(() => import('./ChartView'))

export const widget = defineGenUIWidget({
  name: 'render_chart',
  schema,
  render: (args: ChartArgs) => (
    <Suspense fallback={null}>
      <ChartView {...args} />
    </Suspense>
  ),
})
