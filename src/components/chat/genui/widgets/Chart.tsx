import { lazy, Suspense } from 'react'
import { z } from 'zod'
import { defineGenUIWidget } from '../types'

const schema = z.object({
  type: z
    .enum(['bar', 'line', 'pie'])
    .describe(
      'Chart type. "bar" for categorical comparisons, "line" for trends or sequences, "pie" for parts of a whole.',
    ),
  data: z
    .array(z.record(z.string(), z.union([z.string(), z.number()])))
    .min(1)
    .describe(
      'Data points sharing the same keys — e.g. [{"label":"A","value":10}, ...]',
    ),
  xKey: z
    .string()
    .optional()
    .describe(
      'For bar/line: key for the category axis. For pie: key for slice names. Defaults to the first string field.',
    ),
  yKey: z
    .string()
    .optional()
    .describe(
      'For bar/line: key for the numeric axis. For pie: key for slice values. Defaults to the first numeric field.',
    ),
  title: z.string().optional(),
  color: z
    .string()
    .optional()
    .describe(
      'Primary series color for bar/line charts. Pie slices use a built-in palette.',
    ),
})

export type ChartArgs = z.infer<typeof schema>

// Recharts is heavy and only needed once a chart actually renders, so it is
// split into its own chunk and loaded on demand rather than at registry
// import time (which runs on the blank chat screen).
const ChartView = lazy(() => import('./ChartView'))

export const widget = defineGenUIWidget({
  name: 'render_chart',
  description:
    'Render a chart from tabular data. Choose `type`: "bar" for categorical comparisons, "line" for trends or sequences over time, "pie" for proportions/parts of a whole.',
  schema,
  promptHint:
    'a chart from tabular data — pass type "bar" | "line" | "pie" depending on whether you are comparing categories, showing a trend, or showing parts of a whole',
  render: (args: ChartArgs) => (
    <Suspense fallback={null}>
      <ChartView {...args} />
    </Suspense>
  ),
})
