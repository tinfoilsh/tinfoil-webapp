import type {
  WebSearchInstance,
  WebSearchSource,
  WebSearchState,
} from '@/components/chat/types'
import { Favicon } from '@/components/ui/favicon'
import { sanitizeUrl } from '@braintree/sanitize-url'
import { memo, useMemo, useState } from 'react'
import { PiSpinner } from 'react-icons/pi'

interface WebSearchProcessProps {
  webSearch: WebSearchState
  /**
   * When provided with more than one entry, the component renders a
   * collapsed "Searched the web on N queries" row that expands to list
   * each query (and, within each query, its own sources). Lets adjacent
   * tool-call runs stay inline without stacking one pill per search.
   */
  groupInstances?: WebSearchInstance[]
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

export const WebSearchProcess = memo(function WebSearchProcess({
  webSearch,
  groupInstances,
}: WebSearchProcessProps) {
  const isGrouped = !!groupInstances && groupInstances.length > 1
  if (isGrouped) {
    return (
      <GroupedWebSearchProcess
        instances={groupInstances as WebSearchInstance[]}
      />
    )
  }
  return <SingleWebSearchProcess webSearch={webSearch} />
})

const SingleWebSearchProcess = memo(function SingleWebSearchProcess({
  webSearch,
}: {
  webSearch: WebSearchState
}) {
  const [isExpanded, setIsExpanded] = useState(false)
  const isSearching = webSearch.status === 'searching'
  const isFailed = webSearch.status === 'failed'
  const isBlocked = webSearch.status === 'blocked'

  // Deduplicate sources by URL for display
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
        <span className="min-w-0 text-base text-content-primary/50">
          {isSearching ? (
            <>
              <span className="font-medium">Searching the web...</span>
            </>
          ) : isFailed ? (
            <>
              <span className="font-medium">Search failed</span>
              {webSearch.query && (
                <span className="font-normal">
                  {' '}
                  for &quot;{webSearch.query}&quot;
                </span>
              )}
            </>
          ) : isBlocked ? (
            <>
              <span className="font-medium">Web search blocked</span>
              {webSearch.reason && (
                <span className="font-normal"> — {webSearch.reason}</span>
              )}
            </>
          ) : (
            <>
              <span className="font-medium">Searched the web</span>
              {webSearch.query && (
                <span className="font-normal">
                  {' '}
                  for &quot;{webSearch.query}&quot;
                </span>
              )}
              {hasSources && (
                <span
                  className="inline-flex items-center align-middle"
                  style={{ marginLeft: 6 }}
                >
                  {sourcesToShow.map((source, index) => (
                    <FadeInFavicon
                      key={`${source.url}-${index}`}
                      url={source.url}
                      className="h-4 w-4 shrink-0 rounded-full border border-surface-chat bg-surface-chat"
                      style={{ marginLeft: index === 0 ? 0 : -6 }}
                    />
                  ))}
                </span>
              )}
            </>
          )}
        </span>
      </button>

      {hasSources && (
        <div
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

const GroupedWebSearchProcess = memo(function GroupedWebSearchProcess({
  instances,
}: {
  instances: WebSearchInstance[]
}) {
  const [isExpanded, setIsExpanded] = useState(false)
  const count = instances.length

  const aggregateStatus: WebSearchState['status'] = useMemo(() => {
    if (instances.some((i) => i.status === 'searching')) return 'searching'
    if (instances.some((i) => i.status === 'failed')) return 'failed'
    if (instances.some((i) => i.status === 'blocked')) return 'blocked'
    return 'completed'
  }, [instances])

  const mergedSources = useMemo(() => {
    const seen = new Set<string>()
    const out: WebSearchSource[] = []
    for (const instance of instances) {
      for (const source of instance.sources ?? []) {
        if (seen.has(source.url)) continue
        seen.add(source.url)
        out.push(source)
      }
    }
    return out
  }, [instances])

  const faviconsToShow = mergedSources.slice(0, 5)
  const queriesNoun = `${count} quer${count === 1 ? 'y' : 'ies'}`
  const label: string = (() => {
    switch (aggregateStatus) {
      case 'searching':
        return `Searching the web on ${queriesNoun}`
      case 'failed':
        return `Failed to search the web on ${queriesNoun}`
      case 'blocked':
        return `Web search blocked on ${queriesNoun}`
      case 'completed':
        return `Searched the web on ${queriesNoun}`
    }
  })()

  return (
    <div>
      <button
        type="button"
        onClick={() => setIsExpanded((v) => !v)}
        className="hover:bg-surface-secondary/50 group -mx-1 flex cursor-pointer items-start gap-1.5 rounded-md px-1 py-1 text-left transition-colors"
      >
        <span className="mt-[5px] h-3.5 w-3.5 shrink-0" aria-hidden="true">
          {aggregateStatus === 'searching' ? (
            <PiSpinner
              className="h-3.5 w-3.5 animate-spin text-content-primary/50"
              aria-hidden="true"
              focusable="false"
            />
          ) : (
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
          )}
        </span>
        <span className="min-w-0 text-base text-content-primary/50">
          <span className="font-medium">{label}</span>
          {mergedSources.length > 0 && (
            <span
              className="inline-flex items-center align-middle"
              style={{ marginLeft: 6 }}
            >
              {faviconsToShow.map((source, index) => (
                <FadeInFavicon
                  key={`${source.url}-${index}`}
                  url={source.url}
                  className="h-4 w-4 shrink-0 rounded-full border border-surface-chat bg-surface-chat"
                  style={{ marginLeft: index === 0 ? 0 : -6 }}
                />
              ))}
            </span>
          )}
        </span>
      </button>

      <div
        className="grid overflow-hidden transition-[grid-template-rows] duration-300 ease-out"
        style={{ gridTemplateRows: isExpanded ? '1fr' : '0fr' }}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="ml-2 flex flex-col gap-3 border-l-2 border-border-subtle py-2 pl-3 pr-1">
            {instances.map((instance) => (
              <GroupedWebSearchRow key={instance.id} instance={instance} />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
})

function GroupedWebSearchRow({ instance }: { instance: WebSearchInstance }) {
  const sources = useMemo(() => {
    const seen = new Set<string>()
    return (instance.sources ?? []).filter((s) => {
      if (seen.has(s.url)) return false
      seen.add(s.url)
      return true
    })
  }, [instance.sources])
  const hasSources = sources.length > 0
  const label = instance.query || 'Web search'

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-start gap-1.5 px-1 text-sm text-content-primary/70">
        <span className="min-w-0">
          <span className="font-medium">{label}</span>
          {instance.status === 'searching' && (
            <span className="text-content-primary/40"> — searching…</span>
          )}
          {instance.status === 'failed' && (
            <span className="text-content-primary/40"> — failed</span>
          )}
          {instance.status === 'blocked' && (
            <span className="text-content-primary/40"> — blocked</span>
          )}
          {instance.status === 'completed' && hasSources && (
            <span className="text-content-primary/40">
              {' '}
              — {sources.length} source{sources.length === 1 ? '' : 's'}
            </span>
          )}
        </span>
      </div>

      {hasSources && (
        <div className="flex flex-col gap-0.5">
          {sources.map((source, index) => (
            <a
              key={`${source.url}-${index}`}
              href={sanitizeUrl(source.url)}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:bg-surface-secondary/50 flex items-start gap-2 rounded-md px-2 py-1 text-xs text-content-primary/70 transition-colors"
            >
              <FadeInFavicon
                url={source.url}
                className="mt-0.5 h-3.5 w-3.5 shrink-0 rounded-full"
              />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="opacity-50">{getDomainName(source.url)}</span>
                <span className="truncate font-medium">{source.title}</span>
              </div>
            </a>
          ))}
        </div>
      )}
    </div>
  )
}
