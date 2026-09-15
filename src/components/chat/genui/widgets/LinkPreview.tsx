import { ImageWithSkeleton } from '@/components/preview/image-with-skeleton'
import { Favicon } from '@/components/ui/favicon'
import { sanitizeUrl } from '@braintree/sanitize-url'
import { ExternalLink } from 'lucide-react'
import { z } from 'zod'
import { defineGenUIWidget } from '../types'

const schema = z.object({
  url: z.string(),
  title: z.string(),
})

type Props = z.infer<typeof schema>

interface ResolvedMetadata {
  title: string | null
  description: string | null
  image: string | null
  siteName: string | null
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
  metadata,
}: Props & { metadata?: ResolvedMetadata }) {
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
          <ExternalLink className="h-3 w-3 shrink-0" />
        </div>
      </div>
    </a>
  )
}

export const widget = defineGenUIWidget({
  name: 'render_link_preview',
  schema,
  render: (args, ctx) => (
    <LinkPreview
      {...args}
      metadata={ctx.result as ResolvedMetadata | undefined}
    />
  ),
})
