import { lazy, Suspense } from 'react'
import { z } from 'zod'
import { defineGenUIWidget } from '../types'

const locationSchema = z.object({
  name: z.string().describe('Display name shown on the pin'),
  address: z
    .string()
    .optional()
    .describe(
      'Full address or place query (e.g. "1 Apple Park Way, Cupertino, CA" or "Eiffel Tower, Paris"). Used for geocoding when coordinates are not provided.',
    ),
  latitude: z
    .number()
    .optional()
    .describe(
      'Latitude in degrees. Always provide this when you know it — relying on geocoding alone can fail for ambiguous names.',
    ),
  longitude: z
    .number()
    .optional()
    .describe(
      'Longitude in degrees. Always provide this when you know it — relying on geocoding alone can fail for ambiguous names.',
    ),
  description: z.string().optional().describe('One-line subtitle'),
})

const schema = z.object({
  title: z.string().optional(),
  mode: z
    .enum(['place', 'search', 'directions'])
    .optional()
    .describe(
      '`place` (default) for a single location, `search` for a POI query, `directions` for a routed list',
    ),
  query: z
    .string()
    .optional()
    .describe('Used when `mode === "search"`, e.g. "coffee"'),
  locations: z.array(locationSchema).min(1),
  travelMode: z.enum(['driving', 'walking', 'transit', 'cycling']).optional(),
  mapType: z
    .enum(['standard', 'hybrid', 'satellite', 'muted'])
    .optional()
    .describe('Visual style of the map tiles'),
})

export type Location = z.infer<typeof locationSchema>
export type Props = z.infer<typeof schema>

// MapKit JS and its loader are heavy and only needed once a map actually
// renders, so the implementation is split into its own chunk and loaded on
// demand rather than at registry import time (the blank chat screen).
const MapWidget = lazy(() => import('./MapView'))

export const widget = defineGenUIWidget({
  name: 'render_map',
  description:
    'Display an interactive Apple Map with one or more pinned locations and a button to open the map (or directions, when multiple stops are provided) in Apple Maps. Use when the user asks about places, addresses, routes, or wants to see somewhere on a map. Provide latitude/longitude when known; otherwise an address string is geocoded automatically.',
  schema,
  promptHint:
    'an interactive Apple Map with one or more locations and a button to open in Apple Maps',
  render: (args, ctx) => (
    <Suspense fallback={null}>
      <MapWidget {...args} isDarkMode={ctx.isDarkMode} />
    </Suspense>
  ),
})
