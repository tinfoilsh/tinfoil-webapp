import {
  SANDBOX_MAP_URL,
  useSandboxRunner,
  type SandboxRun,
} from '@/components/preview/sandbox-frame'
import { usePreviewMessages } from '@/components/preview/use-preview-messages'
import { Card } from '@/components/ui/card'
import { TfCopy } from '@tinfoilsh/tinfoil-icons'
import type { LucideIcon } from 'lucide-react'
import { ExternalLink, MapPin, Navigation } from 'lucide-react'
import { memo, useId, useMemo, useRef, useState } from 'react'
import type { Location, Props } from './Map'

const APPLE_MAPS_CONSENT_KEY = 'tinfoil:apple-maps-consent'
const APPLE_MAPS_PRIVACY_URL =
  'https://www.apple.com/legal/privacy/data/en/apple-maps/'

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

// Build a stable identity for the locations array so streaming re-renders
// (which produce a fresh `locations` reference every token) don't tear
// down and rebuild the live MapKit instance — that was causing the chat
// view to flicker as the map reloaded mid-stream.
function locationsKey(locations: Location[]): string {
  return locations
    .map((l) =>
      [
        l.name ?? '',
        l.address ?? '',
        typeof l.latitude === 'number' ? l.latitude : '',
        typeof l.longitude === 'number' ? l.longitude : '',
        l.description ?? '',
      ].join('|'),
    )
    .join('~')
}

function MapViewImpl(props: Props & { isDarkMode?: boolean }) {
  const { locations, mapType, mode, query, isDarkMode } = props
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const instanceId = useId()
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')

  // Apple's MapKit JS runs on the sandbox origin's /map page, which fetches
  // its own origin-bound token; the chat only sends the locations. The frame
  // keeps a real origin (allow-same-origin) because Apple binds tokens to it.
  // `locations` is keyed by content so streaming re-renders don't re-post.
  const locationsSignature = useMemo(() => locationsKey(locations), [locations])
  const locationsRef = useRef(locations)
  locationsRef.current = locations
  const run = useMemo<SandboxRun>(
    () => ({
      type: 'tinfoil-sandbox-run',
      kind: 'map',
      instanceId,
      locations: locationsRef.current,
      mode,
      query,
      mapType,
      isDarkMode,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- locations via signature
    [instanceId, locationsSignature, mode, query, mapType, isDarkMode],
  )
  const sandbox = useSandboxRunner(iframeRef, run, SANDBOX_MAP_URL)

  usePreviewMessages(iframeRef, instanceId, (message) => {
    if (
      message.type === 'map-preview-status' &&
      ['loading', 'ready', 'error'].includes(message.status as string)
    ) {
      setStatus(message.status as 'loading' | 'ready' | 'error')
    }
  })

  const failed = status === 'error' || sandbox.failed

  return (
    <div className="relative h-full w-full">
      <iframe
        ref={iframeRef}
        src={sandbox.src}
        title="Apple Maps"
        className="h-full w-full border-0"
        sandbox="allow-scripts allow-same-origin"
        referrerPolicy="no-referrer"
      />
      {status === 'loading' && !failed && (
        <div className="absolute inset-0">
          <MapPlaceholder message="Loading map…" />
        </div>
      )}
      {failed && (
        <div className="absolute inset-0">
          <MapPlaceholder message="Map unavailable" />
        </div>
      )}
    </div>
  )
}

// Skip re-rendering when the inputs are structurally equal. The widget
// renderer rebuilds props on every streaming token, so without this the
// map would reconcile (and the effect could re-fire) constantly.
const MapView = memo(MapViewImpl, (prev, next) => {
  return (
    prev.mapType === next.mapType &&
    prev.mode === next.mode &&
    prev.query === next.query &&
    prev.isDarkMode === next.isDarkMode &&
    locationsKey(prev.locations) === locationsKey(next.locations)
  )
})

function readPersistedConsent(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return localStorage.getItem(APPLE_MAPS_CONSENT_KEY) === 'granted'
  } catch {
    return false
  }
}

function persistConsent() {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(APPLE_MAPS_CONSENT_KEY, 'granted')
  } catch {
    // Storage may be unavailable (private mode, quota); ignore.
  }
}

function MapConsentGate({ onApprove }: { onApprove: () => void }) {
  const [remember, setRemember] = useState(false)

  function handleApprove() {
    if (remember) persistConsent()
    onApprove()
  }

  return (
    <div className="relative h-full w-full">
      <MapPlaceholder message="" />
      <div className="absolute inset-0 flex items-center justify-center bg-black/20 p-4 backdrop-blur-sm">
        <div className="w-full max-w-sm rounded-lg border border-border-subtle bg-surface-card p-4 shadow-lg">
          <p className="text-sm font-semibold text-content-primary">
            Display on Apple Maps?
          </p>
          <p className="mt-1 text-xs text-content-muted">
            Loading this map will send data (your IP address and the locations
            being shown) to Apple.
          </p>
          <label className="mt-3 flex items-center gap-2 text-xs text-content-muted">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            Remember my choice on this device
          </label>
          <button
            type="button"
            onClick={handleApprove}
            className="mt-3 inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-content-primary px-3 py-1.5 text-xs font-medium text-surface-chat-background transition-colors hover:opacity-90"
          >
            <MapPin className="h-3.5 w-3.5" />
            Display on Maps
          </button>
          <a
            href={APPLE_MAPS_PRIVACY_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 block text-center text-[11px] text-content-muted underline transition-colors hover:text-content-primary"
          >
            Apple Maps Privacy Policy
          </a>
        </div>
      </div>
    </div>
  )
}

function modeLabel(mode: Props['mode'], count: number): string | null {
  if (mode === 'search') return 'Search results'
  // Mirror `isDirections`: any time multiple stops are shown the widget
  // behaves as directions, so the badge must say so regardless of `mode`.
  if (mode === 'directions' || count > 1) return 'Directions'
  return null
}

export default function MapWidget(props: Props & { isDarkMode?: boolean }) {
  const { title, locations, mode, query, isDarkMode } = props
  const primary = locations[0]
  const isDirections = mode === 'directions' || locations.length > 1
  const [copied, setCopied] = useState(false)

  const badge = modeLabel(mode, locations.length)
  const appleMapsUrl = primaryAppleMapsUrl(props)
  const PrimaryIcon: LucideIcon = isDirections ? Navigation : MapPin
  const primaryLabel = isDirections
    ? 'Open directions in Apple Maps'
    : 'Open in Apple Maps'

  const [approved, setApproved] = useState<boolean>(() =>
    readPersistedConsent(),
  )

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
          {approved ? (
            <MapView {...props} isDarkMode={isDarkMode} />
          ) : (
            <MapConsentGate onApprove={() => setApproved(true)} />
          )}
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
              <TfCopy className="h-3.5 w-3.5" />
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
