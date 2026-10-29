import type { WebSearchSource, WebSearchState } from '@/components/chat/types'
import { Favicon } from '@/components/ui/favicon'
import { sanitizeUrl } from '@braintree/sanitize-url'
import { memo, useId, useMemo, useState } from 'react'
import { StepDetails, StepHeader } from './WorkStep'

interface WebSearchProcessProps {
  webSearch: WebSearchState
  // A step of a group shows its results in the group's box.
  inGroup?: boolean
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
    <span className="inline-flex shrink-0 items-center align-middle">
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

// What a search's header says of it.
export function WebSearchLabel({ webSearch }: { webSearch: WebSearchState }) {
  if (webSearch.status === 'blocked')
    return (
      <span>
        <span className="font-medium">Web search blocked</span>
        {webSearch.reason && (
          <span className="font-normal"> — {webSearch.reason}</span>
        )}
      </span>
    )
  return (
    <span>
      <span className="font-medium">
        {webSearch.status === 'searching'
          ? 'Searching the web'
          : webSearch.status === 'failed'
            ? 'Search failed'
            : 'Searched the web'}
      </span>
      {webSearch.query && (
        <span className="font-normal"> for &quot;{webSearch.query}&quot;</span>
      )}
    </span>
  )
}

export const WebSearchProcess = memo(function WebSearchProcess({
  webSearch,
  inGroup = false,
}: WebSearchProcessProps) {
  const [isExpanded, setIsExpanded] = useState(false)
  const detailsId = useId()
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
      <StepHeader
        label={<WebSearchLabel webSearch={webSearch} />}
        extra={
          !isSearching &&
          !isFailed &&
          !isBlocked &&
          hasSources && <InlineSourceFavicons sources={sourcesToShow} />
        }
        isRunning={isSearching}
        isExpanded={isExpanded}
        onToggle={handleToggle}
        detailsId={hasSources ? detailsId : undefined}
        labelClassName={
          isFailed || isBlocked ? 'text-destructive/80' : undefined
        }
      />

      {hasSources && (
        <StepDetails
          id={detailsId}
          isExpanded={isExpanded}
          inGroup={inGroup}
          boxClassName="p-1.5"
        >
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
                  <span className="truncate font-medium">{source.title}</span>
                </div>
              </a>
            ))}
          </div>
        </StepDetails>
      )}
    </div>
  )
})
