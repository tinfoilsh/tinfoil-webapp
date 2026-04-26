import { Card } from '@/components/ui/card'
import { getMapKitToken } from '@/services/mapkit-token'
import { logError } from '@/utils/error-handling'
import type { LucideIcon } from 'lucide-react'
import { Copy, ExternalLink, MapPin, Navigation } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import { defineGenUIWidget } from '../types'

const MAPKIT_SCRIPT_URL = 'https://cdn.apple-mapkit.com/mk/5.x.x/mapkit.js'

const locationSchema = z.object({
  name: z.string().describe('Display name shown on the pin'),
  address: z
    .string()
    .optional()
    .describe('Street address — used for Apple Maps lookup if no coords'),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
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

type Location = z.infer<typeof locationSchema>
type Props = z.infer<typeof schema>

// Apple's MapKit JS namespace is attached to `window.mapkit` once the script
// loads. We type it loosely here because we only need a handful of methods.
interface MapKitNamespace {
  init: (opts: {
    authorizationCallback: (cb: (token: string) => void) => void
    language?: string
  }) => void
  Map: new (container: HTMLElement, opts?: Record<string, unknown>) => MapKitMap
  Coordinate: new (latitude: number, longitude: number) => unknown
  MarkerAnnotation: new (
    coordinate: unknown,
    opts?: Record<string, unknown>,
  ) => unknown
  Geocoder: new () => {
    lookup: (
      place: string,
      callback: (
        error: Error | null,
        data: {
          results?: Array<{
            coordinate: { latitude: number; longitude: number }
          }>
        },
      ) => void,
    ) => void
  }
  MapType: {
    Standard: string
    Hybrid: string
    Satellite: string
    Muted: string
  }
}

interface MapKitMap {
  destroy: () => void
  showItems: (
    items: unknown[],
    opts?: { animate?: boolean; padding?: unknown },
  ) => void
  addAnnotation: (annotation: unknown) => void
  mapType: string
}

let mapKitLoader: Promise<MapKitNamespace> | null = null

function loadMapKit(): Promise<MapKitNamespace> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('MapKit can only load in the browser'))
  }
  const existing = (window as unknown as { mapkit?: MapKitNamespace }).mapkit
  if (existing) return Promise.resolve(existing)
  if (mapKitLoader) return mapKitLoader

  mapKitLoader = new Promise<MapKitNamespace>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = MAPKIT_SCRIPT_URL
    script.crossOrigin = 'anonymous'
    script.async = true
    script.onload = () => {
      const mk = (window as unknown as { mapkit?: MapKitNamespace }).mapkit
      if (!mk) {
        // Clear the cached rejected promise so subsequent map mounts can
        // retry the script load instead of inheriting this failure.
        mapKitLoader = null
        reject(new Error('mapkit global missing after script load'))
        return
      }
      mk.init({
        authorizationCallback: (cb) => {
          getMapKitToken()
            .then((token) => cb(token))
            .catch((error) => {
              logError('MapKit authorization failed', error, {
                component: 'MapWidget',
                action: 'authorizationCallback',
              })
              cb('')
            })
        },
      })
      resolve(mk)
    }
    script.onerror = () => {
      mapKitLoader = null
      reject(new Error('failed to load mapkit.js'))
    }
    document.head.appendChild(script)
  })

  return mapKitLoader
}

function encodeAddressOrCoord(loc: Location): string | null {
  if (typeof loc.latitude === 'number' && typeof loc.longitude === 'number') {
    return `${loc.latitude},${loc.longitude}`
  }
  if (loc.address) return loc.address
  if (loc.name) return loc.name
  return null
}

function buildPlaceUrl(loc: Location): string {
  const params: string[] = []
  if (typeof loc.latitude === 'number' && typeof loc.longitude === 'number') {
    params.push(`coordinate=${loc.latitude},${loc.longitude}`)
    if (loc.name) params.push(`name=${encodeURIComponent(loc.name)}`)
  } else if (loc.address) {
    params.push(`address=${encodeURIComponent(loc.address)}`)
  } else if (loc.name) {
    params.push(`address=${encodeURIComponent(loc.name)}`)
  }
  return `https://maps.apple.com/place${params.length ? `?${params.join('&')}` : ''}`
}

function buildSearchUrl(query: string, center?: Location): string {
  const params: string[] = [`query=${encodeURIComponent(query)}`]
  if (
    center &&
    typeof center.latitude === 'number' &&
    typeof center.longitude === 'number'
  ) {
    params.push(`center=${center.latitude},${center.longitude}`)
  }
  return `https://maps.apple.com/search?${params.join('&')}`
}

function buildDirectionsUrl(
  locations: Location[],
  travelMode?: string,
): string {
  const points = locations
    .map(encodeAddressOrCoord)
    .filter((p): p is string => p !== null)
  if (points.length === 0) return 'https://maps.apple.com/directions'

  const params: string[] = []
  if (points.length === 1) {
    params.push(`destination=${encodeURIComponent(points[0])}`)
  } else {
    params.push(`source=${encodeURIComponent(points[0])}`)
    params.push(`destination=${encodeURIComponent(points[points.length - 1])}`)
    for (const wp of points.slice(1, -1)) {
      params.push(`waypoint=${encodeURIComponent(wp)}`)
    }
  }
  if (travelMode) params.push(`mode=${travelMode}`)
  return `https://maps.apple.com/directions?${params.join('&')}`
}

function primaryAppleMapsUrl(props: Props): string {
  const { mode, locations, query, travelMode } = props
  if (mode === 'directions' || locations.length > 1) {
    return buildDirectionsUrl(locations, travelMode)
  }
  if (mode === 'search' && query) {
    return buildSearchUrl(query, locations[0])
  }
  return buildPlaceUrl(locations[0])
}

function MapPlaceholder({ message }: { message: string }) {
  return (
    <div
      className="relative flex h-full w-full items-center justify-center overflow-hidden bg-gradient-to-br from-[#bfe1ff] via-[#cfe9ff] to-[#e8f3ff] dark:from-[#1e3a5f] dark:via-[#16294a] dark:to-[#0f1d35]"
      role="img"
      aria-label={message}
    >
      <div className="flex flex-col items-center gap-2 text-center">
        <MapPin className="h-8 w-8 text-content-muted" />
        <p className="text-xs text-content-muted">{message}</p>
      </div>
    </div>
  )
}

function MapView(props: Props) {
  const { locations, mapType } = props
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<MapKitMap | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')

  useEffect(() => {
    if (typeof window === 'undefined') return
    let cancelled = false

    loadMapKit()
      .then((mk) => {
        if (cancelled || !containerRef.current) return

        const map = new mk.Map(containerRef.current, {
          showsCompass: 'adaptive',
          showsZoomControl: true,
          showsMapTypeControl: false,
        })

        if (mapType) {
          const desired =
            mapType === 'hybrid'
              ? mk.MapType.Hybrid
              : mapType === 'satellite'
                ? mk.MapType.Satellite
                : mapType === 'muted'
                  ? mk.MapType.Muted
                  : mk.MapType.Standard
          if (desired) map.mapType = desired
        }

        mapRef.current = map

        const annotations: unknown[] = []
        const pendingLookups: Array<Promise<unknown | null>> = []

        for (const loc of locations) {
          if (
            typeof loc.latitude === 'number' &&
            typeof loc.longitude === 'number'
          ) {
            const coord = new mk.Coordinate(loc.latitude, loc.longitude)
            const annotation = new mk.MarkerAnnotation(coord, {
              title: loc.name,
              subtitle: loc.description ?? loc.address ?? '',
            })
            annotations.push(annotation)
          } else if (loc.address || loc.name) {
            const lookupTarget = loc.address ?? loc.name
            const geocoder = new mk.Geocoder()
            const promise = new Promise<unknown | null>((resolve) => {
              geocoder.lookup(lookupTarget, (error, data) => {
                if (error || !data.results || data.results.length === 0) {
                  resolve(null)
                  return
                }
                const result = data.results[0]
                const coord = new mk.Coordinate(
                  result.coordinate.latitude,
                  result.coordinate.longitude,
                )
                const annotation = new mk.MarkerAnnotation(coord, {
                  title: loc.name,
                  subtitle: loc.description ?? loc.address ?? '',
                })
                resolve(annotation)
              })
            })
            pendingLookups.push(promise)
          }
        }

        const finalize = () => {
          if (cancelled || !mapRef.current) return
          if (annotations.length === 0) {
            setStatus('error')
            return
          }
          for (const a of annotations) mapRef.current.addAnnotation(a)
          mapRef.current.showItems(annotations, { animate: false })
          setStatus('ready')
        }

        if (pendingLookups.length === 0) {
          finalize()
        } else {
          Promise.all(pendingLookups).then((resolved) => {
            for (const a of resolved) {
              if (a) annotations.push(a)
            }
            finalize()
          })
        }
      })
      .catch((error) => {
        if (cancelled) return
        logError('Failed to initialize MapKit', error, {
          component: 'MapWidget',
          action: 'loadMapKit',
        })
        setStatus('error')
      })

    return () => {
      cancelled = true
      if (mapRef.current) {
        try {
          mapRef.current.destroy()
        } catch {
          // Map may already be torn down on hot reload
        }
        mapRef.current = null
      }
    }
  }, [locations, mapType])

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full" />
      {status === 'loading' && (
        <div className="absolute inset-0">
          <MapPlaceholder message="Loading map…" />
        </div>
      )}
      {status === 'error' && (
        <div className="absolute inset-0">
          <MapPlaceholder message="Map unavailable" />
        </div>
      )}
    </div>
  )
}

function modeLabel(mode: Props['mode'], count: number): string | null {
  if (mode === 'directions' || (mode === undefined && count > 1)) {
    return 'Directions'
  }
  if (mode === 'search') return 'Search results'
  return null
}

function MapWidget(props: Props) {
  const { title, locations, mode, query } = props
  const primary = locations[0]
  const isDirections = mode === 'directions' || locations.length > 1
  const [copied, setCopied] = useState(false)

  const badge = modeLabel(mode, locations.length)
  const appleMapsUrl = primaryAppleMapsUrl(props)
  const PrimaryIcon: LucideIcon = isDirections ? Navigation : MapPin
  const primaryLabel = isDirections
    ? 'Open directions in Apple Maps'
    : 'Open in Apple Maps'

  async function copyAddress() {
    const text =
      primary.address ??
      (typeof primary.latitude === 'number' &&
      typeof primary.longitude === 'number'
        ? `${primary.latitude}, ${primary.longitude}`
        : primary.name)
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard may be unavailable in some contexts; leave copied=false
    }
  }

  return (
    <Card className="my-3 w-full overflow-hidden">
      <div className="flex flex-col gap-3 p-4">
        {(title || badge) && (
          <div className="flex flex-col gap-0.5">
            {badge && (
              <span className="text-[11px] font-medium uppercase tracking-[0.18em] text-content-muted">
                {badge}
                {mode === 'search' && query ? ` · ${query}` : ''}
              </span>
            )}
            {title && (
              <p className="text-sm font-semibold text-content-primary">
                {title}
              </p>
            )}
          </div>
        )}

        <div className="relative aspect-[16/9] w-full overflow-hidden rounded-lg border border-border-subtle bg-surface-card sm:aspect-[2/1]">
          <MapView {...props} />
        </div>

        {locations.length > 1 && (
          <ol className="flex flex-col gap-1.5">
            {locations.map((loc, i) => (
              <li
                key={`${loc.name}-${i}`}
                className="flex items-start gap-2 rounded-md border border-border-subtle bg-surface-chat-background px-3 py-2"
              >
                <span className="mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-content-primary text-[11px] font-semibold text-surface-chat-background">
                  {i + 1}
                </span>
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="text-sm font-medium text-content-primary">
                    {loc.name}
                  </span>
                  {(loc.description || loc.address) && (
                    <span className="truncate text-xs text-content-muted">
                      {loc.description ?? loc.address}
                    </span>
                  )}
                </div>
                <a
                  href={buildPlaceUrl(loc)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 rounded-md border border-border-subtle bg-surface-card px-2 py-1 text-[11px] text-content-muted transition-colors hover:border-content-primary/40 hover:text-content-primary"
                >
                  Open
                  <ExternalLink className="h-3 w-3" />
                </a>
              </li>
            ))}
          </ol>
        )}

        <div className="flex flex-wrap items-center justify-end gap-1.5">
          {locations.length === 1 && primary.address && (
            <button
              type="button"
              onClick={copyAddress}
              className="inline-flex items-center gap-1.5 rounded-md border border-border-subtle bg-surface-chat-background px-3 py-1.5 text-xs text-content-primary transition-colors hover:border-content-primary/40"
            >
              <Copy className="h-3.5 w-3.5" />
              {copied ? 'Copied' : 'Copy address'}
            </button>
          )}
          <a
            href={appleMapsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-md bg-content-primary px-3 py-1.5 text-xs font-medium text-surface-chat-background transition-colors hover:opacity-90"
          >
            <PrimaryIcon className="h-3.5 w-3.5" />
            {primaryLabel}
          </a>
        </div>
      </div>
    </Card>
  )
}

export const widget = defineGenUIWidget({
  name: 'render_map',
  description:
    'Display an interactive Apple Map with one or more pinned locations and a button to open the map (or directions, when multiple stops are provided) in Apple Maps. Use when the user asks about places, addresses, routes, or wants to see somewhere on a map. Provide latitude/longitude when known; otherwise an address string is geocoded automatically.',
  schema,
  promptHint:
    'an interactive Apple Map with one or more locations and a button to open in Apple Maps',
  render: (args) => <MapWidget {...args} />,
})
