import { Card } from '@/components/ui/card'
import { ExternalLink, Quote as QuoteIcon } from 'lucide-react'
import { z } from 'zod'
import { defineGenUIWidget } from '../types'

const schema = z.object({
  text: z.string().min(1).describe('The quoted text'),
  author: z.string().optional(),
  role: z
    .string()
    .optional()
    .describe('The author\'s role or title, e.g. "CEO, Acme"'),
  source: z
    .string()
    .optional()
    .describe('Where the quote was published, e.g. "The New York Times"'),
  sourceUrl: z.string().optional(),
  publishedAt: z.string().optional(),
  avatarUrl: z.string().optional(),
})

export const widget = defineGenUIWidget({
  name: 'render_quote',
  description:
    'Display a pull-quote with optional attribution. Use when surfacing a direct quote, testimonial, or notable statement.',
  schema,
  promptHint: 'a pull-quote with attribution',
  render: ({
    text,
    author,
    role,
    source,
    sourceUrl,
    publishedAt,
    avatarUrl,
  }) => {
    const hasAttribution = Boolean(
      author || role || source || publishedAt || avatarUrl,
    )
    return (
      <Card className="my-3 max-w-2xl overflow-hidden border-l-4 border-l-content-primary/50">
        <figure className="flex flex-col gap-4 p-5">
          <div className="flex items-start gap-3">
            <QuoteIcon
              className="mt-1 h-5 w-5 flex-shrink-0 text-content-muted"
              aria-hidden="true"
            />
            <blockquote className="whitespace-pre-wrap text-base font-medium leading-relaxed text-content-primary">
              {text}
            </blockquote>
          </div>

          {hasAttribution && (
            <figcaption className="flex flex-wrap items-center gap-3 border-t border-border-subtle pt-3 text-sm">
              {avatarUrl && (
                <img
                  src={avatarUrl}
                  alt=""
                  className="h-9 w-9 rounded-full object-cover"
                  loading="lazy"
                  referrerPolicy="no-referrer"
                />
              )}
              <div className="flex min-w-0 flex-1 flex-col">
                {author && (
                  <span className="font-medium text-content-primary">
                    {author}
                  </span>
                )}
                {(role || source || publishedAt) && (
                  <span className="flex flex-wrap items-center gap-x-2 text-xs text-content-muted">
                    {role && <span>{role}</span>}
                    {role && (source || publishedAt) && <span>·</span>}
                    {source && !sourceUrl && <span>{source}</span>}
                    {source && sourceUrl && (
                      <a
                        href={sourceUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 underline decoration-dotted underline-offset-2 hover:text-content-primary"
                      >
                        {source}
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                    {(source || role) && publishedAt && <span>·</span>}
                    {publishedAt && <span>{publishedAt}</span>}
                  </span>
                )}
              </div>
            </figcaption>
          )}
        </figure>
      </Card>
    )
  },
})
