import { lazy, Suspense } from 'react'
import { z } from 'zod'
import { defineGenUIWidget } from '../types'

const locationSchema = z.object({
  name: z.string(),
  address: z.string().optional(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  description: z.string().optional(),
})

const schema = z.object({
  title: z.string().optional(),
  mode: z.enum(['place', 'search', 'directions']).optional(),
  query: z.string().optional(),
  locations: z.array(locationSchema).min(1),
  travelMode: z.enum(['driving', 'walking', 'transit', 'cycling']).optional(),
  mapType: z.enum(['standard', 'hybrid', 'satellite', 'muted']).optional(),
})

export type Location = z.infer<typeof locationSchema>
export type Props = z.infer<typeof schema>

// MapKit JS and its loader are heavy and only needed once a map actually
// renders, so the implementation is split into its own chunk and loaded on
// demand rather than at registry import time (the blank chat screen).
const MapWidget = lazy(() => import('./MapView'))

export const widget = defineGenUIWidget({
  name: 'render_map',
  schema,
  render: (args, ctx) => (
    <Suspense fallback={null}>
      <MapWidget {...args} isDarkMode={ctx.isDarkMode} />
    </Suspense>
  ),
})
