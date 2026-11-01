import type { URLFetchState } from '@/components/chat/types'
import { Favicon } from '@/components/ui/favicon'
import { memo, useId, useMemo, useState } from 'react'
import { PiSpinner } from 'react-icons/pi'
import { StepDetails, StepHeader } from './WorkStep'

interface URLFetchProcessProps {
  urlFetches: URLFetchState[]
  // When the first page read started, in epoch milliseconds.
  startedAt?: number
  // A step of a group lists its pages in the group's box.
  inGroup?: boolean
}

// Max favicons shown inline next to the "Read N links" label before
// the remainder collapses into a "+N" badge.
const INLINE_FAVICON_LIMIT = 4

function getDisplayUrl(url: string): string {
  try {
    const parsed = new URL(url)
    const hostname = parsed.hostname.replace(/^www\./, '')
    const path = parsed.pathname === '/' ? '' : parsed.pathname
    return hostname + path
  } catch {
    return url
  }
}

function FetchSpinner() {
  return (
    <PiSpinner
      className="h-3.5 w-3.5 shrink-0 animate-spin text-content-primary/50"
      aria-hidden="true"
    />
  )
}

/// Single row rendering one fetched URL inside the expanded list.
/// Always compact: the verb ("Read"/"Reading") is conveyed by the
/// collapsible header, so rows just show favicon + host/path.
function URLFetchRow({ fetch }: { fetch: URLFetchState }) {
  return (
    <div className="flex min-h-7 items-center gap-2 text-sm">
      {fetch.status === 'fetching' ? (
        <FetchSpinner />
      ) : (
        <Favicon url={fetch.url} className="h-3.5 w-3.5 shrink-0 rounded-sm" />
      )}
      <span
        className={`min-w-0 truncate ${
          fetch.status === 'failed'
            ? 'text-content-primary/40 line-through'
            : 'text-content-primary/60'
        }`}
      >
        {getDisplayUrl(fetch.url)}
      </span>
    </div>
  )
}

/// Inline stack of favicons shown next to the "Read N links" header.
/// Mirrors the overlap + overflow "+N" treatment used by the iOS web
/// search row so the two visual groupings feel related.
function InlineFavicons({ urlFetches }: { urlFetches: URLFetchState[] }) {
  const visible = urlFetches.slice(0, INLINE_FAVICON_LIMIT)
  const overflow = urlFetches.length - visible.length

  return (
    <span className="flex shrink-0 items-center">
      <span className="flex -space-x-1.5">
        {visible.map((fetch) => (
          <span
            key={fetch.id}
            className="bg-surface-secondary inline-flex h-4 w-4 items-center justify-center overflow-hidden rounded-full ring-1 ring-border-subtle"
          >
            <Favicon url={fetch.url} className="h-3 w-3" />
          </span>
        ))}
      </span>
      {overflow > 0 && (
        <span className="ml-1.5 text-xs text-content-primary/50">
          +{overflow}
        </span>
      )}
    </span>
  )
}

export function isAnyURLFetching(urlFetches: URLFetchState[]): boolean {
  return urlFetches.some((f) => f.status === 'fetching')
}

export function getURLFetchHeaderLabel(urlFetches: URLFetchState[]): string {
  const count = urlFetches.length
  if (isAnyURLFetching(urlFetches)) {
    return `Reading ${count} link${count === 1 ? '' : 's'}`
  }
  const completedCount = urlFetches.filter(
    (f) => f.status === 'completed',
  ).length
  return `Read ${completedCount} link${completedCount === 1 ? '' : 's'}`
}

export const URLFetchProcess = memo(function URLFetchProcess({
  urlFetches,
  startedAt,
  inGroup = false,
}: URLFetchProcessProps) {
  const [isExpanded, setIsExpanded] = useState(false)
  const detailsId = useId()
  const anyFetching = useMemo(() => isAnyURLFetching(urlFetches), [urlFetches])
  const label = useMemo(() => getURLFetchHeaderLabel(urlFetches), [urlFetches])
  if (urlFetches.length === 0) return null

  return (
    <div>
      <StepHeader
        label={<span className="font-medium">{label}</span>}
        extra={<InlineFavicons urlFetches={urlFetches} />}
        isRunning={anyFetching}
        startedAt={startedAt}
        isExpanded={isExpanded}
        onToggle={() => setIsExpanded((v) => !v)}
        detailsId={detailsId}
        truncate
      />

      <StepDetails
        id={detailsId}
        isExpanded={isExpanded}
        inGroup={inGroup}
        boxClassName="px-3 py-1.5"
      >
        <div className="flex flex-col gap-0.5">
          {urlFetches.map((fetch) => (
            <URLFetchRow key={fetch.id} fetch={fetch} />
          ))}
        </div>
      </StepDetails>
    </div>
  )
})
