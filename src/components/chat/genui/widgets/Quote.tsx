import { sanitizeUrl } from '@braintree/sanitize-url'
import { ExternalLink } from 'lucide-react'
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
})

export const widget = defineGenUIWidget({
  name: 'render_quote',
  description:
    'Display a pull-quote with optional attribution. Use when surfacing a direct quote, testimonial, or notable statement.',
  schema,
  promptHint: 'a pull-quote with attribution',
  render: ({ text, author, role, source, sourceUrl, publishedAt }) => {
    const hasAttribution = Boolean(author || role || source || publishedAt)
    return (
      <figure className="my-3 max-w-2xl border-l-2 border-border-subtle pl-4">
        <blockquote className="whitespace-pre-wrap font-serif text-base italic leading-relaxed text-content-primary">
          &ldquo;{text}&rdquo;
        </blockquote>
        {hasAttribution && (
          <figcaption className="mt-2 flex flex-wrap items-center gap-x-2 text-sm text-content-muted">
            <span aria-hidden>&mdash;</span>
            {author && <span className="text-content-primary">{author}</span>}
            {role && (
              <>
                {author && <span>·</span>}
                <span>{role}</span>
              </>
            )}
            {source && !sourceUrl && (
              <>
                {(author || role) && <span>·</span>}
                <span>{source}</span>
              </>
            )}
            {source && sourceUrl && (
              <>
                {(author || role) && <span>·</span>}
                <a
                  href={sanitizeUrl(sourceUrl)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 underline decoration-dotted underline-offset-2 hover:text-content-primary"
                >
                  {source}
                  <ExternalLink className="h-3 w-3" />
                </a>
              </>
            )}
            {publishedAt && (
              <>
                {(author || role || source) && <span>·</span>}
                <span>{publishedAt}</span>
              </>
            )}
          </figcaption>
        )}
      </figure>
    )
  },
})
