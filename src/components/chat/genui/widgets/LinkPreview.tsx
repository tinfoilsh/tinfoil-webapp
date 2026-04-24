import { ImageWithSkeleton } from '@/components/preview/image-with-skeleton'
import { ExternalLink } from 'lucide-react'
import { z } from 'zod'
import { defineGenUIWidget } from '../types'

const schema = z.object({
  url: z.string().describe('Full URL of the resource'),
  title: z.string().describe('Page or resource title'),
  description: z.string().optional(),
  image: z.string().optional().describe('Preview image URL'),
  siteName: z.string().optional(),
})

function getDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

function getFaviconUrl(url: string): string | null {
  try {
    const host = new URL(url).hostname
    return `https://icons.duckduckgo.com/ip3/${host}.ico`
  } catch {
    return null
  }
}

export const widget = defineGenUIWidget({
  name: 'render_link_preview',
  description:
    'Display a rich preview card for a single web link. Use when linking to an article, page, or resource and you want to surface title, description, and favicon.',
  schema,
  promptHint: 'rich preview card for a single web link',
  render: ({ url, title, description, image, siteName }) => {
    const favicon = getFaviconUrl(url)
    const displayName = siteName || getDomain(url)
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="hover:border-border-primary my-3 flex max-w-2xl overflow-hidden rounded-lg border border-border-subtle bg-surface-card transition-colors hover:bg-surface-chat-background"
      >
        {image && (
          <ImageWithSkeleton
            src={image}
            alt=""
            wrapperClassName="relative h-32 w-32 shrink-0 overflow-hidden bg-surface-card sm:h-40 sm:w-40"
            className="h-full w-full object-cover"
            loading="lazy"
          />
        )}
        <div className="flex min-w-0 flex-1 flex-col justify-between gap-1 p-4">
          <div>
            <div className="mb-1 flex items-center gap-2">
              {favicon && (
                <ImageWithSkeleton
                  src={favicon}
                  alt=""
                  wrapperClassName="relative h-4 w-4 shrink-0 overflow-hidden rounded bg-surface-card"
                  className="h-4 w-4 object-cover"
                  loading="lazy"
                />
              )}
              <span className="truncate text-xs text-content-muted">
                {displayName}
              </span>
            </div>
            <p className="line-clamp-2 text-sm font-semibold text-content-primary">
              {title}
            </p>
            {description && (
              <p className="mt-1 line-clamp-2 text-xs text-content-muted">
                {description}
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
  },
})
