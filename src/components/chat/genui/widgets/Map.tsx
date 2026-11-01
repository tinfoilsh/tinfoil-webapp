import { lazy, Suspense } from 'react'
import { defineGenUIWidget } from '../types'
import type { RenderMapArgs } from '../widget-args'

export type Location = RenderMapArgs['locations'][number]
export type Props = RenderMapArgs

// MapKit JS and its loader are heavy and only needed once a map actually
// renders, so the implementation is split into its own chunk and loaded on
// demand rather than at registry import time (the blank chat screen).
const MapWidget = lazy(() => import('./MapView'))

export const widget = defineGenUIWidget({
  name: 'render_map',
  render: (args, ctx) => (
    <Suspense fallback={null}>
      <MapWidget {...args} isDarkMode={ctx.isDarkMode} />
    </Suspense>
  ),
})
