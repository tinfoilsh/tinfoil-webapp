import { ImageWithSkeleton } from '@/components/preview/image-with-skeleton'
import { Favicon } from '@/components/ui/favicon'
import {
  linkMetadataOf,
  lookupLinkMetadata,
  type LinkMetadata as ResolvedMetadata,
} from '@/services/harness/link-metadata'
import { sanitizeUrl } from '@braintree/sanitize-url'
import { TfExternalLink } from '@tinfoilsh/tinfoil-icons'
import { useEffect, useState } from 'react'
import { defineGenUIWidget } from '../types'
import type { RenderLinkPreviewArgs as Props } from '../widget-args'

// Pages already read, so a preview drawn again does not read its page again.
const LINK_METADATA_CACHE_MAX_ENTRIES = 100
const LINK_METADATA = new Map<string, Promise<ResolvedMetadata | null>>()

function readLinkMetadata(url: string): Promise<ResolvedMetadata | null> {
  const cached = LINK_METADATA.get(url)
  if (cached) return cached
  if (LINK_METADATA.size >= LINK_METADATA_CACHE_MAX_ENTRIES) {
    const oldest = LINK_METADATA.keys().next().value
    if (oldest !== undefined) LINK_METADATA.delete(oldest)
  }
  const request = lookupLinkMetadata(url).catch(() => {
    LINK_METADATA.delete(url)
    return null
  })
  LINK_METADATA.set(url, request)
  return request
}

// A preview stored without its page's details, as older chats keep it, reads
// them when shown. A failure leaves the leaner card.
function useLinkMetadata(url: string, wanted: boolean) {
  const [metadata, setMetadata] = useState<ResolvedMetadata | null>(null)
  useEffect(() => {
    if (!wanted) return
    let cancelled = false
    void readLinkMetadata(url).then((read) => {
      if (!cancelled) setMetadata(read)
    })
    return () => {
      cancelled = true
    }
  }, [url, wanted])
  return wanted ? metadata : null
}

function getDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

function LinkPreview({
  url,
  title,
  metadata: stored,
  readPage,
}: Props & { metadata?: ResolvedMetadata; readPage: boolean }) {
  const read = useLinkMetadata(url, readPage)
  const metadata = stored ?? read
  const resolvedTitle = metadata?.title ?? title
  const resolvedDescription = metadata?.description
  const resolvedImage = metadata?.image
  const resolvedSiteName = metadata?.siteName
  const displayName = resolvedSiteName || getDomain(url)
  const safeHref = sanitizeUrl(url)

  return (
    <a
      href={safeHref}
      target="_blank"
      rel="noopener noreferrer"
      className="hover:border-border-primary my-3 flex w-full overflow-hidden rounded-lg border border-border-subtle bg-surface-card transition-colors hover:bg-surface-chat-background"
    >
      {resolvedImage && (
        <ImageWithSkeleton
          src={resolvedImage}
          alt=""
          wrapperClassName="relative h-32 w-32 shrink-0 overflow-hidden bg-surface-card sm:h-40 sm:w-40"
          className="h-full w-full object-cover"
          loading="lazy"
        />
      )}
      <div className="flex min-w-0 flex-1 flex-col justify-between gap-1 p-4">
        <div>
          <div className="mb-1 flex items-center gap-2">
            <Favicon
              url={url}
              className="h-4 w-4 shrink-0 rounded object-cover"
            />
            <span className="truncate text-xs text-content-muted">
              {displayName}
            </span>
          </div>
          <p className="line-clamp-2 text-sm font-semibold text-content-primary">
            {resolvedTitle}
          </p>
          {resolvedDescription && (
            <p className="mt-1 line-clamp-2 text-xs text-content-muted">
              {resolvedDescription}
            </p>
          )}
        </div>
        <div className="flex items-center gap-1 text-xs text-content-muted">
          <span className="truncate">{getDomain(url)}</span>
          <TfExternalLink className="h-3 w-3 shrink-0" />
        </div>
      </div>
    </a>
  )
}

export const widget = defineGenUIWidget({
  name: 'render_link_preview',
  render: (args, ctx) => (
    <LinkPreview
      {...args}
      metadata={
        ctx.result === undefined ? undefined : linkMetadataOf(ctx.result)
      }
      readPage={ctx.result === undefined && !ctx.isStreaming}
    />
  ),
})
