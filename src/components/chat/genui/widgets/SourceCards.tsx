import { ImageWithSkeleton } from '@/components/preview/image-with-skeleton'
import { z } from 'zod'
import { defineGenUIWidget } from '../types'

const schema = z.object({
  sources: z
    .array(
      z.object({
        title: z.string(),
        url: z.string(),
        snippet: z.string().optional(),
        publishedAt: z.string().optional(),
        author: z.string().optional(),
        image: z.string().optional(),
      }),
    )
    .min(1)
    .describe('Reference sources to surface as a grid of cards'),
  title: z.string().optional(),
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
  name: 'render_source_cards',
  description:
    'Display multiple source references as a grid of cards. Use when presenting research citations, search results, or reference reading lists.',
  schema,
  promptHint: 'a grid of reference source cards',
  render: ({ sources, title }) => (
    <div className="my-3">
      {title && (
        <p className="mb-2 text-sm font-medium text-content-primary">{title}</p>
      )}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {sources.map((src, i) => {
          const favicon = getFaviconUrl(src.url)
          const domain = getDomain(src.url)
          return (
            <a
              key={i}
              href={src.url}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:border-border-primary group flex flex-col gap-2 overflow-hidden rounded-lg border border-border-subtle bg-surface-card transition-colors hover:bg-surface-chat-background"
            >
              {src.image && (
                <ImageWithSkeleton
                  src={src.image}
                  alt=""
                  wrapperClassName="relative aspect-[16/9] w-full overflow-hidden bg-surface-card"
                  className="h-full w-full object-cover"
                  loading="lazy"
                />
              )}
              <div className="flex flex-col gap-2 p-3">
                <div className="flex items-center gap-2">
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
                    {domain}
                  </span>
                </div>
                <p className="line-clamp-2 text-sm font-medium text-content-primary group-hover:underline">
                  {src.title}
                </p>
                {src.snippet && (
                  <p className="line-clamp-3 text-xs text-content-muted">
                    {src.snippet}
                  </p>
                )}
                {(src.publishedAt || src.author) && (
                  <div className="mt-auto flex items-center gap-2 text-xs text-content-muted">
                    {src.author && (
                      <span className="truncate">{src.author}</span>
                    )}
                    {src.author && src.publishedAt && <span>·</span>}
                    {src.publishedAt && <span>{src.publishedAt}</span>}
                  </div>
                )}
              </div>
            </a>
          )
        })}
      </div>
    </div>
  ),
})
