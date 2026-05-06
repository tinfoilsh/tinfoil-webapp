import type { URLFetchState } from '@/components/chat/types'
import { Favicon } from '@/components/ui/favicon'
import { memo, useMemo, useState } from 'react'
import { PiSpinner } from 'react-icons/pi'

interface URLFetchProcessProps {
  urlFetches: URLFetchState[]
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
    <PiSpinner className="h-3.5 w-3.5 shrink-0 animate-spin text-content-primary/50" />
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

export const URLFetchProcess = memo(function URLFetchProcess({
  urlFetches,
}: URLFetchProcessProps) {
  const [isExpanded, setIsExpanded] = useState(false)
  const anyFetching = useMemo(
    () => urlFetches.some((f) => f.status === 'fetching'),
    [urlFetches],
  )
  const completedCount = useMemo(
    () => urlFetches.filter((f) => f.status === 'completed').length,
    [urlFetches],
  )
  const count = urlFetches.length
  if (count === 0) return null

  const label = anyFetching
    ? `Reading ${count} link${count === 1 ? '' : 's'}`
    : `Read ${completedCount} link${completedCount === 1 ? '' : 's'}`

  return (
    <div>
      <button
        type="button"
        onClick={() => setIsExpanded((v) => !v)}
        className="hover:bg-surface-secondary/50 group -mx-1 flex w-full cursor-pointer items-center gap-1.5 rounded-md px-1 py-1 text-left transition-colors"
      >
        <span className="h-3.5 w-3.5 shrink-0" aria-hidden="true">
          {anyFetching ? (
            <PiSpinner className="h-3.5 w-3.5 animate-spin text-content-primary/50" />
          ) : (
            <svg
              className={`h-3.5 w-3.5 transform text-content-primary/40 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M9 5l7 7-7 7"
              />
            </svg>
          )}
        </span>
        <span className="min-w-0 truncate text-base font-medium text-content-primary/50">
          {label}
        </span>
        <InlineFavicons urlFetches={urlFetches} />
      </button>

      <div
        className="grid overflow-hidden transition-[grid-template-rows] duration-300 ease-out"
        style={{ gridTemplateRows: isExpanded ? '1fr' : '0fr' }}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="ml-2 flex flex-col gap-0.5 border-l-2 border-border-subtle py-2 pl-3 pr-1">
            {urlFetches.map((fetch) => (
              <URLFetchRow key={fetch.id} fetch={fetch} />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
})
