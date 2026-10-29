import type { WebSearchSource, WebSearchState } from '@/components/chat/types'
import { Favicon } from '@/components/ui/favicon'
import { sanitizeUrl } from '@braintree/sanitize-url'
import { memo, useMemo, useState } from 'react'
import { PiSpinner } from 'react-icons/pi'

interface WebSearchProcessProps {
  webSearch: WebSearchState
}

function getDomainName(url: string): string {
  try {
    const parsedUrl = new URL(url)
    const hostname = parsedUrl.hostname.replace(/^www\./, '')
    const parts = hostname.split('.')
    return parts.length > 1 ? parts[parts.length - 2] : hostname
  } catch {
    return ''
  }
}

function FadeInFavicon({
  url,
  className,
  style,
}: {
  url: string
  className: string
  style?: React.CSSProperties
}) {
  return (
    <span className="relative block" style={style}>
      <Favicon url={url} className={className} />
    </span>
  )
}

function InlineSourceFavicons({ sources }: { sources: WebSearchSource[] }) {
  return (
    <span className="ml-1 inline-flex shrink-0 items-center align-middle">
      {sources.map((source, index) => (
        <FadeInFavicon
          key={`${source.url}-${index}`}
          url={source.url}
          className="h-4 w-4 shrink-0 rounded-full border border-surface-chat bg-surface-chat"
          style={{ marginLeft: index === 0 ? 0 : -6 }}
        />
      ))}
    </span>
  )
}

export const WebSearchProcess = memo(function WebSearchProcess({
  webSearch,
}: WebSearchProcessProps) {
  const [isExpanded, setIsExpanded] = useState(false)
  const isSearching = webSearch.status === 'searching'
  const isFailed = webSearch.status === 'failed'
  const isBlocked = webSearch.status === 'blocked'

  const uniqueSources = useMemo(() => {
    if (!webSearch.sources) return []
    const seen = new Set<string>()
    return webSearch.sources.filter((source) => {
      if (seen.has(source.url)) return false
      seen.add(source.url)
      return true
    })
  }, [webSearch.sources])

  const hasSources = uniqueSources.length > 0
  const sourcesToShow = uniqueSources.slice(0, 5)

  const handleToggle = () => {
    if (hasSources) {
      setIsExpanded(!isExpanded)
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={handleToggle}
        disabled={!hasSources}
        aria-expanded={hasSources ? isExpanded : undefined}
        className={`group -mx-1 flex items-start gap-1.5 rounded-md px-1 py-1 text-left transition-colors ${
          hasSources
            ? 'hover:bg-surface-secondary/50 cursor-pointer'
            : 'cursor-default'
        }`}
      >
        <span
          className={`mt-[5px] h-3.5 w-3.5 shrink-0 ${hasSources || isSearching ? '' : 'invisible'}`}
          aria-hidden="true"
        >
          {isSearching ? (
            <PiSpinner
              className="h-3.5 w-3.5 animate-spin text-content-primary/50"
              aria-hidden="true"
              focusable="false"
            />
          ) : hasSources ? (
            <svg
              className={`h-3.5 w-3.5 transform text-content-primary/40 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              aria-hidden="true"
              focusable="false"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M9 5l7 7-7 7"
              />
            </svg>
          ) : null}
        </span>
        <span
          className={`min-w-0 text-base ${isFailed || isBlocked ? 'text-destructive/80' : 'text-content-primary/50'}`}
        >
          {isSearching ? (
            <span className="font-medium">Searching the web...</span>
          ) : isFailed ? (
            <span>
              <span className="font-medium">Search failed</span>
              {webSearch.query && (
                <span className="font-normal">
                  {' '}
                  for &quot;{webSearch.query}&quot;
                </span>
              )}
            </span>
          ) : isBlocked ? (
            <span>
              <span className="font-medium">Web search blocked</span>
              {webSearch.reason && (
                <span className="font-normal"> — {webSearch.reason}</span>
              )}
            </span>
          ) : (
            <>
              <span>
                <span className="font-medium">Searched the web</span>
                {webSearch.query && (
                  <span className="font-normal">
                    {' '}
                    for &quot;{webSearch.query}&quot;
                  </span>
                )}
              </span>
              {hasSources && <InlineSourceFavicons sources={sourcesToShow} />}
            </>
          )}
        </span>
      </button>

      {hasSources && (
        <div
          inert={!isExpanded}
          className="grid overflow-hidden transition-[grid-template-rows] duration-300 ease-out"
          style={{ gridTemplateRows: isExpanded ? '1fr' : '0fr' }}
        >
          <div className="min-h-0 overflow-hidden">
            <div className="ml-2 border-l-2 border-border-subtle py-2 pl-3 pr-1">
              <div className="flex flex-col gap-2">
                {uniqueSources.map((source, index) => (
                  <a
                    key={`${source.url}-${index}`}
                    href={sanitizeUrl(source.url)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:bg-surface-secondary/50 flex items-start gap-3 rounded-md px-2 py-1.5 text-sm text-content-primary/70 transition-colors"
                  >
                    <FadeInFavicon
                      url={source.url}
                      className="mt-0.5 h-4 w-4 shrink-0 rounded-full"
                    />
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="text-xs opacity-50">
                        {getDomainName(source.url)}
                      </span>
                      <span className="truncate font-medium">
                        {source.title}
                      </span>
                    </div>
                  </a>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
})
