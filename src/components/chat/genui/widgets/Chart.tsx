import { lazy, Suspense } from 'react'
import { defineGenUIWidget } from '../types'
import type { RenderChartArgs } from '../widget-args'

// Recharts is heavy and only needed once a chart actually renders, so it is
// split into its own chunk and loaded on demand rather than at registry
// import time (which runs on the blank chat screen).
const ChartView = lazy(() => import('./ChartView'))

export const widget = defineGenUIWidget({
  name: 'render_chart',
  render: (args: RenderChartArgs) => (
    <Suspense fallback={null}>
      <ChartView {...args} />
    </Suspense>
  ),
})
